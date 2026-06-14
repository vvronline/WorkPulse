import { useCallback, useEffect, useRef, useState } from "react";
import { PermissionsAndroid, Platform } from "react-native";
import {
  mediaDevices,
  RTCPeerConnection,
  RTCSessionDescription,
  RTCIceCandidate,
  MediaStream,
} from "react-native-webrtc";
import { socket, type WSMessage } from "../realtime/socket";
import { getIceConfig } from "../features";

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * In-app multi-party meeting mesh (mirrors the web client's
 * client/src/pages/meeting/useMeetingState.ts and the server WebRTC mesh relay
 * in server/utils/ws.ts). This lets the mobile app join the SAME meeting room
 * as web/desktop instead of bouncing the user out to a browser.
 *
 * Protocol (identical to web + server):
 *   join:    send `meeting_join { meetingId }`
 *            ← server replies `meeting_participant_joined` with `existingPeers[]`
 *   newcomer creates a NON-initiator PC for each existing peer (awaits offer).
 *   existing peers receive `meeting_participant_joined` for the newcomer and
 *   create an INITIATOR PC (send offer). This glare-free rule (existing peers
 *   always initiate toward the newcomer) matches the web client exactly.
 *   signal:  `meeting_signal { meetingId, targetUserId, signal:{type, sdp|candidate} }`
 *            ← server echoes `meeting_signal { fromUserId, signal }`
 *   state:   `meeting_track_state { meetingId, muted, videoOff, screenSharing }`
 *   lifecycle: `meeting_participant_left`, `meeting_ended`, `meeting_leave`
 */

const FALLBACK_ICE: any[] = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
  { urls: "stun:stun2.l.google.com:19302" },
  {
    urls: "turn:openrelay.metered.ca:80",
    username: "openrelayproject",
    credential: "openrelayproject",
  },
  {
    urls: "turn:openrelay.metered.ca:443",
    username: "openrelayproject",
    credential: "openrelayproject",
  },
  {
    urls: "turn:openrelay.metered.ca:443?transport=tcp",
    username: "openrelayproject",
    credential: "openrelayproject",
  },
];

export type MeetingParticipant = {
  userId: number | string;
  name: string;
  avatar?: string | null;
  stream: MediaStream | null;
  muted: boolean;
  videoOff: boolean;
};

export type MeetingStatus =
  | "lobby"
  | "joining"
  | "connecting"
  | "connected"
  | "ended";

interface UseMeetingMeshArgs {
  meetingId: number | string | null;
  selfId: number | string | null;
  initialMuted?: boolean;
  initialVideoOff?: boolean;
  /**
   * When false (default) the hook acquires local media for a live preview but
   * does NOT send `meeting_join` until `join()` is called — this powers the
   * pre-join lobby (camera/mic preview + device toggles). When true it joins
   * immediately on mount (legacy auto-join behaviour).
   */
  autoJoin?: boolean;
}

interface PeerEntry {
  pc: RTCPeerConnection;
  remoteStream: MediaStream;
}

export function useMeetingMesh({
  meetingId,
  selfId,
  initialMuted = false,
  initialVideoOff = false,
  autoJoin = false,
}: UseMeetingMeshArgs) {
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [muted, setMuted] = useState(initialMuted);
  const [videoOff, setVideoOff] = useState(initialVideoOff);
  const [participants, setParticipants] = useState<
    Map<number | string, MeetingParticipant>
  >(new Map());
  // Start in "lobby" unless the caller opts into legacy auto-join. The lobby
  // shows a live self-preview + mic/cam/flip controls before `join()` fires the
  // actual `meeting_join`.
  const [status, setStatus] = useState<MeetingStatus>(
    autoJoin ? "joining" : "lobby",
  );
  const [mediaError, setMediaError] = useState<string | null>(null);

  const localStreamRef = useRef<MediaStream | null>(null);
  const peersRef = useRef<Map<number | string, PeerEntry>>(new Map());
  const pendingIceRef = useRef<Map<number | string, any[]>>(new Map());
  const iceServersRef = useRef<any[]>(FALLBACK_ICE);
  const iceLoadedRef = useRef(false);
  const joinedRef = useRef(false);
  // True once the user has left the lobby and we should fire `meeting_join`.
  const wantJoinRef = useRef(autoJoin);
  const [wantJoin, setWantJoin] = useState(autoJoin);
  const mutedRef = useRef(initialMuted);
  const videoOffRef = useRef(initialVideoOff);
  const meetingIdRef = useRef(meetingId);
  meetingIdRef.current = meetingId;
  mutedRef.current = muted;
  videoOffRef.current = videoOff;

  // ── Android runtime permissions ──────────────────────────────────────────
  const ensurePermissions = useCallback(async (): Promise<boolean> => {
    if (Platform.OS !== "android") return true;
    try {
      const perms = [
        PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
        PermissionsAndroid.PERMISSIONS.CAMERA,
      ];
      const result = await PermissionsAndroid.requestMultiple(perms);
      return perms.every(
        (p) =>
          (result as Record<string, string>)[p] ===
          PermissionsAndroid.RESULTS.GRANTED,
      );
    } catch {
      return true;
    }
  }, []);

  // ── Acquire local media with progressive constraint fallback ─────────────
  const getMedia = useCallback(async (): Promise<MediaStream | null> => {
    if (localStreamRef.current) return localStreamRef.current;
    const permitted = await ensurePermissions();
    if (!permitted) {
      setMediaError(
        "Camera and microphone access are required to join the meeting.",
      );
      return null;
    }
    const audio: any = {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    };
    const profiles: any[] = [
      {
        audio,
        video: {
          facingMode: "user",
          width: { ideal: 640 },
          height: { ideal: 480 },
          frameRate: { ideal: 24, max: 30 },
        },
      },
      { audio, video: true },
      { audio, video: false },
    ];
    for (const constraints of profiles) {
      try {
        const stream = (await mediaDevices.getUserMedia(
          constraints,
        )) as MediaStream;
        // Apply initial mute/video state.
        stream.getAudioTracks().forEach((t) => {
          t.enabled = !mutedRef.current;
        });
        stream.getVideoTracks().forEach((t) => {
          t.enabled = !videoOffRef.current;
        });
        if (stream.getVideoTracks().length === 0) {
          setVideoOff(true);
          videoOffRef.current = true;
        }
        localStreamRef.current = stream;
        setLocalStream(stream);
        return stream;
      } catch {
        /* try next, more relaxed profile */
      }
    }
    setMediaError("Could not access the camera/microphone.");
    return null;
  }, [ensurePermissions]);

  const waitForIceConfig = useCallback(async (timeoutMs = 2000) => {
    if (iceLoadedRef.current) return;
    const start = Date.now();
    while (!iceLoadedRef.current && Date.now() - start < timeoutMs) {
      await new Promise((r) => setTimeout(r, 50));
    }
  }, []);

  // Attach local tracks to a peer connection AFTER setRemoteDescription on the
  // answerer so they bind to the transceivers the offer created. Mirrors the
  // proven 1:1 call screen's `attachLocalTracks`.
  //
  // CRITICAL: on react-native-webrtc, calling addTrack() after
  // setRemoteDescription(offer) frequently creates a NEW, unmatched m-line
  // instead of reusing the recvonly transceiver the offer created. The answer
  // SDP then no longer lines up with the offer → ICE never settles and the
  // meeting hangs on "Connecting…" forever (the exact mobile↔web/desktop
  // "never connects" bug). We instead find the offer's matching transceiver by
  // kind and replaceTrack onto it (upgrading direction to sendrecv), only
  // falling back to addTrack when there is no matching transceiver.
  const attachLocalTracks = useCallback(
    async (pc: RTCPeerConnection, stream: MediaStream | null) => {
      if (!pc || !stream) return;
      const transceivers =
        typeof (pc as any).getTransceivers === "function"
          ? (pc as any).getTransceivers()
          : [];
      const used = new Set<any>();

      for (const track of stream.getTracks()) {
        const alreadyAttached = transceivers.some(
          (t: any) => t.sender?.track && t.sender.track.id === track.id,
        );
        if (alreadyAttached) continue;

        const matchingTr = transceivers.find((t: any) => {
          if (used.has(t)) return false;
          if (t.sender?.track) return false;
          const trKind = t.receiver?.track?.kind;
          return trKind === track.kind;
        });

        if (matchingTr) {
          used.add(matchingTr);
          try {
            await matchingTr.sender.replaceTrack(track);
            try {
              matchingTr.direction = "sendrecv";
            } catch {
              /* not always settable */
            }
          } catch {
            try {
              pc.addTrack(track, stream);
            } catch {
              /* ignore */
            }
          }
        } else {
          try {
            pc.addTrack(track, stream);
          } catch {
            /* ignore */
          }
        }
      }
    },
    [],
  );

  const upsertParticipant = useCallback(
    (
      userId: number | string,
      patch: Partial<MeetingParticipant> & { name?: string },
    ) => {
      setParticipants((prev) => {
        const next = new Map(prev);
        const existing = next.get(userId) || {
          userId,
          name: "Participant",
          avatar: null,
          stream: null,
          muted: false,
          videoOff: false,
        };
        next.set(userId, { ...existing, ...patch });
        return next;
      });
    },
    [],
  );

  // ── Create / reuse a peer connection toward `remoteUserId` ───────────────
  const createPeer = useCallback(
    (remoteUserId: number | string, isInitiator: boolean): PeerEntry => {
      const existing = peersRef.current.get(remoteUserId);
      if (
        existing &&
        (existing.pc as any).connectionState !== "closed" &&
        (existing.pc as any).connectionState !== "failed"
      ) {
        return existing;
      }
      if (existing) {
        try {
          existing.pc.close();
        } catch {
          /* ignore */
        }
        peersRef.current.delete(remoteUserId);
      }

      const pc = new RTCPeerConnection({
        iceServers: iceServersRef.current,
        bundlePolicy: "max-bundle",
        rtcpMuxPolicy: "require",
        iceCandidatePoolSize: 4,
      } as any);

      const remoteStream = new MediaStream();
      const entry: PeerEntry = { pc, remoteStream };
      peersRef.current.set(remoteUserId, entry);

      // Only the INITIATOR (offerer) adds tracks up-front — createOffer then
      // advertises sendrecv media. The NON-initiator (answerer) must NOT
      // addTrack here: on react-native-webrtc adding tracks before
      // setRemoteDescription(offer) creates unmatched m-lines and the
      // connection never settles. The answerer attaches its tracks via
      // attachLocalTracks() AFTER setRemoteDescription (see handleSignal).
      if (isInitiator && localStreamRef.current) {
        localStreamRef.current.getTracks().forEach((track) => {
          try {
            pc.addTrack(track, localStreamRef.current as MediaStream);
          } catch {
            /* ignore */
          }
        });
      }

      (pc as any).onicecandidate = (e: any) => {
        if (e.candidate) {
          socket.send("meeting_signal", {
            meetingId: meetingIdRef.current,
            targetUserId: remoteUserId,
            signal: { type: "candidate", candidate: e.candidate.toJSON() },
          });
        }
      };

      (pc as any).ontrack = (e: any) => {
        const track = e.track;
        if (
          track &&
          !remoteStream.getTracks().some((t) => t.id === track.id)
        ) {
          try {
            remoteStream.addTrack(track);
          } catch {
            /* ignore */
          }
        }
        upsertParticipant(remoteUserId, { stream: remoteStream });
      };

      (pc as any).onconnectionstatechange = () => {
        const st = (pc as any).connectionState;
        if (st === "connected") {
          setStatus("connected");
          // Re-broadcast our current track state so the new peer renders us
          // correctly from the start.
          socket.send("meeting_track_state", {
            meetingId: meetingIdRef.current,
            muted: mutedRef.current,
            videoOff: videoOffRef.current,
            screenSharing: false,
          });
        } else if (st === "failed" || st === "closed") {
          // Drop the peer's media; a participant_left or rejoin will rebuild.
          upsertParticipant(remoteUserId, { stream: null });
        }
      };

      if (isInitiator) {
        (async () => {
          try {
            const offer = await pc.createOffer({
              offerToReceiveAudio: true,
              offerToReceiveVideo: true,
            } as any);
            await pc.setLocalDescription(offer);
            socket.send("meeting_signal", {
              meetingId: meetingIdRef.current,
              targetUserId: remoteUserId,
              signal: { type: "offer", sdp: (pc as any).localDescription },
            });
          } catch {
            /* ignore — connection-state handler will surface failures */
          }
        })();
      }

      return entry;
    },
    [upsertParticipant],
  );

  const flushPendingIce = useCallback(
    async (userId: number | string, pc: RTCPeerConnection) => {
      const list = pendingIceRef.current.get(userId);
      if (!list || !(pc as any).remoteDescription) return;
      pendingIceRef.current.delete(userId);
      for (const c of list) {
        try {
          await pc.addIceCandidate(new RTCIceCandidate(c));
        } catch {
          /* ignore */
        }
      }
    },
    [],
  );

  const handleSignal = useCallback(
    async (
      fromUserId: number | string,
      pc: RTCPeerConnection,
      signal: any,
    ) => {
      if (signal.type === "offer") {
        await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
        // Attach our local tracks AFTER setRemoteDescription so they bind to
        // the offer's transceivers (replaceTrack) rather than creating new
        // unmatched m-lines — the key fix that lets mobile↔web/desktop connect.
        await attachLocalTracks(pc, localStreamRef.current);
        await flushPendingIce(fromUserId, pc);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socket.send("meeting_signal", {
          meetingId: meetingIdRef.current,
          targetUserId: fromUserId,
          signal: { type: "answer", sdp: (pc as any).localDescription },
        });
      } else if (signal.type === "answer") {
        if ((pc as any).signalingState === "have-local-offer") {
          await pc.setRemoteDescription(
            new RTCSessionDescription(signal.sdp),
          );
          await flushPendingIce(fromUserId, pc);
        }
      } else if (signal.type === "candidate") {
        if (signal.candidate == null) return;
        if ((pc as any).remoteDescription) {
          try {
            await pc.addIceCandidate(new RTCIceCandidate(signal.candidate));
          } catch {
            /* ignore */
          }
        } else {
          const q = pendingIceRef.current.get(fromUserId) || [];
          q.push(signal.candidate);
          pendingIceRef.current.set(fromUserId, q);
        }
      }
    },
    [flushPendingIce, attachLocalTracks],
  );

  // ── WS message handling ──────────────────────────────────────────────────
  const handleWsMessage = useCallback(
    (msg: WSMessage) => {
      const { type } = msg;
      const data: any = msg.data;
      if (!data) return;

      switch (type) {
        case "meeting_participant_joined": {
          // The joiner gets `existingPeers` — create NON-initiator PCs (await
          // their offers). Existing members get a single `userId` (the new
          // joiner) — create an INITIATOR PC (send offer).
          let hasPeersToConnect = false;
          if (Array.isArray(data.existingPeers)) {
            data.existingPeers.forEach((peer: any) => {
              if (!peer?.userId || peer.userId === selfId) return;
              hasPeersToConnect = true;
              upsertParticipant(peer.userId, {
                name: peer.fullName || peer.username || "Participant",
                avatar: peer.avatar || null,
              });
              createPeer(peer.userId, false);
            });
          }
          if (data.userId && data.userId !== selfId) {
            hasPeersToConnect = true;
            upsertParticipant(data.userId, {
              name: data.fullName || data.username || "Participant",
              avatar: data.avatar || null,
            });
            if (!data.existingPeers) {
              createPeer(data.userId, true);
              socket.send("meeting_track_state", {
                meetingId: meetingIdRef.current,
                muted: mutedRef.current,
                videoOff: videoOffRef.current,
                screenSharing: false,
              });
            }
          }
          // Mirror the web client: when there are NO remote peers to connect to
          // (e.g. you just STARTED the meeting and are the only participant, so
          // the server echoes an empty `existingPeers: []`), flip straight to
          // "connected" so the starter lands in the room instead of being stuck
          // on "Connecting…" forever. With real peers we stay "connecting"
          // until a peer connection reaches the connected state.
          setStatus((prev) =>
            hasPeersToConnect
              ? prev === "connected"
                ? prev
                : "connecting"
              : "connected",
          );
          break;
        }
        case "meeting_signal": {
          const fromUserId = data.fromUserId;
          const signal = data.signal;
          if (fromUserId == null || !signal) break;
          let entry = peersRef.current.get(fromUserId);
          if (!entry) {
            entry = createPeer(fromUserId, false);
          }
          handleSignal(fromUserId, entry.pc, signal).catch(() => {});
          break;
        }
        case "meeting_track_state": {
          const { userId, muted: m, videoOff: v } = data;
          if (userId == null || userId === selfId) break;
          upsertParticipant(userId, {
            ...(m != null ? { muted: m } : {}),
            ...(v != null ? { videoOff: v } : {}),
          });
          break;
        }
        case "meeting_participant_left": {
          const { userId } = data;
          if (userId == null) break;
          const entry = peersRef.current.get(userId);
          if (entry) {
            try {
              entry.pc.close();
            } catch {
              /* ignore */
            }
            peersRef.current.delete(userId);
          }
          setParticipants((prev) => {
            const next = new Map(prev);
            next.delete(userId);
            return next;
          });
          break;
        }
        case "meeting_ended": {
          setStatus("ended");
          break;
        }
        default:
          break;
      }
    },
    [selfId, createPeer, handleSignal, upsertParticipant],
  );

  // ── Load ICE config up front ─────────────────────────────────────────────
  useEffect(() => {
    getIceConfig()
      .then((r) => {
        const servers = (r.data as any)?.iceServers;
        if (servers?.length) iceServersRef.current = servers;
      })
      .catch(() => {})
      .finally(() => {
        iceLoadedRef.current = true;
      });
  }, []);

  // ── Acquire media on mount for the lobby preview (does NOT join) ──────────
  useEffect(() => {
    if (!meetingId) return;
    let cancelled = false;
    (async () => {
      await getMedia();
      if (cancelled) return;
      await waitForIceConfig();
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meetingId]);

  // ── Subscribe to WS + join (only once the user leaves the lobby) ──────────
  useEffect(() => {
    if (!meetingId || !wantJoin) return;
    let cancelled = false;
    const off = socket.subscribe(handleWsMessage);

    const sendJoin = () => {
      if (joinedRef.current) return;
      const ok = socket.send("meeting_join", { meetingId });
      if (ok) {
        joinedRef.current = true;
        setTimeout(() => {
          socket.send("meeting_track_state", {
            meetingId,
            muted: mutedRef.current,
            videoOff: videoOffRef.current,
            screenSharing: false,
          });
        }, 300);
      }
    };

    (async () => {
      // Media + ICE were warmed up in the lobby; ensure they're ready anyway.
      await getMedia();
      if (cancelled) return;
      await waitForIceConfig();
      if (cancelled) return;
      // Retry the join until the WS is open (mirrors web client's retry loop).
      const deadline = Date.now() + 8000;
      sendJoin();
      while (!joinedRef.current && !cancelled && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 300));
        sendJoin();
      }
    })();

    return () => {
      cancelled = true;
      off();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meetingId, wantJoin]);

  // ── Leave the lobby and start the actual join flow ───────────────────────
  const join = useCallback(() => {
    if (wantJoinRef.current) return;
    wantJoinRef.current = true;
    setWantJoin(true);
    setStatus("joining");
  }, []);

  // ── Leave + teardown on unmount ──────────────────────────────────────────
  const leave = useCallback(() => {
    if (joinedRef.current && meetingIdRef.current) {
      socket.send("meeting_leave", { meetingId: meetingIdRef.current });
    }
    joinedRef.current = false;
    try {
      localStreamRef.current?.getTracks().forEach((t) => t.stop());
    } catch {
      /* ignore */
    }
    localStreamRef.current = null;
    peersRef.current.forEach((entry) => {
      try {
        entry.pc.close();
      } catch {
        /* ignore */
      }
    });
    peersRef.current.clear();
    pendingIceRef.current.clear();
  }, []);

  useEffect(() => {
    return () => {
      leave();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Local controls ───────────────────────────────────────────────────────
  const toggleMute = useCallback(() => {
    const next = !mutedRef.current;
    setMuted(next);
    mutedRef.current = next;
    localStreamRef.current?.getAudioTracks().forEach((t) => {
      t.enabled = !next;
    });
    socket.send("meeting_track_state", {
      meetingId: meetingIdRef.current,
      muted: next,
      videoOff: videoOffRef.current,
      screenSharing: false,
    });
  }, []);

  const toggleVideo = useCallback(() => {
    const next = !videoOffRef.current;
    setVideoOff(next);
    videoOffRef.current = next;
    localStreamRef.current?.getVideoTracks().forEach((t) => {
      t.enabled = !next;
    });
    socket.send("meeting_track_state", {
      meetingId: meetingIdRef.current,
      muted: mutedRef.current,
      videoOff: next,
      screenSharing: false,
    });
  }, []);

  const switchCamera = useCallback(() => {
    localStreamRef.current?.getVideoTracks().forEach((t) => {
      (t as any)._switchCamera?.();
    });
  }, []);

  return {
    localStream,
    participants,
    muted,
    videoOff,
    status,
    mediaError,
    toggleMute,
    toggleVideo,
    switchCamera,
    join,
    leave,
  };
}

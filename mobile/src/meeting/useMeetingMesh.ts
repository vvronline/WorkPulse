import { useCallback, useEffect, useRef, useState } from "react";
import { PermissionsAndroid, Platform } from "react-native";
import { setAudioModeAsync } from "expo-audio";
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
  // Recovery bookkeeping (mirrors the proven 1:1 call screen).
  iceRestartAttempted?: boolean;
  negotiationDone?: boolean;
  disconnectTimer?: ReturnType<typeof setTimeout> | null;
  rampTimers?: ReturnType<typeof setTimeout>[];
}

// Normalize ids so a participant arriving as a number on one path and a numeric
// string on another can never key the map twice (the "2 people show as 3" bug).
function normId(id: number | string | null | undefined): string {
  return id == null ? "" : String(id);
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
  // Front camera → mirror the self-view; rear camera → do NOT mirror (otherwise
  // the rear feed renders left-right flipped after the user taps "Flip").
  const [usingFrontCamera, setUsingFrontCamera] = useState(true);
  const [participants, setParticipants] = useState<
    Map<string, MeetingParticipant>
  >(new Map());
  // Start in "lobby" unless the caller opts into legacy auto-join. The lobby
  // shows a live self-preview + mic/cam/flip controls before `join()` fires the
  // actual `meeting_join`.
  const [status, setStatus] = useState<MeetingStatus>(
    autoJoin ? "joining" : "lobby",
  );
  const [mediaError, setMediaError] = useState<string | null>(null);

  const localStreamRef = useRef<MediaStream | null>(null);
  const peersRef = useRef<Map<string, PeerEntry>>(new Map());
  const pendingIceRef = useRef<Map<string, any[]>>(new Map());
  const iceServersRef = useRef<any[]>(FALLBACK_ICE);
  const iceLoadedRef = useRef(false);
  const joinedRef = useRef(false);
  // True once the user has left the lobby and we should fire `meeting_join`.
  const wantJoinRef = useRef(autoJoin);
  const [wantJoin, setWantJoin] = useState(autoJoin);
  const mutedRef = useRef(initialMuted);
  const videoOffRef = useRef(initialVideoOff);
  const meetingIdRef = useRef(meetingId);
  const selfIdRef = useRef(selfId);
  meetingIdRef.current = meetingId;
  selfIdRef.current = selfId;
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
    // VOICE-CALL / AUDIO-ONLY PATH: when joining with video OFF (a voice
    // huddle, or a device whose camera is disabled by device policy/MDM —
    // logcat: "Camera device could not be opened due to a device policy"),
    // do NOT request the camera at all. Requesting video then would (a)
    // needlessly light the camera for a voice call and (b) stall/fail on a
    // policy-blocked device. We go straight to an audio-only constraint so the
    // join is fast and reliable.
    const profiles: any[] = videoOffRef.current
      ? [{ audio, video: false }]
      : [
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
          // Final fallback: audio-only (covers camera-policy-blocked devices so
          // the user can still join the call with their mic).
          { audio, video: false },
        ];
    for (const constraints of profiles) {
      try {
        const stream = (await mediaDevices.getUserMedia(
          constraints,
        )) as MediaStream;
        if (stream.getAudioTracks().length === 0) {
          try {
            const audioOnly = (await mediaDevices.getUserMedia({
              audio: true,
              video: false,
            })) as MediaStream;
            const track = audioOnly.getAudioTracks()[0];
            if (track) stream.addTrack(track);
          } catch {
            /* handled by fallback profiles / mediaError */
          }
        }
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

  useEffect(() => {
    setAudioModeAsync({
      playsInSilentMode: true,
      allowsRecording: true,
      shouldPlayInBackground: false,
      interruptionMode: "doNotMix",
      shouldRouteThroughEarpiece: false,
    }).catch(() => {});
    return () => {
      setAudioModeAsync({
        playsInSilentMode: true,
        allowsRecording: false,
        shouldPlayInBackground: false,
        interruptionMode: "doNotMix",
        shouldRouteThroughEarpiece: false,
      }).catch(() => {});
    };
  }, []);

  const waitForIceConfig = useCallback(async (timeoutMs = 2000) => {
    if (iceLoadedRef.current) return;
    const start = Date.now();
    while (!iceLoadedRef.current && Date.now() - start < timeoutMs) {
      await new Promise((r) => setTimeout(r, 50));
    }
  }, []);

  // ── Bitrate management (ported from web mesh + 1:1 call screen) ──────────
  // Uncapped video on a mobile uplink causes congestion → stalls, freezes and
  // lag (the "very unstable and laggy" report). We cap by peer count and ramp
  // up gently once connected so the link establishes fast then improves.
  const setVideoBitrate = useCallback(
    (pc: RTCPeerConnection, bitrate: number) => {
      try {
        const senders =
          typeof (pc as any).getSenders === "function"
            ? (pc as any).getSenders()
            : [];
        for (const sender of senders) {
          if (!sender?.track) continue;
          const params = sender.getParameters?.();
          if (!params) continue;
          if (!params.encodings || params.encodings.length === 0) {
            params.encodings = [{}];
          }
          if (sender.track.kind === "video") {
            params.encodings[0].maxBitrate = bitrate;
            params.encodings[0].maxFramerate = 30;
            (params as any).degradationPreference = "maintain-framerate";
          } else {
            params.encodings[0].maxBitrate = 48_000;
          }
          sender.setParameters?.(params).catch?.(() => {});
        }
      } catch {
        /* setParameters not critical */
      }
    },
    [],
  );

  const targetBitrateForPeerCount = useCallback((): number => {
    const peerCount = peersRef.current.size;
    return peerCount <= 1 ? 800_000 : peerCount <= 3 ? 500_000 : 350_000;
  }, []);

  const applyBitrateRampUp = useCallback(
    (entry: PeerEntry) => {
      const pc = entry.pc;
      const INITIAL = 300_000;
      const TARGET = targetBitrateForPeerCount();
      const STEPS = 3;
      const STEP_MS = 1000;
      entry.rampTimers?.forEach((t) => clearTimeout(t));
      entry.rampTimers = [];
      setVideoBitrate(pc, INITIAL);
      for (let step = 1; step <= STEPS; step++) {
        const timer = setTimeout(() => {
          if ((pc as any).connectionState !== "connected") return;
          const bitrate = Math.round(
            INITIAL + ((TARGET - INITIAL) * step) / STEPS,
          );
          setVideoBitrate(pc, bitrate);
        }, STEP_MS * step);
        entry.rampTimers.push(timer);
      }
    },
    [setVideoBitrate, targetBitrateForPeerCount],
  );

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
      rawUserId: number | string,
      patch: Partial<MeetingParticipant> & { name?: string },
    ) => {
      const key = normId(rawUserId);
      // Never let our own id leak into the remote-participant map (the self tile
      // is rendered separately). This is the primary guard against the
      // "2 people show as 3" duplicate-tile bug.
      if (!key || key === normId(selfIdRef.current)) return;
      setParticipants((prev) => {
        const next = new Map(prev);
        const existing = next.get(key) || {
          userId: rawUserId,
          name: "Participant",
          avatar: null,
          stream: null,
          muted: false,
          // Default a freshly-seen remote to camera-OFF: we render their avatar
          // until either a live video track arrives or an explicit
          // meeting_track_state{videoOff:false} tells us their camera is on.
          // This stops a black RTCView (no avatar) from showing before the
          // first frame / state signal lands.
          videoOff: true,
        };
        next.set(key, { ...existing, ...patch, userId: rawUserId });
        return next;
      });
    },
    [],
  );

  const removeParticipant = useCallback((rawUserId: number | string) => {
    const key = normId(rawUserId);
    setParticipants((prev) => {
      if (!prev.has(key)) return prev;
      const next = new Map(prev);
      next.delete(key);
      return next;
    });
  }, []);

  const closePeer = useCallback((key: string) => {
    const entry = peersRef.current.get(key);
    if (!entry) return;
    if (entry.disconnectTimer) clearTimeout(entry.disconnectTimer);
    entry.rampTimers?.forEach((t) => clearTimeout(t));
    try {
      entry.pc.close();
    } catch {
      /* ignore */
    }
    peersRef.current.delete(key);
  }, []);

  // ── Create / reuse a peer connection toward `remoteUserId` ───────────────
  const createPeer = useCallback(
    (remoteUserId: number | string, isInitiator: boolean): PeerEntry => {
      const key = normId(remoteUserId);
      const existing = peersRef.current.get(key);
      if (
        existing &&
        (existing.pc as any).connectionState !== "closed" &&
        (existing.pc as any).connectionState !== "failed"
      ) {
        return existing;
      }
      if (existing) {
        closePeer(key);
      }

      const pc = new RTCPeerConnection({
        iceServers: iceServersRef.current,
        bundlePolicy: "max-bundle",
        rtcpMuxPolicy: "require",
        iceCandidatePoolSize: 4,
      } as any);

      const remoteStream = new MediaStream();
      const entry: PeerEntry = {
        pc,
        remoteStream,
        iceRestartAttempted: false,
        negotiationDone: false,
        disconnectTimer: null,
        rampTimers: [],
      };
      peersRef.current.set(key, entry);

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
        // A live video track arrived → the peer's camera is on. Clear videoOff
        // so the tile shows the actual video instead of the avatar. (An
        // explicit meeting_track_state can still flip it back off later.)
        const patch: Partial<MeetingParticipant> = { stream: remoteStream };
        if (track?.kind === "video") patch.videoOff = false;
        upsertParticipant(remoteUserId, patch);
      };

      // Fast proactive ICE restart on a brief mobile/VPN network blip — try to
      // re-establish before the connection escalates to "failed". Mirrors the
      // recovery ladder proven in the 1:1 call screen.
      (pc as any).oniceconnectionstatechange = () => {
        const ice = (pc as any).iceConnectionState;
        if (
          ice === "disconnected" &&
          entry.negotiationDone &&
          !entry.iceRestartAttempted
        ) {
          setTimeout(() => {
            const cur = (pc as any).iceConnectionState;
            if (
              (cur === "disconnected" || cur === "failed") &&
              peersRef.current.get(key) === entry
            ) {
              entry.iceRestartAttempted = true;
              (async () => {
                try {
                  const offer = await pc.createOffer({ iceRestart: true });
                  await pc.setLocalDescription(offer);
                  socket.send("meeting_signal", {
                    meetingId: meetingIdRef.current,
                    targetUserId: remoteUserId,
                    signal: { type: "offer", sdp: (pc as any).localDescription },
                  });
                } catch {
                  /* connection-state handler will surface failures */
                }
              })();
            }
          }, 2000);
        }
      };

      (pc as any).onconnectionstatechange = () => {
        const st = (pc as any).connectionState;
        if (st === "connected") {
          entry.negotiationDone = true;
          entry.iceRestartAttempted = false;
          if (entry.disconnectTimer) {
            clearTimeout(entry.disconnectTimer);
            entry.disconnectTimer = null;
          }
          setStatus("connected");
          // Ramp the video bitrate up now that the link is established.
          applyBitrateRampUp(entry);
          // Re-broadcast our current track state so the new peer renders us
          // correctly from the start.
          socket.send("meeting_track_state", {
            meetingId: meetingIdRef.current,
            muted: mutedRef.current,
            videoOff: videoOffRef.current,
            screenSharing: false,
          });
        } else if (st === "disconnected") {
          // Grace period: a temporary network hiccup is common on mobile.
          if (entry.disconnectTimer) clearTimeout(entry.disconnectTimer);
          entry.disconnectTimer = setTimeout(() => {
            if (
              peersRef.current.get(key) === entry &&
              (pc as any).connectionState !== "connected"
            ) {
              upsertParticipant(remoteUserId, { stream: null });
            }
          }, 8000);
        } else if (st === "failed" || st === "closed") {
          // Drop the peer's media; a participant_left or rejoin will rebuild.
          upsertParticipant(remoteUserId, { stream: null });
        }
      };

      if (isInitiator) {
        (async () => {
          try {
            // IMPORTANT: tracks were already added via addTrack above, so the
            // transceivers are already sendrecv. Calling createOffer() WITHOUT
            // offerToReceive* flags here mirrors the web client exactly. On
            // react-native-webrtc, combining up-front addTrack with
            // offerToReceiveAudio/Video produces duplicate/mismatched m-lines
            // that the web/desktop answerer can't line up → ICE never nominates
            // a pair and the call hangs on "Connecting…". This is THE fix for
            // mobile-started meetings and the mobile→desktop "never connects"
            // direction.
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            socket.send("meeting_signal", {
              meetingId: meetingIdRef.current,
              targetUserId: remoteUserId,
              signal: { type: "offer", sdp: (pc as any).localDescription },
            });
          } catch {
            /* connection-state handler will surface failures */
          }
        })();
      }

      return entry;
    },
    [upsertParticipant, closePeer, applyBitrateRampUp],
  );

  const flushPendingIce = useCallback(
    async (key: string, pc: RTCPeerConnection) => {
      const list = pendingIceRef.current.get(key);
      if (!list || !(pc as any).remoteDescription) return;
      pendingIceRef.current.delete(key);
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
      const key = normId(fromUserId);
      if (signal.type === "offer") {
        await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
        // Attach our local tracks AFTER setRemoteDescription so they bind to
        // the offer's transceivers (replaceTrack) rather than creating new
        // unmatched m-lines — the key fix that lets mobile↔web/desktop connect.
        await attachLocalTracks(pc, localStreamRef.current);
        await flushPendingIce(key, pc);
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
          await flushPendingIce(key, pc);
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
          const q = pendingIceRef.current.get(key) || [];
          q.push(signal.candidate);
          pendingIceRef.current.set(key, q);
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
      const selfKey = normId(selfIdRef.current);

      switch (type) {
        case "meeting_participant_joined": {
          // The joiner gets `existingPeers` — create NON-initiator PCs (await
          // their offers). Existing members get a single `userId` (the new
          // joiner) — create an INITIATOR PC (send offer).
          let hasPeersToConnect = false;
          if (Array.isArray(data.existingPeers)) {
            // existingPeers is the authoritative set of OTHER joined
            // participants at join time. Reconcile our map against it so a
            // stale tile from a previous session can't linger as a phantom
            // extra participant.
            const validKeys = new Set<string>();
            data.existingPeers.forEach((peer: any) => {
              const pk = normId(peer?.userId);
              if (!pk || pk === selfKey) return;
              validKeys.add(pk);
              hasPeersToConnect = true;
              upsertParticipant(peer.userId, {
                name: peer.fullName || peer.username || "Participant",
                avatar: peer.avatar || null,
              });
              createPeer(peer.userId, false);
            });
            // Prune participants/peers not in the authoritative set.
            for (const k of Array.from(peersRef.current.keys())) {
              if (!validKeys.has(k)) closePeer(k);
            }
            setParticipants((prev) => {
              let changed = false;
              const next = new Map(prev);
              for (const k of Array.from(next.keys())) {
                if (!validKeys.has(k)) {
                  next.delete(k);
                  changed = true;
                }
              }
              return changed ? next : prev;
            });
          }
          const joinerKey = normId(data.userId);
          if (joinerKey && joinerKey !== selfKey) {
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
          if (normId(fromUserId) === selfKey) break;
          const key = normId(fromUserId);
          let entry = peersRef.current.get(key);
          if (!entry) {
            entry = createPeer(fromUserId, false);
          }
          handleSignal(fromUserId, entry.pc, signal).catch(() => {});
          break;
        }
        case "meeting_track_state": {
          const { userId, muted: m, videoOff: v } = data;
          if (userId == null || normId(userId) === selfKey) break;
          upsertParticipant(userId, {
            ...(m != null ? { muted: m } : {}),
            ...(v != null ? { videoOff: v } : {}),
          });
          break;
        }
        case "meeting_participant_left": {
          const { userId } = data;
          if (userId == null) break;
          closePeer(normId(userId));
          removeParticipant(userId);
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
    [createPeer, handleSignal, upsertParticipant, closePeer, removeParticipant],
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
    // CRITICAL ORDERING: subscribe to the socket BEFORE sending `meeting_join`
    // so the server's immediate `meeting_participant_joined` echo (which carries
    // our `existingPeers` set) can never arrive before our handler is attached.
    // Missing that echo was the root cause of "the initiator never joins / never
    // sees the others" — the group-call creator auto-joins, but if the join was
    // sent on a not-yet-open socket (the old `socket.send` returned false and the
    // 300ms poll loop could give up), the server never registered them and never
    // told the desktop peers about them.
    const off = socket.subscribe(handleWsMessage);

    (async () => {
      // Media + ICE were warmed up in the lobby; ensure they're ready anyway.
      await getMedia();
      if (cancelled) return;
      await waitForIceConfig();
      if (cancelled) return;

      // DETERMINISTIC JOIN: explicitly wait until the realtime socket is OPEN,
      // then send `meeting_join` with retry/backoff so a slow-opening socket
      // (cold start, reconnect, app-resume) can't drop the creator's join.
      await socket.waitUntilConnected(8000);
      if (cancelled || joinedRef.current) return;
      const ok = await socket.sendWithRetry(
        "meeting_join",
        { meetingId },
        { timeoutMs: 8000, retryEveryMs: 300 },
      );
      if (cancelled) return;
      if (ok) {
        joinedRef.current = true;
        // Announce our initial mic/cam state once joined so peers render the
        // correct muted/video-off badges from the first frame.
        setTimeout(() => {
          socket.send("meeting_track_state", {
            meetingId,
            muted: mutedRef.current,
            videoOff: videoOffRef.current,
            screenSharing: false,
          });
        }, 300);
      } else {
        // Could not reach the server to join — surface an error instead of
        // sitting silently on "Connecting…" with no peers (the "initiator not
        // joined" symptom). The user can retry from the error screen.
        setMediaError(
          "Couldn't connect to the call. Check your connection and try again.",
        );
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
      if (entry.disconnectTimer) clearTimeout(entry.disconnectTimer);
      entry.rampTimers?.forEach((t) => clearTimeout(t));
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
    // Track facing so the self-view only mirrors for the front camera.
    setUsingFrontCamera((v) => !v);
  }, []);

  return {
    localStream,
    participants,
    muted,
    videoOff,
    usingFrontCamera,
    status,
    mediaError,
    toggleMute,
    toggleVideo,
    switchCamera,
    join,
    leave,
  };
}

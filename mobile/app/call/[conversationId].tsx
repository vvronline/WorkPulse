import { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useLocalSearchParams, useRouter, Stack } from "expo-router";
import {
  mediaDevices,
  RTCPeerConnection,
  RTCSessionDescription,
  RTCIceCandidate,
  RTCView,
  MediaStream,
} from "react-native-webrtc";
import {
  Mic,
  MicOff,
  Phone,
  PhoneOff,
  Video as VideoIcon,
  VideoOff,
  SwitchCamera,
  Signal,
} from "lucide-react-native";
import { theme } from "../../src/theme";
import { socket } from "../../src/realtime/socket";
import { getIceConfig } from "../../src/features";

const FALLBACK_ICE = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
  { urls: "stun:stun2.l.google.com:19302" },
  // Multiple TURN transports so the call can still relay when mobile UDP is
  // blocked. The TCP/TLS (443?transport=tcp) entry is the lifeline on
  // restrictive mobile carriers / corporate Wi-Fi where UDP/STUN never works.
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

type CallStatus =
  | "ringing"
  | "connecting"
  | "connected"
  | "ended"
  | "rejected";

/**
 * Native audio/video call screen (react-native-webrtc). Mirrors the web call
 * flow & WebRTC signaling protocol exactly:
 *   caller: call_initiate → call_started(callId) → call_accepted(peer) → offer
 *   callee: call_incoming → call_accept → wait for offer → answer
 *   both:   call_signal {offer|answer|ice-candidate|video-state} ; call_end / call_ended
 *
 * Route params:
 *   conversationId  (required)
 *   mode            "outgoing" | "incoming"
 *   callType        "voice" | "video"
 *   callId          (incoming only — provided by call_incoming)
 *   peerId          (incoming only — the caller's user id)
 *   peerName        display name
 */
export default function CallScreen() {
  const params = useLocalSearchParams<{
    conversationId: string;
    mode?: string;
    callType?: string;
    callId?: string;
    peerId?: string;
    peerName?: string;
  }>();
  const router = useRouter();

  const conversationId = Number(params.conversationId);
  const mode = params.mode === "incoming" ? "incoming" : "outgoing";
  const callType = params.callType === "video" ? "video" : "voice";
  const peerName = params.peerName || "Call";

  const [status, setStatus] = useState<CallStatus>("ringing");
  const [muted, setMuted] = useState(false);
  const [videoOff, setVideoOff] = useState(callType !== "video");
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  // Peer's camera state — when true we render the avatar instead of a frozen
  // last frame. Track onmute/onended are unreliable on Android, so the
  // explicit `video-state` signal is the source of truth (mirrors web).
  const [remoteVideoOff, setRemoteVideoOff] = useState(false);
  // Peer mute indicator (driven by the explicit `audio-state` signal, mirrors
  // web's peerMuted + remoteMuteBadge).
  const [peerMuted, setPeerMuted] = useState(false);
  // Call duration (seconds) shown once connected, like the web overlay.
  const [duration, setDuration] = useState(0);
  // Connection quality derived from getStats() — good | fair | poor | unknown.
  // Mirrors the web CallOverlay NetworkStats badge.
  const [connectionQuality, setConnectionQuality] =
    useState<"good" | "fair" | "poor" | "unknown">("unknown");

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const remoteStreamRef = useRef<MediaStream | null>(null);
  const callIdRef = useRef<number | null>(
    params.callId ? Number(params.callId) : null,
  );
  const peerIdRef = useRef<number | null>(
    params.peerId ? Number(params.peerId) : null,
  );
  const iceServersRef = useRef<any[]>(FALLBACK_ICE);
  const iceConfigLoadedRef = useRef(false);
  const pendingIce = useRef<any[]>([]);
  const startedAt = useRef<number>(0);
  // Recovery state — mirrors the proven web client. relayOnly forces TURN-only
  // after a UDP/STUN ICE failure; the timers/flags coordinate ICE-restart and
  // a connection-timeout safety net so calls recover instead of dropping.
  const relayOnlyRef = useRef(false);
  const iceRestartAttemptedRef = useRef(false);
  const negotiationDoneRef = useRef(false);
  const disconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const connectionTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const createPCRef = useRef<
    | ((
        stream: MediaStream | null,
        targetUserId: number,
        addTracksNow?: boolean,
      ) => RTCPeerConnection)
    | null
  >(null);

  const endAndLeave = useCallback(
    (sendEnd: boolean) => {
      if (sendEnd && callIdRef.current) {
        socket.send("call_end", {
          callId: callIdRef.current,
          conversationId,
        });
      }
      try {
        localStreamRef.current?.getTracks().forEach((t) => t.stop());
      } catch {
        /* ignore */
      }
      try {
        pcRef.current?.close();
      } catch {
        /* ignore */
      }
      pcRef.current = null;
      localStreamRef.current = null;
      remoteStreamRef.current = null;
      router.back();
    },
    [conversationId, router],
  );

  const getMedia = useCallback(async (): Promise<MediaStream | null> => {
    try {
      // Mirror the web CallOverlay constraints: enable the audio DSP chain
      // (echo cancellation / noise suppression / auto-gain) and cap the video
      // at 1280×720 @30fps. A bounded, sane resolution negotiates faster and
      // is far more stable on mobile networks than letting the camera pick a
      // huge default that the uplink can't sustain (the cause of "very bad"
      // quality / unstable calls when ringing desktop/web).
      const constraints: any = {
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video:
          callType === "video"
            ? {
                facingMode: "user",
                width: { ideal: 1280, max: 1280 },
                height: { ideal: 720, max: 720 },
                frameRate: { ideal: 30, max: 30 },
              }
            : false,
      };
      const stream = await mediaDevices.getUserMedia(constraints);
      localStreamRef.current = stream as MediaStream;
      setLocalStream(stream as MediaStream);
      return stream as MediaStream;
    } catch {
      return null;
    }
  }, [callType]);

  // Bitrate ramp-up (ported from the web useWebRTC applyBitrateRampUp):
  // start LOW (~300 kbps) so the connection establishes fast on a mobile
  // uplink, then ramp to the target (~800 kbps) over 3s once connected.
  // A static high cap caused stalls/freezes at connect time on congested
  // networks — part of why calls to desktop/web felt slow and unstable.
  const bitrateRampTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const setVideoBitrate = useCallback((pc: RTCPeerConnection, bitrate: number) => {
    try {
      const senders =
        typeof (pc as any).getSenders === "function"
          ? (pc as any).getSenders()
          : [];
      for (const sender of senders) {
        if (sender?.track?.kind !== "video") continue;
        const params = sender.getParameters?.();
        if (!params) continue;
        if (!params.encodings || params.encodings.length === 0) {
          params.encodings = [{}];
        }
        params.encodings[0].maxBitrate = bitrate;
        params.encodings[0].maxFramerate = 30;
        (params as any).degradationPreference = "maintain-framerate";
        sender.setParameters?.(params).catch?.(() => {});
      }
    } catch {
      /* setParameters not critical — ignore */
    }
  }, []);

  const applySenderEncodingLimits = useCallback(
    (pc: RTCPeerConnection) => {
      // Initial conservative cap for fast, stable connect.
      setVideoBitrate(pc, 300_000);
    },
    [setVideoBitrate],
  );

  const applyBitrateRampUp = useCallback(
    (pc: RTCPeerConnection) => {
      const INITIAL = 300_000;
      const TARGET = 800_000;
      const STEPS = 3;
      const STEP_MS = 1000;
      bitrateRampTimersRef.current.forEach((t) => clearTimeout(t));
      bitrateRampTimersRef.current = [];
      setVideoBitrate(pc, INITIAL);
      for (let step = 1; step <= STEPS; step++) {
        const timer = setTimeout(() => {
          if ((pc as any).connectionState !== "connected") return;
          const bitrate = Math.round(
            INITIAL + ((TARGET - INITIAL) * step) / STEPS,
          );
          setVideoBitrate(pc, bitrate);
        }, STEP_MS * step);
        bitrateRampTimersRef.current.push(timer);
      }
    },
    [setVideoBitrate],
  );

  // Briefly wait for the real ICE config (TURN creds) so the connection is
  // established over a relay when needed instead of racing with the fallback
  // STUN-only servers. Fast-exits the moment the config has loaded.
  //
  // Kept SHORT (≤800ms): the fallback list already contains working TURN
  // relays, so we must not stall the offer/answer for seconds waiting on the
  // ICE-config fetch — that was a major contributor to the 10–20s connect
  // time when calling desktop/web. If the real config arrives later it's still
  // used by any subsequent ICE restart / relay rebuild.
  const waitForIceConfig = useCallback(async (timeoutMs = 800) => {
    if (iceConfigLoadedRef.current) return;
    const start = Date.now();
    while (!iceConfigLoadedRef.current && Date.now() - start < timeoutMs) {
      await new Promise((r) => setTimeout(r, 50));
    }
  }, []);

  // Attach local tracks AFTER setRemoteDescription on the answerer so they bind
  // to the transceivers the offer created (mirrors web's attachLocalTracks).
  //
  // CRITICAL: on react-native-webrtc, calling addTrack() after
  // setRemoteDescription(offer) frequently creates a NEW, unmatched m-line
  // instead of reusing the recvonly transceiver the offer created. That makes
  // the answer SDP no longer line up with the offer → ICE never settles, the
  // call connects slowly, stalls, or drops. We instead find the offer's
  // matching transceiver by kind and replaceTrack onto it (upgrading the
  // direction to sendrecv), only falling back to addTrack when there is no
  // matching transceiver — exactly what the proven web client does.
  const attachLocalTracks = useCallback(async (stream: MediaStream | null) => {
    const pc = pcRef.current;
    if (!pc || !stream) return;
    const transceivers =
      typeof (pc as any).getTransceivers === "function"
        ? (pc as any).getTransceivers()
        : [];
    const used = new Set<any>();

    for (const track of stream.getTracks()) {
      // Skip if this exact track is already on some sender.
      const alreadyAttached = transceivers.some(
        (t: any) => t.sender?.track && t.sender.track.id === track.id,
      );
      if (alreadyAttached) continue;

      // Find an unused transceiver of MATCHING kind created by the remote
      // offer (its receiver track kind reflects what was offered).
      const matchingTr = transceivers.find((t: any) => {
        if (used.has(t)) return false;
        if (t.sender?.track) return false; // already in use
        const trKind = t.receiver?.track?.kind;
        return trKind === track.kind;
      });

      if (matchingTr) {
        used.add(matchingTr);
        try {
          await matchingTr.sender.replaceTrack(track);
          // Upgrade direction so we actually SEND media on this m-line.
          try {
            matchingTr.direction = "sendrecv";
          } catch {
            /* not always settable */
          }
        } catch {
          // replaceTrack failed — fall back to addTrack.
          try {
            pc.addTrack(track, stream);
          } catch {
            /* ignore */
          }
        }
      } else {
        // No matching transceiver from the offer — addTrack (creates a new
        // m-line + triggers renegotiation if needed).
        try {
          pc.addTrack(track, stream);
        } catch {
          /* ignore */
        }
      }
    }
  }, []);

  const createPC = useCallback(
    (stream: MediaStream | null, targetUserId: number, addTracksNow = true) => {
      // When relayOnlyRef is set (after a UDP/STUN ICE failure) we force
      // TURN-only so even networks that block UDP entirely can complete the
      // call by relaying every byte over TCP/TLS. This is the key recovery
      // path for restrictive mobile carriers / corporate Wi-Fi.
      const pcConfig: any = {
        iceServers: iceServersRef.current,
        // Pre-gather candidates + fewer ports → faster, firewall-friendlier
        // connection setup (matches web config).
        iceCandidatePoolSize: 10,
        bundlePolicy: "max-bundle",
        rtcpMuxPolicy: "require",
      };
      if (relayOnlyRef.current) {
        pcConfig.iceTransportPolicy = "relay";
      }
      const pc = new RTCPeerConnection(pcConfig);
      pcRef.current = pc;

      // For the OFFERER tracks must exist before createOffer. For the ANSWERER
      // tracks are attached AFTER setRemoteDescription so they bind to the
      // offer's transceivers instead of creating extra unmatched m-lines
      // (which breaks media negotiation — the remote video never renders).
      if (stream && addTracksNow) {
        stream.getTracks().forEach((track) => pc.addTrack(track, stream));
      }

      // Safety net: if we never reach "connected" within 30s, the negotiation
      // stalled (lost candidate, blocked TURN). Tear down so the user isn't
      // stuck on an endless "Connecting…" screen.
      if (connectionTimeoutRef.current) {
        clearTimeout(connectionTimeoutRef.current);
      }
      connectionTimeoutRef.current = setTimeout(() => {
        if ((pc as any).connectionState !== "connected") {
          endAndLeave(false);
        }
      }, 30000);

      (pc as any).onicecandidate = (e: any) => {
        if (e.candidate) {
          socket.send("call_signal", {
            conversationId,
            targetUserId,
            signal: { type: "ice-candidate", candidate: e.candidate.toJSON() },
          });
        }
      };

      (pc as any).ontrack = (e: any) => {
        // Defensively build the remote stream: react-native-webrtc may fire
        // ontrack once per kind (audio, then video) and `e.streams` can be
        // empty. Add each track to the SAME stream so we never drop one.
        let stream: MediaStream | null = remoteStreamRef.current;
        if (e.streams && e.streams[0]) {
          stream = e.streams[0];
        } else if (!stream) {
          stream = new MediaStream();
        }
        if (
          e.track &&
          stream &&
          !stream.getTracks().some((t) => t.id === e.track.id)
        ) {
          try {
            stream.addTrack(e.track);
          } catch {
            /* ignore */
          }
        }
        remoteStreamRef.current = stream;
        setRemoteStream(stream);
        if (e.track?.kind === "video") setRemoteVideoOff(false);
      };

      // Fast proactive ICE restart on a brief mobile/VPN network blip — try to
      // re-establish before connectionState escalates to "failed".
      (pc as any).oniceconnectionstatechange = () => {
        const ice = (pc as any).iceConnectionState;
        if (
          ice === "disconnected" &&
          negotiationDoneRef.current &&
          !iceRestartAttemptedRef.current
        ) {
          setTimeout(() => {
            const cur = (pc as any).iceConnectionState;
            if (
              (cur === "disconnected" || cur === "failed") &&
              pcRef.current === pc
            ) {
              iceRestartAttemptedRef.current = true;
              (async () => {
                try {
                  const offer = await pc.createOffer({ iceRestart: true });
                  await pc.setLocalDescription(offer);
                  socket.send("call_signal", {
                    conversationId,
                    targetUserId,
                    signal: {
                      type: "offer",
                      sdp: (pc as any).localDescription?.sdp,
                    },
                  });
                } catch {
                  /* ignore — connectionState handler will escalate */
                }
              })();
            }
          }, 2000);
        }
      };

      (pc as any).onconnectionstatechange = () => {
        const st = (pc as any).connectionState;
        if (st === "connected") {
          startedAt.current = Date.now();
          negotiationDoneRef.current = true;
          iceRestartAttemptedRef.current = false;
          if (connectionTimeoutRef.current) {
            clearTimeout(connectionTimeoutRef.current);
            connectionTimeoutRef.current = null;
          }
          if (disconnectTimerRef.current) {
            clearTimeout(disconnectTimerRef.current);
            disconnectTimerRef.current = null;
          }
          setStatus("connected");
          // Ramp the video bitrate up now that the link is established
          // (mirrors web applyBitrateRampUp).
          applyBitrateRampUp(pc);
        } else if (st === "disconnected") {
          // Grace period: a temporary network hiccup is common on mobile.
          // Wait before tearing the call down so it can self-heal.
          if (disconnectTimerRef.current) {
            clearTimeout(disconnectTimerRef.current);
          }
          disconnectTimerRef.current = setTimeout(() => {
            if (
              pcRef.current === pc &&
              (pc as any).connectionState !== "connected"
            ) {
              endAndLeave(false);
            }
          }, 8000);
        } else if (st === "failed") {
          if (disconnectTimerRef.current) {
            clearTimeout(disconnectTimerRef.current);
            disconnectTimerRef.current = null;
          }
          // Recovery ladder: ICE restart → relay-only rebuild → give up.
          if (!iceRestartAttemptedRef.current && negotiationDoneRef.current) {
            iceRestartAttemptedRef.current = true;
            (async () => {
              try {
                const offer = await pc.createOffer({ iceRestart: true });
                await pc.setLocalDescription(offer);
                socket.send("call_signal", {
                  conversationId,
                  targetUserId,
                  signal: {
                    type: "offer",
                    sdp: (pc as any).localDescription?.sdp,
                  },
                });
              } catch {
                endAndLeave(false);
              }
            })();
          } else if (!relayOnlyRef.current) {
            // ICE restart didn't help — escalate to TURN-only and rebuild.
            relayOnlyRef.current = true;
            iceRestartAttemptedRef.current = false;
            setStatus("connecting");
            const localStr = localStreamRef.current;
            try {
              pc.close();
            } catch {
              /* ignore */
            }
            pcRef.current = null;
            pendingIce.current = [];
            (async () => {
              try {
                const builder = createPCRef.current;
                if (!builder || !localStr) return endAndLeave(false);
                const newPc = builder(localStr, targetUserId, true);
                const offer = await newPc.createOffer({});
                await newPc.setLocalDescription(offer);
                socket.send("call_signal", {
                  conversationId,
                  targetUserId,
                  signal: { type: "offer", sdp: offer.sdp },
                });
              } catch {
                endAndLeave(false);
              }
            })();
          } else {
            endAndLeave(false);
          }
        } else if (st === "closed") {
          endAndLeave(false);
        }
      };

      return pc;
    },
    [conversationId, endAndLeave],
  );

  // Keep a stable ref to createPC so the relay-only rebuild path inside the
  // connection-state handler can recreate the PC without a stale closure.
  createPCRef.current = createPC;

  const flushIce = useCallback(async () => {
    const pc = pcRef.current;
    if (!pc || !(pc as any).remoteDescription) return;
    const list = pendingIce.current.splice(0);
    for (const c of list) {
      try {
        await pc.addIceCandidate(new RTCIceCandidate(c));
      } catch {
        /* ignore */
      }
    }
  }, []);

  // Clear all recovery timers when the screen unmounts so a late-firing
  // timeout can't tear down a fresh call or call endAndLeave after navigation.
  useEffect(() => {
    return () => {
      if (connectionTimeoutRef.current) {
        clearTimeout(connectionTimeoutRef.current);
        connectionTimeoutRef.current = null;
      }
      if (disconnectTimerRef.current) {
        clearTimeout(disconnectTimerRef.current);
        disconnectTimerRef.current = null;
      }
      bitrateRampTimersRef.current.forEach((t) => clearTimeout(t));
      bitrateRampTimersRef.current = [];
    };
  }, []);

  // Load ICE config up front.
  useEffect(() => {
    getIceConfig()
      .then((r) => {
        if (r.data?.iceServers?.length) {
          iceServersRef.current = r.data.iceServers;
        }
      })
      .catch(() => {})
      .finally(() => {
        iceConfigLoadedRef.current = true;
      });
  }, []);

  // Outgoing: acquire media + send call_initiate immediately.
  useEffect(() => {
    if (mode !== "outgoing") return;
    (async () => {
      const stream = await getMedia();
      if (!stream) {
        endAndLeave(false);
        return;
      }
      socket.send("call_initiate", { conversationId, callType });
    })();
    // eslint-disable-line react-hooks/exhaustive-deps
  }, [mode, conversationId, callType, getMedia, endAndLeave]);

  // Incoming: PRE-WARM camera/mic while the phone is still ringing (mirrors
  // the web client's pre-warm path). Acquiring media only after the user taps
  // Accept added 2–5s before the offer/answer could even start — one of the
  // main reasons mobile→desktop calls took 10–20s to connect.
  useEffect(() => {
    if (mode !== "incoming") return;
    let cancelled = false;
    (async () => {
      if (localStreamRef.current) return;
      const stream = await getMedia();
      // If the user already rejected / left while we were acquiring, release.
      if (cancelled && stream) {
        try {
          stream.getTracks().forEach((t) => t.stop());
        } catch {
          /* ignore */
        }
        localStreamRef.current = null;
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  // Signaling listener.
  useEffect(() => {
    const off = socket.subscribe((msg) => {
      const d = msg.data || {};
      switch (msg.type) {
        case "call_started":
          callIdRef.current = d.callId;
          break;
        case "call_accepted": {
          // Caller side: peer accepted → create offer to them.
          if (mode !== "outgoing") return;
          peerIdRef.current = d.userId;
          setStatus("connecting");
          (async () => {
            const stream = localStreamRef.current || (await getMedia());
            if (!stream) return endAndLeave(false);
            await waitForIceConfig();
            const pc = createPC(stream, d.userId, true);
            applySenderEncodingLimits(pc);
            const offer = await pc.createOffer({});
            await pc.setLocalDescription(offer);
            socket.send("call_signal", {
              conversationId,
              targetUserId: d.userId,
              signal: { type: "offer", sdp: offer.sdp },
            });
          })();
          break;
        }
        case "call_signal": {
          if (Number(d.conversationId) !== conversationId) return;
          const signal = d.signal;
          const from = d.fromUserId;
          if (from != null) peerIdRef.current = from;
          (async () => {
            let pc = pcRef.current;
            if (signal.type === "offer") {
              // If a fresh offer arrives while our PC is dead (the peer escalated
              // to a relay-only rebuild), tear ours down and rebuild in relay
              // mode too so both sides negotiate over TURN.
              if (pc) {
                const cs = (pc as any).connectionState;
                const ics = (pc as any).iceConnectionState;
                if (
                  cs === "failed" ||
                  cs === "closed" ||
                  ics === "failed" ||
                  ics === "closed"
                ) {
                  relayOnlyRef.current = true;
                  iceRestartAttemptedRef.current = false;
                  try {
                    pc.close();
                  } catch {
                    /* ignore */
                  }
                  pcRef.current = null;
                  pc = null;
                  pendingIce.current = [];
                }
              }
              // Callee side: build PC WITHOUT tracks, set remote, THEN attach
              // local tracks so they bind to the offer's transceivers.
              const stream = localStreamRef.current || (await getMedia());
              if (!stream) return endAndLeave(false);
              await waitForIceConfig();
              pc = pcRef.current || createPC(stream, from, false);
              await pc.setRemoteDescription(
                new RTCSessionDescription(signal),
              );
              // Must await: tracks have to be bound to the offer's
              // transceivers BEFORE createAnswer so the answer SDP advertises
              // sendrecv media. Otherwise the peer never receives our audio/
              // video and the connection appears to "not connect".
              await attachLocalTracks(stream);
              applySenderEncodingLimits(pc);
              await flushIce();
              const answer = await pc.createAnswer();
              await pc.setLocalDescription(answer);
              socket.send("call_signal", {
                conversationId,
                targetUserId: from,
                signal: { type: "answer", sdp: answer.sdp },
              });
              // Tell the peer our current camera state immediately so they
              // render avatar vs. video correctly from the start.
              socket.send("call_signal", {
                conversationId,
                targetUserId: from,
                signal: { type: "video-state", videoOff },
              });
            } else if (signal.type === "answer") {
              if (!pc) return;
              await pc.setRemoteDescription(
                new RTCSessionDescription(signal),
              );
              await flushIce();
            } else if (signal.type === "ice-candidate") {
              if (signal.candidate == null) return;
              if (pc && (pc as any).remoteDescription) {
                try {
                  await pc.addIceCandidate(
                    new RTCIceCandidate(signal.candidate),
                  );
                } catch {
                  /* ignore */
                }
              } else {
                pendingIce.current.push(signal.candidate);
              }
            } else if (signal.type === "video-state") {
              // Peer toggled their camera. This explicit signal — not the
              // unreliable track.onmute — drives whether we show their video
              // or the avatar + black screen.
              setRemoteVideoOff(!!signal.videoOff);
            } else if (signal.type === "audio-state") {
              // Peer toggled their mic — surface a mute badge (mirrors web's
              // peerMuted + remoteMuteBadge). The explicit signal is reliable
              // where track.onmute is not on react-native-webrtc.
              setPeerMuted(!!signal.muted);
            }
          })();
          break;
        }
        case "call_ended":
          if (Number(d.conversationId) === conversationId) {
            setStatus("ended");
            endAndLeave(false);
          }
          break;
        case "call_rejected":
          if (Number(d.conversationId) === conversationId) {
            setStatus("rejected");
            setTimeout(() => endAndLeave(false), 800);
          }
          break;
      }
    });
    return off;
  }, [
    mode,
    conversationId,
    getMedia,
    createPC,
    attachLocalTracks,
    applySenderEncodingLimits,
    flushIce,
    endAndLeave,
    waitForIceConfig,
    videoOff,
  ]);

  // ── Call duration timer (mirrors web CallOverlay) ──────────────────────────
  useEffect(() => {
    if (status !== "connected") return;
    setDuration(0);
    const t = setInterval(() => setDuration((d) => d + 1), 1000);
    return () => clearInterval(t);
  }, [status]);

  // ── Connection-quality monitor via getStats() (mirrors web NetworkStats) ───
  useEffect(() => {
    if (status !== "connected") {
      setConnectionQuality("unknown");
      return;
    }
    const interval = setInterval(async () => {
      const pc = pcRef.current;
      if (!pc || typeof (pc as any).getStats !== "function") return;
      try {
        const stats = await pc.getStats();
        let rtt: number | null = null;
        let packetsLost = 0;
        let packetsReceived = 0;
        stats.forEach((report: any) => {
          if (
            report.type === "candidate-pair" &&
            (report.state === "succeeded" || report.nominated)
          ) {
            if (typeof report.currentRoundTripTime === "number") {
              rtt = report.currentRoundTripTime;
            }
          }
          if (report.type === "inbound-rtp" && report.kind === "audio") {
            packetsLost = report.packetsLost || 0;
            packetsReceived = report.packetsReceived || 0;
          }
        });
        const lossRate =
          packetsReceived > 0
            ? packetsLost / (packetsLost + packetsReceived)
            : 0;
        if (rtt !== null && rtt < 0.15 && lossRate < 0.02) {
          setConnectionQuality("good");
        } else if (rtt !== null && rtt < 0.4 && lossRate < 0.05) {
          setConnectionQuality("fair");
        } else if (rtt !== null) {
          setConnectionQuality("poor");
        }
      } catch {
        /* stats unavailable this tick */
      }
    }, 3000);
    return () => clearInterval(interval);
  }, [status]);

  // Incoming: accept handler. Send call_accept IMMEDIATELY (don't serialize
  // behind getUserMedia) — the caller starts building its offer right away
  // while we finish acquiring media in parallel. Combined with the ringing
  // pre-warm above this shaves seconds off the connect time.
  async function acceptIncoming() {
    setStatus("connecting");
    socket.send("call_accept", {
      callId: callIdRef.current,
      conversationId,
    });
    if (!localStreamRef.current) {
      const stream = await getMedia();
      if (!stream) return endAndLeave(false);
    }
    // The caller will now send us an offer (handled in call_signal).
  }

  function rejectIncoming() {
    socket.send("call_reject", {
      callId: callIdRef.current,
      conversationId,
    });
    endAndLeave(false);
  }

  function toggleMute() {
    const stream = localStreamRef.current;
    if (!stream) return;
    const next = !muted;
    stream.getAudioTracks().forEach((t) => {
      t.enabled = !next;
    });
    setMuted(next);
    const target = peerIdRef.current;
    if (target) {
      socket.send("call_signal", {
        conversationId,
        targetUserId: target,
        signal: { type: "audio-state", muted: next },
      });
    }
  }

  function toggleVideo() {
    const stream = localStreamRef.current;
    if (!stream) return;
    const next = !videoOff;
    stream.getVideoTracks().forEach((t) => {
      t.enabled = !next;
    });
    setVideoOff(next);
    // Inform the peer so they render avatar/black instead of a frozen frame.
    const target = peerIdRef.current;
    if (target) {
      socket.send("call_signal", {
        conversationId,
        targetUserId: target,
        signal: { type: "video-state", videoOff: next },
      });
    }
  }

  function switchCamera() {
    const stream = localStreamRef.current;
    stream?.getVideoTracks().forEach((t) => {
      // react-native-webrtc track exposes _switchCamera()
      (t as any)._switchCamera?.();
    });
  }

  const statusLabel =
    status === "ringing"
      ? mode === "incoming"
        ? "Incoming call…"
        : "Ringing…"
      : status === "connecting"
        ? "Connecting…"
        : status === "connected"
          ? "Connected"
          : status === "rejected"
            ? "Call declined"
            : "Call ended";

  const showVideo = callType === "video";
  // Only paint the remote video when the peer actually has their camera on.
  // Otherwise we fall through to the avatar + name on a black screen.
  const showRemoteVideo = showVideo && remoteStream && !remoteVideoOff;

  const fmtDuration = (secs: number) => {
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return `${m}:${String(s).padStart(2, "0")}`;
  };

  const qualityColor =
    connectionQuality === "good"
      ? "#22c55e"
      : connectionQuality === "fair"
        ? "#f59e0b"
        : connectionQuality === "poor"
          ? "#ef4444"
          : "rgba(255,255,255,0.5)";
  const qualityLabel =
    connectionQuality === "good"
      ? "Good"
      : connectionQuality === "fair"
        ? "Fair"
        : connectionQuality === "poor"
          ? "Poor"
          : "…";

  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ headerShown: false }} />

      {/* Remote video / avatar */}
      {showRemoteVideo ? (
        <RTCView
          streamURL={(remoteStream as any).toURL()}
          style={styles.remoteVideo}
          objectFit="cover"
          // Never mirror the remote feed — only a front-camera self-view should
          // be mirrored. Without this the peer's video renders like a mirror
          // image (left-right flipped) on the phone.
          mirror={false}
          // Android renders each RTCView on a SurfaceView; without explicit
          // zOrder the surfaces stack unpredictably and the small local
          // preview can be painted UNDER this full-screen view (the
          // "self preview not showing" bug). Remote = base layer.
          zOrder={0}
        />
      ) : (
        <View style={styles.avatarWrap}>
          <View style={styles.avatar}>
            <Text style={styles.avatarText}>
              {(peerName || "?")[0]?.toUpperCase()}
            </Text>
          </View>
        </View>
      )}

      {/* Local preview */}
      {showVideo && localStream && !videoOff ? (
        <RTCView
          streamURL={(localStream as any).toURL()}
          style={styles.localVideo}
          objectFit="cover"
          // Mirror ONLY the self-view (front camera) — natural "mirror"
          // behaviour users expect, matching the web client.
          mirror
          // Must be a HIGHER media-overlay layer than the remote view, or
          // Android intermittently hides the self preview entirely.
          zOrder={1}
        />
      ) : null}

      {/* Top status bar — connection quality + peer-mute, once connected
          (mirrors the web CallOverlay top bar). */}
      {status === "connected" ? (
        <View style={styles.topBar}>
          <View style={styles.qualityBadge}>
            <Signal size={13} color={qualityColor} />
            <Text style={[styles.qualityLabel, { color: qualityColor }]}>
              {qualityLabel}
            </Text>
          </View>
          {peerMuted ? (
            <View style={styles.muteBadge}>
              <MicOff size={13} color="#fff" />
              <Text style={styles.muteBadgeText}>Muted</Text>
            </View>
          ) : null}
        </View>
      ) : null}

      {/* Header info */}
      <View style={styles.info}>
        <Text style={styles.peerName}>{peerName}</Text>
        <Text style={styles.status}>
          {status === "connected" ? fmtDuration(duration) : statusLabel}
        </Text>
      </View>

      {/* Controls */}
      <View style={styles.controls}>
        {mode === "incoming" && status === "ringing" ? (
          <>
            <Pressable
              style={[styles.ctrl, styles.reject]}
              onPress={rejectIncoming}
            >
              <PhoneOff size={26} color="#fff" />
            </Pressable>
            <Pressable
              style={[styles.ctrl, styles.accept]}
              onPress={acceptIncoming}
            >
              <Phone size={26} color="#fff" />
            </Pressable>
          </>
        ) : (
          <>
            <Pressable style={styles.ctrl} onPress={toggleMute}>
              {muted ? (
                <MicOff size={24} color="#fff" />
              ) : (
                <Mic size={24} color="#fff" />
              )}
            </Pressable>
            {showVideo ? (
              <Pressable style={styles.ctrl} onPress={toggleVideo}>
                {videoOff ? (
                  <VideoOff size={24} color="#fff" />
                ) : (
                  <VideoIcon size={24} color="#fff" />
                )}
              </Pressable>
            ) : null}
            {showVideo ? (
              <Pressable style={styles.ctrl} onPress={switchCamera}>
                <SwitchCamera size={24} color="#fff" />
              </Pressable>
            ) : null}
            <Pressable
              style={[styles.ctrl, styles.reject]}
              onPress={() => endAndLeave(true)}
            >
              <PhoneOff size={26} color="#fff" />
            </Pressable>
          </>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#0a0a0a" },
  remoteVideo: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "#000",
  },
  localVideo: {
    position: "absolute",
    top: 50,
    right: 16,
    width: 110,
    height: 160,
    borderRadius: 12,
    backgroundColor: "#000",
    overflow: "hidden",
    // zIndex alone does NOT lift a view above a sibling on Android — elevation
    // is required, otherwise the full-screen remote video paints over the
    // self-preview once the call connects and the local tile "disappears".
    zIndex: 5,
    elevation: 8,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.25)",
  },
  avatarWrap: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: "center",
    justifyContent: "center",
  },
  avatar: {
    width: 120,
    height: 120,
    borderRadius: 60,
    backgroundColor: theme.primary,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarText: { color: "#fff", fontSize: 44, fontWeight: "700" },
  info: {
    position: "absolute",
    top: 80,
    left: 0,
    right: 0,
    alignItems: "center",
    gap: 6,
  },
  peerName: { color: "#fff", fontSize: 24, fontWeight: "700" },
  status: { color: "rgba(255,255,255,0.7)", fontSize: 15 },
  topBar: {
    position: "absolute",
    top: 44,
    left: 16,
    right: 16,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    zIndex: 6,
    elevation: 9,
  },
  qualityBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    backgroundColor: "rgba(0,0,0,0.45)",
    borderRadius: 14,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  qualityLabel: { fontSize: 12, fontWeight: "700" },
  muteBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    backgroundColor: "rgba(239,68,68,0.85)",
    borderRadius: 14,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  muteBadgeText: { color: "#fff", fontSize: 12, fontWeight: "700" },
  controls: {
    position: "absolute",
    bottom: 48,
    left: 0,
    right: 0,
    flexDirection: "row",
    justifyContent: "center",
    gap: 20,
  },
  ctrl: {
    width: 60,
    height: 60,
    borderRadius: 30,
    backgroundColor: "rgba(255,255,255,0.18)",
    alignItems: "center",
    justifyContent: "center",
  },
  reject: { backgroundColor: theme.danger },
  accept: { backgroundColor: theme.success },
});
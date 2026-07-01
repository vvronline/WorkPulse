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
import NetInfo from "@react-native-community/netinfo";
import { socket, type WSMessage } from "../realtime/socket";
import { getIceConfig, warmIceConfig } from "../features";
import { hasRealTurn, applyPublicTurnPolicy } from "../realtime/callIceConfig";
import {
  peerConnectionReducer,
  initialPeerPhase,
  isPeerTerminal,
  type PeerPhase,
  type PeerEvent,
} from "./peerConnectionMachine";

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

// Phase 3.2 (G5) — per-peer connect timeout. If a peer still hasn't reached
// `connected` after this window we stop the infinite spinner and flag the tile
// "Couldn't connect — Retry". Cleared on connect / teardown / manual retry.
const PEER_CONNECT_TIMEOUT_MS = 30_000;

// Phase 4.1 — Opus audio cap. Prioritized: audio is pinned here and NEVER
// governed down by peer count (unified with web `AUDIO_MAX_BITRATE`), so voice
// always survives even when the video ladder squeezes at high participant counts.
const AUDIO_MAX_BITRATE = 48_000;

// Phase 4.2 — Active-speaker-driven video at high counts (unified with web
// `useMeetingState`). A mesh only carries ~5–6 reliable video streams, so once
// the REMOTE-peer count reaches this threshold we stop asking every peer for
// full video and demote the non-priority tiles to `q` (thumbnail → effectively
// audio+avatar). Below the threshold everyone keeps mid/full video (`h`/`f`).
const HIGH_COUNT_VIDEO_THRESHOLD = 6;
// Phase 4.2 — how long a peer stays in the "recent speaker" priority set after
// it last held the floor, so brief pauses don't instantly drop them to a
// thumbnail (hysteresis against back-and-forth conversation).
const RECENT_SPEAKER_WINDOW_MS = 12_000;
// Phase 4.2 — cap on how many peers may hold full video simultaneously at high
// counts (dominant + recent speakers). Keeps the aggregate downlink bounded —
// "only the dominant speaker + a few".
const MAX_PRIORITY_VIDEO_PEERS = 4;
// Phase 4.2 — a peer counts as "speaking" above this normalized audio level
// (matches web's active-speaker threshold), and levels older than the staleness
// window are ignored so a peer who went quiet drops out of the running.
const ACTIVE_SPEAKER_LEVEL = 0.08;
const ACTIVE_SPEAKER_STALE_MS = 2_000;

export type MeetingParticipant = {
  userId: number | string;
  name: string;
  avatar?: string | null;
  stream: MediaStream | null;
  muted: boolean;
  videoOff: boolean;
  // Phase 3.2 (G5) — set true once this peer's 30s connect timeout fires without
  // ever reaching `connected`. The tile then shows a "Couldn't connect — Retry"
  // button instead of an infinite spinner. Cleared on connect / manual retry.
  connectFailed?: boolean;
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
  // Phase 3.1 (P4.19) — relay-first fast-retry timer. Armed once per peer on
  // the initial (non-relay) PC; if the peer isn't `connected` within ~5s we
  // rebuild it TURN-only and re-offer. Cleared on connect / failed / teardown.
  relayRetryTimer?: ReturnType<typeof setTimeout> | null;
  // Phase 3.2 (G5) — per-peer 30s connect timeout. Armed once per peer; if the
  // peer still isn't `connected` when it fires we stop the infinite spinner and
  // flag the participant `connectFailed` so the tile shows a "Couldn't connect —
  // Retry" button. Cleared on connect / teardown (superseded by `retryPeer`).
  connectTimeoutTimer?: ReturnType<typeof setTimeout> | null;
  // Perfect Negotiation (Phase 2.1) — per-peer glare guards. `makingOffer`
  // marks our own offer-in-flight window so a colliding inbound offer is
  // detected as glare; `polite` is the deterministic politeness role
  // (polite = String(selfId) > String(remoteId)).
  polite?: boolean;
  makingOffer?: boolean;
  // Phase 5.1 — per-peer connection phase, driven by the pure
  // `peerConnectionReducer`. The single most important invariant is that the
  // TERMINAL phase (`closed`) is ABSORBING: once `closePeer` marks this entry
  // closed, a LATE `connected` from an RTCPeerConnection being torn down can no
  // longer revive the removed participant tile (the mesh P3.14 effect race).
  phase: PeerPhase;
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
  // Phase 3.1 (P4.19) — per-peer set marking a peer we've escalated to TURN-only
  // (`iceTransportPolicy:"relay"`). Set by the relay-first fast retry (and any
  // future failed-rebuild path) so the rebuilt PC gathers relay candidates only.
  const relayOnlyPeersRef = useRef<Set<string>>(new Set());
  // Phase 4.2 — active-speaker + quality bookkeeping (parity with web
  // `useMeetingState`). `audioLevelsRef`: latest normalized audio level per
  // remote peer (populated from inbound `meeting_audio_level` broadcasts AND our
  // own `getStats` inbound-audio polling so it also works in mobile-only calls).
  // `recentSpeakersRef`: userId → last time that peer held the floor, for the
  // high-count demotion hysteresis window. `lastRequestSentRef`: dedup of the
  // quality level we last asked each peer for (so a steady state produces no WS
  // traffic). `requestedQualityRef`: the level each remote last asked US to send
  // them (applied to OUR outbound video sender toward that peer).
  const audioLevelsRef = useRef<
    Map<string, { level: number; at: number }>
  >(new Map());
  const recentSpeakersRef = useRef<Map<string, number>>(new Map());
  const lastRequestSentRef = useRef<Map<string, string>>(new Map());
  const requestedQualityRef = useRef<Map<string, string>>(new Map());
  // Phase 2.4 (G6) — deterministic ICE-config gating state (ported from the 1:1
  // path). `iceHasRealTurnRef`: the loaded config carries real provisioned TURN
  // (not public Open Relay / STUN-only). `iceAllowPublicRef`: the server permits
  // the public Open Relay fallback (default true for older servers).
  // `firstNegotiationStartedRef`: the very first mesh offer/answer has begun
  // (only that one is gated on genuine TURN).
  const iceHasRealTurnRef = useRef(false);
  const iceAllowPublicRef = useRef(true);
  const firstNegotiationStartedRef = useRef(false);
  const joinedRef = useRef(false);
  // Phase 2.2 — reliable-delivery handshake guards. `subscribedRef` ensures we
  // send `meeting_subscribe` once per join; `readySentRef` ensures `meeting_ready`
  // is sent once our PCs are built. Reset on (re)join.
  const subscribedRef = useRef(false);
  const readySentRef = useRef(false);
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

  // Phase 2.4 (G6) — ICE-config refresh that ALSO records the public-TURN policy
  // (`allowPublicFallback`) + whether the config carries real, provisioned TURN
  // (`hasRealTurn`) so the first-negotiation gate can decide whether to keep
  // (briefly) waiting for genuine creds. Mirrors the 1:1 call screen. Warms the
  // shared Cloudflare TURN cache (warmIceConfig) so a subsequent call resolves
  // instantly.
  const refreshIceConfig = useCallback(async () => {
    try {
      const warmed = await warmIceConfig();
      const cfg = warmed ?? (await getIceConfig()).data;
      const servers = (cfg as any)?.iceServers;
      if (servers?.length) {
        iceServersRef.current = servers;
        iceAllowPublicRef.current =
          (cfg as any).allowPublicFallback !== false;
        iceHasRealTurnRef.current = hasRealTurn(cfg as any);
      }
    } catch {
      /* keep defaults */
    } finally {
      iceLoadedRef.current = true;
    }
  }, []);

  // Phase 2.4 (G6) — deterministic gate. Stage 1: wait for ANY config to load.
  // Stage 2 (FIRST negotiation only): additionally wait — bounded to ~1.5s — for
  // real, provisioned TURN, re-fetching once, so the initial mesh offer/answer
  // never negotiates against the public-only fallback (which makes the first
  // join hang on a relay-required network). A later ICE-restart / renegotiation
  // proceeds promptly with whatever creds we have.
  const waitForIceConfig = useCallback(
    async (timeoutMs = 2000) => {
      const start = Date.now();
      if (!iceLoadedRef.current) {
        while (!iceLoadedRef.current && Date.now() - start < timeoutMs) {
          await new Promise((r) => setTimeout(r, 50));
        }
      }
      if (!firstNegotiationStartedRef.current && !iceHasRealTurnRef.current) {
        const REAL_TURN_DEADLINE_MS = Math.max(timeoutMs, 1500);
        let refetched = false;
        while (
          !iceHasRealTurnRef.current &&
          Date.now() - start < REAL_TURN_DEADLINE_MS
        ) {
          if (!refetched) {
            refetched = true;
            void refreshIceConfig();
          }
          await new Promise((r) => setTimeout(r, 150));
        }
      }
      firstNegotiationStartedRef.current = true;
    },
    [refreshIceConfig],
  );

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
            // Phase 4.1 — audio is prioritized: pinned at AUDIO_MAX_BITRATE and
            // never scaled by the peer-count governor.
            params.encodings[0].maxBitrate = AUDIO_MAX_BITRATE;
          }
          sender.setParameters?.(params).catch?.(() => {});
        }
      } catch {
        /* setParameters not critical */
      }
    },
    [],
  );

  // Phase 4.1 — bandwidth governor. Unified with web
  // `useMeetingState.videoBitrateForPeerCount` so both platforms cap the mesh
  // uplink identically as the call grows (a mesh sends N−1 copies of our video,
  // so an uncapped uplink saturates → the "very unstable and laggy" report and
  // starves audio). `peersRef.current.size` is the number of REMOTE peers.
  // Tiered caps: ≤3 → 500 kbps, 4–6 → 300 kbps, 7+ → 150 kbps. Audio is
  // prioritized separately (pinned at `AUDIO_MAX_BITRATE` in `setVideoBitrate`)
  // and never governed down by peer count so voice always survives.
  const targetBitrateForPeerCount = useCallback((): number => {
    const peerCount = peersRef.current.size;
    if (peerCount <= 3) return 500_000;
    if (peerCount <= 6) return 300_000;
    return 150_000;
  }, []);

  const applyBitrateRampUp = useCallback(
    (entry: PeerEntry) => {
      const pc = entry.pc;
      const TARGET = targetBitrateForPeerCount();
      // Phase 4.1 — start low for a fast, stable establishment then ramp to the
      // governor's ceiling. Clamp the start to TARGET so at high participant
      // counts (7+ → 150 kbps ceiling) we never open ABOVE the ceiling and
      // immediately congest the uplink.
      const INITIAL = Math.min(300_000, TARGET);
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

  // ── Phase 5.1 — per-peer state-machine dispatch ──────────────────────────
  // Drive `entry.phase` through the pure `peerConnectionReducer`. The reducer's
  // `closed` phase is ABSORBING, so once `closePeer` dispatches CLOSED any later
  // event (e.g. a late CONNECTED from a PC being torn down) is a no-op — the
  // removed participant tile can never be resurrected. Returns the new phase so
  // callers can guard on it. Mutating `entry.phase` (a ref-held object) is safe
  // because the phase drives imperative teardown decisions, not React render.
  const dispatchPeer = useCallback(
    (entry: PeerEntry, event: PeerEvent): PeerPhase => {
      entry.phase = peerConnectionReducer(entry.phase, event);
      return entry.phase;
    },
    [],
  );

  const closePeer = useCallback(
    (key: string) => {
      const entry = peersRef.current.get(key);
      if (!entry) return;
      // Phase 5.1 — mark the entry terminally closed BEFORE we tear it down so
      // any in-flight async callback still holding this `entry` (a pending
      // createOffer/answer chain, a getStats tick, or the onconnectionstatechange
      // callback firing a late "connected") sees `isPeerTerminal(entry.phase)`
      // and refuses to revive the removed tile.
      dispatchPeer(entry, { type: "CLOSED" });
      if (entry.disconnectTimer) clearTimeout(entry.disconnectTimer);
      if (entry.relayRetryTimer) clearTimeout(entry.relayRetryTimer);
      // Phase 3.2 (G5) — clear the connect-timeout timer on teardown.
      if (entry.connectTimeoutTimer) clearTimeout(entry.connectTimeoutTimer);
      entry.rampTimers?.forEach((t) => clearTimeout(t));
      try {
        entry.pc.close();
      } catch {
        /* ignore */
      }
      peersRef.current.delete(key);
    },
    [dispatchPeer],
  );

  // ── Phase 2.3 (G4) — reliable mesh-signal send ───────────────────────────
  // The bare `socket.send` returns false (dropping the frame) when the WS isn't
  // OPEN — an offer / answer / ICE candidate produced during a reconnect window
  // was silently lost, leaving a peer stuck on "Connecting…". Route every mesh
  // signaling frame through `sendWithRetry` instead: on the happy path it sends
  // synchronously (preserving order), and during a blip it retries until the
  // socket reopens or the budget expires. Fire-and-forget (void) so the WebRTC
  // callbacks (onicecandidate, createOffer chains) stay non-blocking.
  const sendSignal = useCallback((data: any) => {
    void socket.sendWithRetry("meeting_signal", data, {
      timeoutMs: 6000,
      retryEveryMs: 200,
    });
  }, []);

  // ── Phase 4.2 — outbound quality request (dedup) ─────────────────────────
  // Ask a remote peer to send US a given video quality (`q`/`h`/`f`). Deduped
  // via `lastRequestSentRef` so a steady state produces no WS traffic. Mirrors
  // web `useMeetingState.requestPeerQuality`.
  const sendRequestQuality = useCallback(
    (peerKey: string, level: "q" | "h" | "f") => {
      if (!peerKey || !["q", "h", "f"].includes(level)) return;
      if (lastRequestSentRef.current.get(peerKey) === level) return;
      lastRequestSentRef.current.set(peerKey, level);
      socket.send("meeting_request_quality", {
        meetingId: meetingIdRef.current,
        targetUserId: peerKey,
        level,
      });
    },
    [],
  );

  // ── Phase 4.2 — apply a peer's inbound quality request to OUR sender ──────
  // A remote asked us to send them `q`/`h`/`f`; cap our outbound video sender
  // toward that peer accordingly, BOUNDED by the Phase 4.1 governor ceiling for
  // the current call size (so a "full" request can never push our uplink past
  // what N−1 peers afford). Audio is never touched. Mirrors web
  // `useMeetingState.applyQualityCapForPeer`.
  const applyQualityCapForPeer = useCallback(
    (peerKey: string) => {
      const entry = peersRef.current.get(peerKey);
      if (!entry) return;
      const level = requestedQualityRef.current.get(peerKey) || "h";
      const ceiling = targetBitrateForPeerCount();
      const maxBitrate =
        level === "q"
          ? Math.min(150_000, ceiling)
          : level === "h"
            ? Math.min(300_000, ceiling)
            : ceiling;
      try {
        const senders =
          typeof (entry.pc as any).getSenders === "function"
            ? (entry.pc as any).getSenders()
            : [];
        for (const sender of senders) {
          if (!sender?.track || sender.track.kind !== "video") continue;
          const params = sender.getParameters?.();
          if (!params) continue;
          if (!params.encodings || params.encodings.length === 0)
            params.encodings = [{}];
          params.encodings[0].maxBitrate = maxBitrate;
          sender.setParameters?.(params).catch?.(() => {});
        }
      } catch {
        /* setParameters not critical */
      }
    },
    [targetBitrateForPeerCount],
  );

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
        // Phase 2.4 (G6) — strip the public Open Relay TURN entries when the
        // server forbids the public fallback. STUN is always kept.
        iceServers: applyPublicTurnPolicy(
          iceServersRef.current,
          iceAllowPublicRef.current,
        ),
        bundlePolicy: "max-bundle",
        rtcpMuxPolicy: "require",
        iceCandidatePoolSize: 4,
        // Phase 3.1 (P4.19) — once escalated, this peer's rebuilt PC gathers
        // TURN-relay candidates only (corporate-proxy / symmetric-NAT lifeline).
        ...(relayOnlyPeersRef.current.has(key)
          ? { iceTransportPolicy: "relay" }
          : {}),
      } as any);

      const remoteStream = new MediaStream();
      const entry: PeerEntry = {
        pc,
        remoteStream,
        iceRestartAttempted: false,
        negotiationDone: false,
        disconnectTimer: null,
        rampTimers: [],
        // Perfect Negotiation (Phase 2.1): deterministic politeness per peer.
        // The lexicographically-greater id is the POLITE peer (rolls back on an
        // offer collision); the other is IMPOLITE (ignores the colliding offer,
        // keeps its own). Stable + symmetric so both sides agree.
        polite: normId(selfIdRef.current) > key,
        makingOffer: false,
        // Phase 5.1 — fresh peer starts in `connecting`. Transitions are driven
        // through `dispatchPeer` (the pure reducer) at each lifecycle point; the
        // `closed` phase is absorbing so a late `connected` can't revive it.
        phase: initialPeerPhase(),
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
          sendSignal({
            meetingId: meetingIdRef.current,
            targetUserId: remoteUserId,
            signal: { type: "candidate", candidate: e.candidate.toJSON() },
          });
        }
      };

      (pc as any).ontrack = (e: any) => {
        // Phase 5.1 — terminal-absorption guard. If this peer was already closed
        // (participant_left / teardown dispatched CLOSED), a late `ontrack` from
        // the PC being torn down must NOT re-`upsert` the removed tile.
        if (isPeerTerminal(entry.phase)) return;
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
                  sendSignal({
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
        // Phase 5.1 — terminal-absorption guard. Once this peer has been closed
        // (participant_left / teardown), a LATE connectionState transition from
        // the PC being torn down (classically a "connected" that lands a beat
        // after we removed the tile) must be a no-op — it can neither revive the
        // removed participant nor mutate global status.
        if (isPeerTerminal(entry.phase)) return;
        if (st === "connected") {
          // Phase 5.1 — record the live phase (connecting/reconnecting →
          // connected) through the pure reducer.
          dispatchPeer(entry, { type: "CONNECTED" });
          entry.negotiationDone = true;
          entry.iceRestartAttempted = false;
          if (entry.disconnectTimer) {
            clearTimeout(entry.disconnectTimer);
            entry.disconnectTimer = null;
          }
          // Phase 3.1 (P4.19) — connected in time; cancel the relay-first
          // fast-retry so it can't tear down a good PC.
          if (entry.relayRetryTimer) {
            clearTimeout(entry.relayRetryTimer);
            entry.relayRetryTimer = null;
          }
          // Phase 3.2 (G5) — connected in time; cancel the connect timeout and
          // clear any "Couldn't connect" flag on the tile.
          if (entry.connectTimeoutTimer) {
            clearTimeout(entry.connectTimeoutTimer);
            entry.connectTimeoutTimer = null;
          }
          upsertParticipant(remoteUserId, { connectFailed: false });
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
          // Phase 5.1 — a previously live peer lost its transport; record the
          // recovering phase (connected → reconnecting) so state reflects the
          // grace/ICE-restart window.
          if (entry.phase === "connected")
            dispatchPeer(entry, { type: "RECONNECTING" });
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
          // Phase 5.1 — the PC failed on its own (ICE gave up). Record the
          // recoverable `failed` phase (RETRY / relay rebuild can revive it).
          dispatchPeer(entry, { type: "FAILED" });
          // Phase 3.1 (P4.19) — the fast-retry timer is redundant once we've
          // reached `failed`/`closed`.
          if (entry.relayRetryTimer) {
            clearTimeout(entry.relayRetryTimer);
            entry.relayRetryTimer = null;
          }
          // Phase 3.2 (G5) — the connect-timeout timer is redundant too.
          if (entry.connectTimeoutTimer) {
            clearTimeout(entry.connectTimeoutTimer);
            entry.connectTimeoutTimer = null;
          }
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
            //
            // Mark our offer-in-flight window (Perfect Negotiation, Phase 2.1)
            // so a colliding inbound offer arriving before setLocalDescription
            // completes is still detected as glare by handleSignal.
            entry.makingOffer = true;
            // Phase 2.4 (G6) — gate the FIRST offer on real TURN so the initial
            // negotiation never runs against the public-only fallback.
            await waitForIceConfig();
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            sendSignal({
              meetingId: meetingIdRef.current,
              targetUserId: remoteUserId,
              signal: { type: "offer", sdp: (pc as any).localDescription },
            });
          } catch {
            /* connection-state handler will surface failures */
          } finally {
            entry.makingOffer = false;
          }
        })();
      }

      // Phase 3.1 (P4.19) — relay-first fast retry. On the INITIAL (non-relay)
      // PC, arm a one-shot ~5s timer: if this peer hasn't reached `connected` by
      // then (a UDP/STUN path a corporate proxy / symmetric NAT silently
      // blackholes), rebuild that ONE peer TURN-only (`iceTransportPolicy:
      // "relay"`, via `relayOnlyPeersRef`) and re-offer as the initiator. This
      // beats waiting for react-native-webrtc's own ICE-`failed` (15–30s) so
      // relay-required mobile networks connect promptly. Skipped when the PC is
      // already relay-only.
      if (!relayOnlyPeersRef.current.has(key)) {
        entry.relayRetryTimer = setTimeout(() => {
          entry.relayRetryTimer = null;
          if (peersRef.current.get(key) !== entry) return;
          if ((pc as any).connectionState === "connected") return;
          if (relayOnlyPeersRef.current.has(key)) return;
          relayOnlyPeersRef.current.add(key);
          closePeer(key);
          createPeer(remoteUserId, true);
        }, 5000);
      }

      // Phase 3.2 (G5) — per-peer 30s connect timeout. If this peer STILL hasn't
      // reached `connected` when it fires, flag the participant `connectFailed`
      // so the tile shows "Couldn't connect — Retry" instead of an infinite
      // spinner. Cleared on connect / teardown. Skipped for relay-only rebuilds
      // (those inherit the original arm's window via the participant flag).
      if (!relayOnlyPeersRef.current.has(key)) {
        entry.connectTimeoutTimer = setTimeout(() => {
          entry.connectTimeoutTimer = null;
          const cur = peersRef.current.get(key);
          if (cur && (cur.pc as any).connectionState === "connected") return;
          // Phase 5.1 — the connect budget expired; move to the recoverable
          // `failed` phase (guarded against a closed peer by the reducer).
          if (cur && !isPeerTerminal(cur.phase))
            dispatchPeer(cur, { type: "FAILED" });
          upsertParticipant(remoteUserId, { connectFailed: true });
        }, PEER_CONNECT_TIMEOUT_MS);
      }

      return entry;
    },
    [
      upsertParticipant,
      closePeer,
      applyBitrateRampUp,
      sendSignal,
      waitForIceConfig,
    ],
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
        // Perfect Negotiation (Phase 2.1) glare guard: an offer arriving while
        // our own offer is in flight (or we're not stable) is a collision. The
        // IMPOLITE peer ignores it (keeps its own offer); the POLITE peer rolls
        // back its local offer then accepts. This governs ALL re-negotiation
        // (ICE restart, future track changes) and kills the glare deadlock (G3).
        const entry = peersRef.current.get(key);
        const offerCollision =
          !!entry?.makingOffer ||
          (pc as any).signalingState !== "stable";
        if (offerCollision) {
          if (entry && !entry.polite) {
            // Impolite peer — ignore the colliding offer.
            return;
          }
          try {
            await (pc as any).setLocalDescription({ type: "rollback" });
          } catch {
            /* some impls auto-rollback on setRemoteDescription(offer) */
          }
        }
        await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
        // Attach our local tracks AFTER setRemoteDescription so they bind to
        // the offer's transceivers (replaceTrack) rather than creating new
        // unmatched m-lines — the key fix that lets mobile↔web/desktop connect.
        await attachLocalTracks(pc, localStreamRef.current);
        await flushPendingIce(key, pc);
        // Phase 2.4 (G6) — gate the FIRST answer on real TURN (mirrors the
        // initiator gate) so the initial negotiation never runs against the
        // public-only fallback.
        await waitForIceConfig();
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        sendSignal({
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
    [flushPendingIce, attachLocalTracks, sendSignal, waitForIceConfig],
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

          // Phase 2.2 — our peer-connection set is now built; tell the server
          // we're ready so it replays any buffered offer/ICE for us and asks the
          // other peers to (re)offer toward us (the `meeting_peer_ready`
          // fan-out). Idempotent via Perfect Negotiation; guarded to fire once.
          if (!readySentRef.current && hasPeersToConnect) {
            readySentRef.current = true;
            socket.send("meeting_ready", { meetingId: meetingIdRef.current });
          }
          break;
        }
        case "meeting_peer_ready": {
          // Phase 2.2 — the server tells us a peer (re)joined / became ready,
          // asking US to (re)offer toward them. If we already have a live PC
          // whose localDescription is an offer, re-send it once (idempotent via
          // Perfect Negotiation). If we have a PC but it isn't offering (we're
          // the answerer side), do nothing — they will offer. If no PC exists
          // yet, create one as initiator so a dropped bootstrap offer recovers.
          const readyUserId = data.userId;
          if (readyUserId == null || normId(readyUserId) === selfKey) break;
          const pk = normId(readyUserId);
          const entry = peersRef.current.get(pk);
          if (entry) {
            const ld = (entry.pc as any).localDescription;
            if (ld && ld.type === "offer") {
              sendSignal({
                meetingId: meetingIdRef.current,
                targetUserId: readyUserId,
                signal: { type: "offer", sdp: ld },
              });
            }
          } else {
            createPeer(readyUserId, true);
          }
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
        case "meeting_request_quality": {
          // Phase 4.2 — a remote asked US to send them a given video quality.
          // Record it and re-cap our outbound video sender toward that peer
          // (bounded by the governor ceiling).
          const { fromUserId, level } = data;
          if (
            fromUserId == null ||
            normId(fromUserId) === selfKey ||
            !["q", "h", "f"].includes(level)
          )
            break;
          const fk = normId(fromUserId);
          requestedQualityRef.current.set(fk, level);
          applyQualityCapForPeer(fk);
          break;
        }
        case "meeting_audio_level": {
          // Phase 4.2 — a remote broadcast its current speaking level. Store it
          // (keyed by normalized id) for the active-speaker selector.
          const { userId, level } = data;
          if (userId == null || normId(userId) === selfKey) break;
          if (typeof level !== "number") break;
          audioLevelsRef.current.set(normId(userId), {
            level,
            at: Date.now(),
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
    [
      createPeer,
      handleSignal,
      upsertParticipant,
      closePeer,
      removeParticipant,
      sendSignal,
      applyQualityCapForPeer,
    ],
  );

  // ── Load ICE config up front (Phase 2.4 — also warms Cloudflare TURN) ─────
  useEffect(() => {
    void refreshIceConfig();
  }, [refreshIceConfig]);

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
        // Phase 2.2 — reliable-delivery handshake: announce we're subscribed so
        // the server replays any buffered offer/ICE and tells the other peers to
        // (re)offer toward us via `meeting_peer_ready`. Distinct from
        // `meeting_ready` (PCs built) — this is "WS attached + listening".
        if (!subscribedRef.current) {
          subscribedRef.current = true;
          socket.send("meeting_subscribe", { meetingId });
        }
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
    // Phase 2.2 — reset the handshake guards so a later (re)join re-subscribes.
    subscribedRef.current = false;
    readySentRef.current = false;
    try {
      localStreamRef.current?.getTracks().forEach((t) => t.stop());
    } catch {
      /* ignore */
    }
    localStreamRef.current = null;
    peersRef.current.forEach((entry) => {
      if (entry.disconnectTimer) clearTimeout(entry.disconnectTimer);
      if (entry.relayRetryTimer) clearTimeout(entry.relayRetryTimer);
      // Phase 3.2 (G5) — clear the connect-timeout timer on teardown.
      if (entry.connectTimeoutTimer) clearTimeout(entry.connectTimeoutTimer);
      entry.rampTimers?.forEach((t) => clearTimeout(t));
      try {
        entry.pc.close();
      } catch {
        /* ignore */
      }
    });
    peersRef.current.clear();
    pendingIceRef.current.clear();
    // Phase 3.1 (P4.19) — clear relay-escalation flags so a later (re)join
    // starts fresh on the normal (STUN+TURN) path.
    relayOnlyPeersRef.current.clear();
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

  // ── Phase 3.2 (G5) — manual per-peer rebuild ─────────────────────────────
  // Invoked from the tile's "Retry" button after the 30s connect timeout flagged
  // the peer `connectFailed`. Tear the peer down completely, clear its recovery
  // bookkeeping (relay escalation + queued ICE), reset the tile to a fresh
  // connecting state, rebuild it as the initiator, and re-announce readiness so
  // the server replays/asks the other side to (re)offer toward us.
  const retryPeer = useCallback(
    (peerId: number | string) => {
      const key = normId(peerId);
      closePeer(key);
      relayOnlyPeersRef.current.delete(key);
      pendingIceRef.current.delete(key);
      upsertParticipant(peerId, { connectFailed: false, stream: null });
      createPeer(peerId, true);
      socket.send("meeting_ready", { meetingId: meetingIdRef.current });
    },
    [closePeer, upsertParticipant, createPeer],
  );

  // ── Phase 3.3 (G7) — global network-change ICE restart ───────────────────
  // The web mesh already ICE-restarts every stable PC on `online` +
  // `connection.change`. Mobile's equivalent triggers are (a) the realtime
  // socket reopening after a drop and (b) RN NetInfo reporting connectivity
  // returned. On either, ICE-restart every stable PC — `createOffer({iceRestart:
  // true})` re-gathers candidates on the new network path so a Wi-Fi↔cellular
  // handoff (or VPN flap) recovers instead of the tiles freezing until the peer
  // eventually hits `failed`. Perfect Negotiation (Phase 2.1) makes the
  // resulting offers glare-safe.
  const restartAllPeers = useCallback(() => {
    for (const [key, entry] of peersRef.current) {
      const pc = entry.pc;
      if ((pc as any).signalingState !== "stable") continue;
      (async () => {
        try {
          entry.makingOffer = true;
          const offer = await pc.createOffer({ iceRestart: true });
          await pc.setLocalDescription(offer);
          sendSignal({
            meetingId: meetingIdRef.current,
            targetUserId: key,
            signal: { type: "offer", sdp: (pc as any).localDescription },
          });
        } catch {
          /* connection-state handler will surface failures */
        } finally {
          entry.makingOffer = false;
        }
      })();
    }
  }, [sendSignal]);

  useEffect(() => {
    if (!wantJoin) return;
    // Socket reopened (reconnect after a drop) → Phase 5.2 reconnect
    // orchestration + Phase 3.3 ICE restart. On a WS reopen the server may have
    // dropped our meeting membership (grace-expiry) and any peer that (re)joined
    // while we were offline won't know about us, so first RE-ANNOUNCE ourselves:
    // re-send `meeting_join` (re-registers us + re-fetches the authoritative
    // `existingPeers`, which `meeting_participant_joined` reconciles — pruning
    // phantoms and rebuilding missing PCs) then `meeting_subscribe` (replays any
    // buffered offer/ICE + fans out `meeting_peer_ready` so the others re-offer
    // toward us). THEN ICE-restart the PCs we still hold so a same-membership
    // blip recovers immediately. Perfect Negotiation (2.1) keeps it glare-safe.
    const offOpen = socket.onOpen(() => {
      const mid = meetingIdRef.current;
      if (mid != null && joinedRef.current) {
        void socket.sendWithRetry(
          "meeting_join",
          { meetingId: mid },
          { timeoutMs: 8000, retryEveryMs: 300 },
        );
        socket.send("meeting_subscribe", { meetingId: mid });
      }
      restartAllPeers();
    });
    // RN NetInfo: connectivity returned (Wi-Fi↔cellular handoff / airplane off).
    let wasConnected = true;
    const offNet = NetInfo.addEventListener((state) => {
      const nowConnected = !!state.isConnected;
      if (nowConnected && !wasConnected) restartAllPeers();
      wasConnected = nowConnected;
    });
    return () => {
      try {
        offOpen();
      } catch {
        /* ignore */
      }
      try {
        offNet();
      } catch {
        /* ignore */
      }
    };
  }, [wantJoin, restartAllPeers]);

  // ── Phase 4.2 — audio-level sampling + broadcast ─────────────────────────
  // Poll each connected peer's inbound-audio `getStats` to derive a coarse
  // speaking level per REMOTE peer (react-native-webrtc has no Web-Audio
  // AnalyserNode, so we approximate from the RTP audio energy/level delta). We
  // also broadcast OUR own level via `meeting_audio_level` so web/desktop peers
  // (which key their active-speaker selector off that message) see us speak.
  // Stored into `audioLevelsRef` keyed by normalized id, same shape web uses.
  const prevAudioStatsRef = useRef<
    Map<string, { bytes: number; at: number }>
  >(new Map());
  useEffect(() => {
    if (!wantJoin) return;
    let cancelled = false;
    const sample = async () => {
      if (cancelled) return;
      // Remote peers: derive a level from inbound-audio byte-rate delta (a
      // proxy for "is this peer producing audio energy right now").
      for (const [key, entry] of peersRef.current) {
        try {
          const stats: any = await (entry.pc as any).getStats?.();
          if (!stats) continue;
          let bytes = 0;
          let audioLevel: number | null = null;
          stats.forEach((r: any) => {
            if (r.type === "inbound-rtp" && r.kind === "audio") {
              bytes += r.bytesReceived || 0;
              if (typeof r.audioLevel === "number")
                audioLevel = r.audioLevel;
            }
          });
          const now = Date.now();
          let level = 0;
          if (audioLevel != null) {
            // Native audioLevel (0..1) is the most accurate when present.
            level = audioLevel;
          } else {
            const prev = prevAudioStatsRef.current.get(key);
            prevAudioStatsRef.current.set(key, { bytes, at: now });
            if (prev && now > prev.at) {
              const kbps =
                ((bytes - prev.bytes) * 8) / (now - prev.at); // bits/ms ≈ kbps
              // Opus at ~a few kbps floor when silent, up to ~48 when active;
              // normalize into a rough 0..1 speaking proxy.
              level = Math.max(0, Math.min(1, (kbps - 6) / 30));
            }
          }
          audioLevelsRef.current.set(key, { level, at: now });
        } catch {
          /* getStats not critical */
        }
      }
    };
    const t = setInterval(sample, 400);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [wantJoin]);

  // ── Phase 4.2 — broadcast OUR speaking level ─────────────────────────────
  // Mirror web's local audio-level publisher so remote peers' active-speaker
  // selectors can promote us. We derive our own level from our first outbound
  // audio sender's getStats (audioLevel when available), throttled like web.
  useEffect(() => {
    if (!wantJoin || muted) return;
    let cancelled = false;
    let lastSent = 0;
    const sample = async () => {
      if (cancelled) return;
      const entry = peersRef.current.values().next().value as
        | PeerEntry
        | undefined;
      if (!entry) return;
      try {
        const stats: any = await (entry.pc as any).getStats?.();
        if (!stats) return;
        let level = 0;
        stats.forEach((r: any) => {
          if (
            (r.type === "media-source" || r.type === "outbound-rtp") &&
            r.kind === "audio" &&
            typeof r.audioLevel === "number"
          ) {
            level = Math.max(level, r.audioLevel);
          }
        });
        const now = Date.now();
        if (level > 0.05 && now - lastSent > 500) {
          lastSent = now;
          socket.send("meeting_audio_level", {
            meetingId: meetingIdRef.current,
            level: +level.toFixed(3),
          });
        }
      } catch {
        /* getStats not critical */
      }
    };
    const t = setInterval(sample, 300);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [wantJoin, muted]);

  // ── Phase 4.2 — Active-speaker-driven video demotion at high counts ──────
  // Parity with web `useMeetingState`. Below `HIGH_COUNT_VIDEO_THRESHOLD` remote
  // peers the mesh can carry everyone's video: the dominant speaker gets full
  // video (`f`) and the rest get mid (`h`). At/above the threshold we upgrade
  // ONLY a bounded priority set (dominant speaker + recent speakers, capped at
  // `MAX_PRIORITY_VIDEO_PEERS`) to full video and demote everyone else to `q`
  // (thumbnail → effectively audio+avatar). Runs on a short interval so the
  // dominant speaker and recent-speaker windows update even when nobody new is
  // talking; the per-peer `sendRequestQuality` is deduped so a steady state
  // produces no WS traffic. (Mobile has no explicit `presenterId` — screenshare
  // isn't a mobile feature — so the priority set is speaker-driven only.)
  useEffect(() => {
    if (!wantJoin) return;
    const applyPolicy = () => {
      const remoteKeys = Array.from(peersRef.current.keys());
      if (remoteKeys.length === 0) return;

      const now = Date.now();
      // Determine the current dominant speaker from fresh audio levels.
      let dominant: string | null = null;
      let best = 0;
      for (const [uid, { level, at }] of audioLevelsRef.current) {
        if (now - at > ACTIVE_SPEAKER_STALE_MS) continue;
        if (level < ACTIVE_SPEAKER_LEVEL) continue;
        if (!peersRef.current.has(uid)) continue;
        if (level > best) {
          best = level;
          dominant = uid;
        }
      }
      if (dominant) recentSpeakersRef.current.set(dominant, now);
      // Prune expired recent-speaker entries so the priority set shrinks back.
      for (const [uid, at] of recentSpeakersRef.current) {
        if (now - at > RECENT_SPEAKER_WINDOW_MS)
          recentSpeakersRef.current.delete(uid);
      }

      const highCount = remoteKeys.length >= HIGH_COUNT_VIDEO_THRESHOLD;

      if (!highCount) {
        // Small call — everyone fits. Dominant speaker gets full video; the
        // rest get mid.
        for (const key of remoteKeys) {
          sendRequestQuality(key, key === dominant ? "f" : "h");
        }
        return;
      }

      // High count — build the bounded priority set: dominant speaker first,
      // then the most-recent speakers, up to `MAX_PRIORITY_VIDEO_PEERS`.
      const priority = new Set<string>();
      if (dominant && priority.size < MAX_PRIORITY_VIDEO_PEERS)
        priority.add(dominant);
      if (priority.size < MAX_PRIORITY_VIDEO_PEERS) {
        const recent = Array.from(recentSpeakersRef.current.entries())
          .filter(([uid]) => peersRef.current.has(uid))
          .sort((a, b) => b[1] - a[1]);
        for (const [uid] of recent) {
          if (priority.size >= MAX_PRIORITY_VIDEO_PEERS) break;
          priority.add(uid);
        }
      }

      for (const key of remoteKeys) {
        sendRequestQuality(key, priority.has(key) ? "f" : "q");
      }
    };

    applyPolicy();
    const t = setInterval(applyPolicy, 2_000);
    return () => clearInterval(t);
  }, [wantJoin, sendRequestQuality]);

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
    retryPeer,
  };
}

import { useEffect, useRef, useState, useCallback } from "react";
import { useAuth } from "../../AuthContext";
import { getIceConfig, uploadChatFile, getMeetingMessages } from "../../api";
import {
    getCachedMessages,
    setCachedMessages,
    upsertCachedMessage,
    applyCachedMessages,
} from "./messagesCache";
import { retryWithBackoff } from "../../utils/retryWithBackoff";
import {
    STATES,
    nextState as fsmNext,
    describeState,
} from "./connectionStateMachine";
import type { MeetingState } from "./connectionStateMachine";
// ADR-008 — MeetingStore singleton. We mirror the highest-traffic state
// slices into the store on every change so future consumers can
// subscribe to one slice instead of importing the whole hook return.
// The hook's own `useState` values stay authoritative; the store is a
// read-only projection during this incremental migration window.
import { createMeetingStore, DEFAULT_MEETING_STATE } from "./meetingStore";
import {
    peerConnectionReducer,
    initialPeerPhase,
    isPeerTerminal,
    type PeerPhase,
    type PeerEvent,
} from "./peerConnectionMachine";
import type { AnyRecord } from "../../types";

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Singleton store shared by every meeting view in the tab. We use a
 * module-scope instance (not a per-hook one) because the consumers we
 * want to migrate later — MeetingChat, ParticipantTile, MeetingBottomBar —
 * are siblings of the hook, not children, and React Context would mean
 * a render-cascade-back to the parent for every state change.
 */
export const meetingStore = createMeetingStore({ ...DEFAULT_MEETING_STATE });

type MeetingMessage = AnyRecord & {
    id?: number | string;
    clientMsgId?: string;
};

type Participant = AnyRecord & { userId: number | string };

/** Extended RTCPeerConnection with our custom bookkeeping props. */
type ExtendedPC = RTCPeerConnection & {
    _remoteStream?: MediaStream;
    _remoteScreenStream?: MediaStream;
    _screenTrackIds?: Set<string>;
    _reclassifyTracks?: () => void;
    _disconnectTimer?: ReturnType<typeof setTimeout> | null;
    // Phase 3.1 (P4.19) — relay-first fast-retry timer. Armed once per peer on
    // the initial (non-relay) PC; if the peer isn't `connected` within ~5s we
    // rebuild it TURN-only and re-offer. Cleared on connect / failed / teardown.
    _relayRetryTimer?: ReturnType<typeof setTimeout> | null;
    // Phase 3.2 (G5) — per-peer 30s connect timeout. Armed once per peer; if the
    // peer still hasn't reached `connected` when it fires, we stop the infinite
    // spinner and flag the participant `connectFailed` so its tile surfaces a
    // "Couldn't connect — Retry" manual-rebuild button. Cleared on connect /
    // teardown (and superseded by a manual `retryPeer`).
    _connectTimeoutTimer?: ReturnType<typeof setTimeout> | null;
    // Perfect Negotiation (Phase 2.1) — per-peer glare guards. `_makingOffer`
    // marks our own offer-in-flight window so a colliding inbound offer is
    // detected as glare; `_polite` is the deterministic politeness role
    // (polite = String(selfId) > String(remoteId)).
    _makingOffer?: boolean;
    _polite?: boolean;
    _isSettingRemoteAnswerPending?: boolean;
    // Phase 5.1 — per-peer connection phase, driven by the pure
    // `peerConnectionReducer` (mesh equivalent of the 1:1 `callStateMachine`).
    // The TERMINAL phase (`closed`) is ABSORBING: once `closePeerConnection`
    // marks this PC closed, a LATE `connected`/`ontrack` from the connection
    // being torn down can no longer revive the removed participant tile — the
    // mesh P3.14 effect race.
    _phase?: PeerPhase;
};

interface PendingSendEntry {
    payload: AnyRecord;
    firstSentAt: number;
    lastSentAt: number;
}

interface UseMeetingStateParams {
    meetingId: number | string;
    code?: string;
    ws: WebSocket | null;
    initialMuted?: boolean;
    initialVideoOff?: boolean;
    keepAliveOnUnmount?: boolean;
    existingStream?: MediaStream | null;
}

/**
 * Generate a stable, collision-resistant id for in-flight chat messages.
 */
function newClientMsgId(): string {
    if (
        typeof crypto !== "undefined" &&
        typeof crypto.randomUUID === "function"
    ) {
        return crypto.randomUUID();
    }
    return `m_${Date.now().toString(36)}_${Math.random()
        .toString(36)
        .slice(2, 10)}`;
}

/** How long an outgoing message can sit in the pending-send queue before we
 *  surface it as `_failed` in the UI. */
const PENDING_SEND_FAIL_AFTER_MS = 10_000;
/** Retry cadence for the pending-send queue when WS is OPEN. */
const PENDING_SEND_RETRY_EVERY_MS = 3_000;
/** Phase 2.3 (G4) — cap on the outbound mesh-signal queue so a long offline
 *  window can't grow it unbounded. Oldest frames are dropped first. */
const OUTBOUND_QUEUE_MAX = 500;
/** Phase 3.2 (G5) — per-peer connect timeout. If a peer hasn't reached
 *  `connected` within this window (through the initial STUN attempt AND the
 *  relay-first fast-retry from 3.1), we stop the infinite spinner and surface a
 *  "Couldn't connect — Retry" tile so the user can trigger a manual rebuild. */
const PEER_CONNECT_TIMEOUT_MS = 30_000;

/** Phase 4.1 — Bandwidth governor. A WebRTC mesh uploads N−1 copies of our
 *  video, so the per-peer video cap must shrink as the call grows to keep the
 *  single uplink from saturating (saturation starves audio → the "laggy"
 *  report). Audio is ALWAYS prioritized (Opus, capped separately at
 *  `AUDIO_MAX_BITRATE`, never governed down by peer count). Tiered caps are
 *  shared verbatim with mobile `useMeetingMesh.videoBitrateForPeerCount`:
 *    ≤3 remote peers → 500 kbps, 4–6 → 300 kbps, 7+ → 150 kbps.
 *  `peerCount` here is the number of REMOTE peers (N−1). */
function videoBitrateForPeerCount(peerCount: number): number {
    if (peerCount <= 3) return 500_000;
    if (peerCount <= 6) return 300_000;
    return 150_000;
}
/** Phase 4.1 — Opus audio cap. Prioritized: never governed down by peer count
 *  so voice always survives even when video is squeezed at high counts. */
const AUDIO_MAX_BITRATE = 48_000;

/** Phase 4.2 — Active-speaker-driven video at high counts. A mesh only carries
 *  ~5–6 reliable video streams, so once the REMOTE-peer count exceeds this
 *  threshold we stop asking every peer for full video and demote the
 *  non-priority tiles to `q` (thumbnail → effectively audio+avatar). Below the
 *  threshold everyone keeps mid/full video (`h`/`f`). */
const HIGH_COUNT_VIDEO_THRESHOLD = 6;
/** Phase 4.2 — how long a peer stays in the "recent speaker" priority set after
 *  it last held the floor, so brief pauses don't instantly drop them to a
 *  thumbnail (avoids quality thrash during back-and-forth conversation). */
const RECENT_SPEAKER_WINDOW_MS = 12_000;
/** Phase 4.2 — cap on how many peers may hold full video simultaneously at high
 *  counts (presenter + dominant/recent speakers). Keeps the aggregate downlink
 *  bounded — "only the dominant speaker + a few". */
const MAX_PRIORITY_VIDEO_PEERS = 4;

const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    { urls: "stun:stun2.l.google.com:19302" },
    {
        urls: "turn:openrelay.metered.ca:443?transport=tcp",
        username: "openrelayproject",
        credential: "openrelayproject",
    },
];

// Phase 2.4 (G6) — Deterministic ICE-config gating + public-TURN policy, ported
// from the proven 1:1 path (useWebRTC.ts P1.8/P1.9). These are the two mesh
// equivalents:
//   • hasRealTurn — a config carries "real" (provisioned) TURN only when the
//     server returned managed creds (Cloudflare Calls / self-hosted coturn /
//     a static provider) rather than the public Open Relay fallback or STUN.
//     The server's `mode` is authoritative; when absent we sniff for a
//     non-openrelay turn:/turns: URL. The FIRST mesh offer/answer must never
//     negotiate against the public-only fallback — on a network that requires a
//     relay this makes the first join hang ("Connecting…") even though a retry
//     works once real creds are cached.
//   • applyPublicTurnPolicy — when the server forbids the public fallback
//     (`allowPublicFallback === false` / DISABLE_PUBLIC_TURN), strip the public
//     openrelay.metered.ca TURN URLs from the ICE list we hand to
//     RTCPeerConnection. STUN is ALWAYS kept.
const REAL_TURN_MODES = new Set(["cloudflare-calls", "coturn-rest", "static"]);

function hasRealTurn(
    cfg: { mode?: string; iceServers?: RTCIceServer[] } | null | undefined,
): boolean {
    if (!cfg) return false;
    if (cfg.mode && REAL_TURN_MODES.has(cfg.mode)) return true;
    const servers = cfg.iceServers || [];
    for (const s of servers) {
        const urls = Array.isArray(s?.urls) ? s.urls : [s?.urls];
        for (const u of urls) {
            if (typeof u !== "string") continue;
            const lower = u.toLowerCase();
            if (
                (lower.startsWith("turn:") || lower.startsWith("turns:")) &&
                !lower.includes("openrelay.metered.ca")
            ) {
                return true;
            }
        }
    }
    return false;
}

function applyPublicTurnPolicy(
    servers: RTCIceServer[],
    allowPublic: boolean,
): RTCIceServer[] {
    if (allowPublic) return servers;
    const out: RTCIceServer[] = [];
    for (const s of servers || []) {
        const urls = Array.isArray(s?.urls) ? s.urls : [s?.urls];
        const kept = urls.filter(
            (u) =>
                typeof u === "string" &&
                !u.toLowerCase().includes("openrelay.metered.ca"),
        );
        if (kept.length === 0) continue; // entry was entirely public TURN — drop it
        out.push({ ...s, urls: kept.length === 1 ? kept[0] : kept });
    }
    return out;
}

// Phase 5.1 — per-peer state-machine dispatch. Drives an ExtendedPC's `_phase`
// through the pure `peerConnectionReducer`. The reducer's `closed` phase is
// ABSORBING, so once a PC instance is marked CLOSED any later event (e.g. a late
// CONNECTED / ontrack from the connection being torn down) is a no-op on THAT
// instance — a rebuilt PC is a fresh instance with its own `_phase`, so this
// only kills the dead one. Returns the new phase so call sites can guard on it.
function dispatchPeerPhase(pc: ExtendedPC, event: PeerEvent): PeerPhase {
    pc._phase = peerConnectionReducer(pc._phase ?? initialPeerPhase(), event);
    return pc._phase;
}

function buildMeetingMediaProfiles(
    wantVideo: boolean,
): MediaStreamConstraints[] {
    const audio = {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
    };
    if (!wantVideo) return [{ audio, video: false }];
    const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
    if (isMobile) {
        return [
            {
                audio,
                video: {
                    width: { ideal: 640 },
                    height: { ideal: 480 },
                    frameRate: { ideal: 24, max: 30 },
                },
            },
            { audio, video: true },
            { audio, video: false },
        ];
    }
    return [
        {
            audio,
            video: {
                width: { ideal: 1280 },
                height: { ideal: 720 },
                frameRate: { ideal: 30, max: 30 },
            },
        },
        {
            audio,
            video: {
                width: { ideal: 640 },
                height: { ideal: 480 },
                frameRate: { ideal: 24, max: 30 },
            },
        },
        {
            audio,
            video: {
                width: { ideal: 320 },
                height: { ideal: 240 },
                frameRate: { ideal: 15, max: 24 },
            },
        },
        { audio, video: true },
        { audio, video: false },
    ];
}

async function acquireMeetingMedia(wantVideo: boolean): Promise<MediaStream> {
    if (!navigator.mediaDevices?.getUserMedia)
        throw new Error("NoMediaDevices");
    const profiles = buildMeetingMediaProfiles(wantVideo);
    let lastError: unknown;
    for (let i = 0; i < profiles.length; i++) {
        try {
            const st = await navigator.mediaDevices.getUserMedia(profiles[i]);
            if (i > 0)
                console.warn(
                    "[meeting] media acquired with reduced profile #" + i,
                );
            return st;
        } catch (err) {
            lastError = err;
        }
    }
    throw lastError;
}

/**
 * Core meeting state hook — handles media, WebRTC mesh, signaling, and chat.
 * Optimized: no background effects, stable WS handler (no presenterId dep).
 */
export function useMeetingState({
    meetingId,
    code,
    ws,
    initialMuted = false,
    initialVideoOff = false,
    keepAliveOnUnmount = false,
    existingStream = null,
}: UseMeetingStateParams) {
    const { user } = useAuth();

    const [localStream, setLocalStream] = useState<MediaStream | null>(null);
    const [screenStream, setScreenStream] = useState<MediaStream | null>(null);
    const [muted, setMuted] = useState(initialMuted);
    const [videoOff, setVideoOff] = useState(initialVideoOff);
    const [screenSharing, setScreenSharing] = useState(false);
    const [participants, setParticipants] = useState<
        Map<number | string, Participant>
    >(new Map());
    const [presenterId, setPresenterId] = useState<number | string | null>(
        null,
    );
    // Phase 5 — Active speaker.
    const [activeSpeakerId, setActiveSpeakerId] = useState<
        number | string | null
    >(null);
    const audioLevelsRef = useRef<
        Map<number | string, { level: number; at: number }>
    >(new Map());
    const requestedQualityRef = useRef<Map<number | string, string>>(new Map());
    const lastRequestSentRef = useRef<Map<number | string, string>>(new Map());
    // Phase 4.2 — recent-speaker ledger: userId → last time that peer held the
    // floor (was the dominant speaker). Used by the high-count demotion policy to
    // keep a peer at full video for `RECENT_SPEAKER_WINDOW_MS` after they last
    // spoke, so brief conversational pauses don't thrash their tile down to a
    // thumbnail and back.
    const recentSpeakersRef = useRef<Map<number | string, number>>(new Map());
    const [activePanel, setActivePanel] = useState<string | null>(null);
    const [messages, setMessages] = useState<MeetingMessage[]>(
        () => getCachedMessages(code || "") as MeetingMessage[],
    );
    const [status, setStatus] = useState("joining");
    const [fsmState, setFsmState] = useState<MeetingState>(STATES.IDLE);
    const fsmStateRef = useRef(fsmState);
    fsmStateRef.current = fsmState;
    const dispatchFsm = useCallback((event: string) => {
        const cur = fsmStateRef.current;
        const next = fsmNext(cur, event);
        if (next !== cur) {
            setFsmState(next);
            const legacy =
                next === STATES.RECONNECTING || next === STATES.DEGRADED
                    ? "connecting"
                    : next;
            setStatus(legacy);
        }
    }, []);
    const [raisedHand, setRaisedHand] = useState(false);
    const [connectionQualities, setConnectionQualities] = useState<
        Map<number | string, string>
    >(new Map());
    const [mediaReady, setMediaReady] = useState(!!existingStream);

    const localStreamRef = useRef<MediaStream | null>(null);
    const screenStreamRef = useRef<MediaStream | null>(null);
    const pcsRef = useRef<Map<number | string, ExtendedPC>>(new Map());
    const pendingSignals = useRef<Map<number | string, AnyRecord[]>>(new Map());
    const qualityTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const wsRef = useRef<WebSocket | null>(ws);
    wsRef.current = ws;
    const iceServersRef = useRef<RTCIceServer[]>(DEFAULT_ICE_SERVERS);
    const iceExpiresAtRef = useRef(0);
    // Phase 2.4 (G6) — deterministic ICE-config gating state (ported from the
    // 1:1 path). `iceHasRealTurnRef`: the loaded config carries real provisioned
    // TURN (not public Open Relay / STUN-only). `iceAllowPublicRef`: the server
    // permits the public Open Relay fallback (default true for older servers).
    // `firstNegotiationStartedRef`: the very first mesh offer/answer has begun
    // (only that one is gated on genuine TURN). `initialIceConfigLoadedRef`: a
    // live /ice-config fetch has resolved at least once.
    const iceHasRealTurnRef = useRef(false);
    const iceAllowPublicRef = useRef(true);
    const firstNegotiationStartedRef = useRef(false);
    const initialIceConfigLoadedRef = useRef(false);
    const relayOnlyPeersRef = useRef<Set<number | string>>(new Set());
    const iceRestartCountsRef = useRef<Map<number | string, number>>(new Map());
    // Phase 2.2 — reliable-delivery handshake guards. `subscribedRef` ensures we
    // send `meeting_subscribe` once per WS connection (reset on reconnect via the
    // open handler); `readySentRef` ensures `meeting_ready` is sent once our PCs
    // are built.
    const subscribedRef = useRef(false);
    const readySentRef = useRef(false);
    const presenterIdRef = useRef(presenterId);
    presenterIdRef.current = presenterId;
    const mutedRef = useRef(muted);
    mutedRef.current = muted;
    const videoOffRef = useRef(videoOff);
    videoOffRef.current = videoOff;
    const screenSharingRef = useRef(screenSharing);
    screenSharingRef.current = screenSharing;

    useEffect(() => {
        if (code) setCachedMessages(code, messages);
    }, [code, messages]);

    const pendingSendsRef = useRef<Map<string, PendingSendEntry>>(new Map());

    // Phase 2.3 (G4) — outbound mesh-signal queue. When the WS is not OPEN
    // (reconnecting / brief blip) `wsSend` enqueues the frame instead of
    // dropping it; `flushOutboundQueue` replays it on the next `open`. This
    // mirrors the queue-on-closed / flush-on-open guarantee the 1:1 path gets
    // from the shared `useWebSocket` sendMessage. Without it, an offer/ICE
    // candidate produced during a reconnect window was silently lost, leaving a
    // peer stuck in "connecting".
    const outboundQueueRef = useRef<Array<{ type: string; data?: unknown }>>(
        [],
    );

    const flushOutboundQueue = useCallback(() => {
        const w = wsRef.current;
        if (!w || w.readyState !== 1) return;
        const queued = outboundQueueRef.current;
        if (queued.length === 0) return;
        outboundQueueRef.current = [];
        for (const frame of queued) {
            try {
                w.send(JSON.stringify(frame));
            } catch {
                /* ignore — re-queueing here risks an infinite loop on a
                   half-open socket; the periodic handshake will recover */
            }
        }
    }, []);

    const markMessageStatus = useCallback(
        (clientMsgId: string | null | undefined, patch: AnyRecord) => {
            if (!clientMsgId) return;
            setMessages((prev) => {
                const idx = prev.findIndex(
                    (m) => m.clientMsgId === clientMsgId,
                );
                if (idx < 0) return prev;
                const next = prev.slice();
                next[idx] = { ...next[idx], ...patch };
                return next;
            });
        },
        [],
    );

    const replaceVideoTrackOnPeers = useCallback(
        async (newTrack: MediaStreamTrack | null) => {
            const tasks: Promise<void>[] = [];
            for (const [, pc] of pcsRef.current) {
                const sender = pc
                    .getSenders()
                    .find((s) => s.track?.kind === "video");
                if (sender)
                    tasks.push(
                        sender.replaceTrack(newTrack || null).catch(() => {}),
                    );
            }
            await Promise.all(tasks);
        },
        [],
    );

    const wsSend = useCallback((type: string, data?: unknown) => {
        const w = wsRef.current;
        if (w && w.readyState === 1) {
            try {
                w.send(JSON.stringify({ type, data }));
                return;
            } catch {
                /* fall through to queue on a transient send failure */
            }
        }
        // Phase 2.3 (G4) — socket not OPEN (or send threw): queue instead of
        // dropping so the frame is replayed on the next `open`. Bound the queue
        // and evict oldest first so a long offline window can't grow it
        // unbounded.
        const q = outboundQueueRef.current;
        q.push({ type, data });
        if (q.length > OUTBOUND_QUEUE_MAX)
            q.splice(0, q.length - OUTBOUND_QUEUE_MAX);
    }, []);

    const applyQualityCapForPeer = useCallback((peerId: number | string) => {
        const pc = pcsRef.current.get(peerId);
        if (!pc) return;
        const level = requestedQualityRef.current.get(peerId) || "h";
        // Phase 4.1 — the per-peer quality request ("f"/"h"/"q") is now bounded
        // by the bandwidth governor's ceiling for the current call size, so a
        // remote asking for "full" can't push our uplink past what N−1 peers can
        // afford. `f` → ceiling (the active speaker / presenter gets the best the
        // call size allows), `h` → half-step, `q` → thumbnail floor. Audio is
        // never governed here (only video senders are touched below).
        const ceiling = videoBitrateForPeerCount(pcsRef.current.size);
        const maxBitrate =
            level === "q"
                ? Math.min(150_000, ceiling)
                : level === "h"
                  ? Math.min(300_000, ceiling)
                  : ceiling;
        for (const sender of pc.getSenders()) {
            if (!sender.track || sender.track.kind !== "video") continue;
            try {
                const params = sender.getParameters();
                if (!params.encodings || params.encodings.length === 0)
                    params.encodings = [{}];
                params.encodings[0].maxBitrate = maxBitrate;
                sender.setParameters(params).catch(() => {});
            } catch {
                /* ignore */
            }
        }
    }, []);

    const requestPeerQuality = useCallback(
        (peerId: number | string, level: string) => {
            if (!peerId || !["q", "h", "f"].includes(level)) return;
            if (lastRequestSentRef.current.get(peerId) === level) return;
            lastRequestSentRef.current.set(peerId, level);
            wsSend("meeting_request_quality", {
                meetingId,
                targetUserId: peerId,
                level,
            });
        },
        [meetingId, wsSend],
    );

    // Acquire local media
    useEffect(() => {
        if (existingStream) {
            localStreamRef.current = existingStream;
            const audioEnabled = existingStream
                .getAudioTracks()
                .some((t) => t.enabled);
            const videoEnabled = existingStream
                .getVideoTracks()
                .some((t) => t.enabled);
            setMuted(!audioEnabled);
            setVideoOff(!videoEnabled);
            setLocalStream(existingStream);
            setMediaReady(true);
            return;
        }
        let stream: MediaStream | undefined;
        let cancelled = false;
        (async () => {
            try {
                const st = await acquireMeetingMedia(!initialVideoOff);
                if (cancelled) {
                    st.getTracks().forEach((t) => t.stop());
                    return;
                }
                stream = st;
                st.getAudioTracks().forEach((t) => {
                    t.enabled = !initialMuted;
                });
                if (st.getVideoTracks().length === 0) setVideoOff(true);
                localStreamRef.current = st;
                setLocalStream(st);
                setMediaReady(true);
            } catch {
                if (cancelled) return;
                setMuted(true);
                setVideoOff(true);
                setMediaReady(true);
            }
        })();
        return () => {
            cancelled = true;
            if (!keepAliveOnUnmount && stream)
                stream.getTracks().forEach((t) => t.stop());
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Phase 2.4 (G6) — ICE-config refresh that ALSO records the public-TURN
    // policy (`allowPublicFallback`) + whether the config carries real,
    // provisioned TURN (`hasRealTurn`) so the first-negotiation gate below can
    // decide whether to keep (briefly) waiting for genuine creds. Mirrors
    // useWebRTC.ts `refreshIceConfig`.
    const refreshIceConfig = useCallback(async () => {
        try {
            const { data } = await retryWithBackoff(() => getIceConfig(), {
                maxAttempts: 4,
                baseDelayMs: 300,
                maxDelayMs: 4_000,
            });
            const d = data as {
                iceServers?: RTCIceServer[];
                expiresAt?: number;
                mode?: string;
                allowPublicFallback?: boolean;
            };
            if (d?.iceServers?.length) {
                iceServersRef.current = d.iceServers;
                iceExpiresAtRef.current = d.expiresAt || 0;
                initialIceConfigLoadedRef.current = true;
                // Absent on older servers → treated as allowed (backwards-compat).
                iceAllowPublicRef.current = d.allowPublicFallback !== false;
                iceHasRealTurnRef.current = hasRealTurn(d);
            }
        } catch {
            /* keep defaults */
        }
    }, []);

    // Phase 2.4 (G6) — deterministic gate. Stage 1: wait for ANY config to
    // load. Stage 2 (FIRST negotiation only): additionally wait — bounded to
    // ~1.5s — for real, provisioned TURN, re-fetching once, so the initial mesh
    // offer/answer never negotiates against the public-only fallback (which
    // makes the first join hang on a relay-required network). A later
    // ICE-restart / renegotiation proceeds promptly with whatever creds we have.
    const waitForIceConfig = useCallback(
        async (timeoutMs = 2000) => {
            const start = Date.now();
            if (!initialIceConfigLoadedRef.current) {
                while (
                    !initialIceConfigLoadedRef.current &&
                    Date.now() - start < timeoutMs
                ) {
                    await new Promise((r) => setTimeout(r, 100));
                }
            }
            if (
                !firstNegotiationStartedRef.current &&
                !iceHasRealTurnRef.current
            ) {
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

    // Fetch ICE config on mount + proactively refresh before creds expire.
    useEffect(() => {
        refreshIceConfig();
        const t = setInterval(() => {
            if (
                iceExpiresAtRef.current &&
                iceExpiresAtRef.current - Math.floor(Date.now() / 1000) < 300
            )
                refreshIceConfig();
        }, 60_000);
        return () => clearInterval(t);
    }, [refreshIceConfig]);

    // ─── Devicechange listener ───
    useEffect(() => {
        if (!navigator.mediaDevices?.addEventListener) return;
        const onChange = async () => {
            try {
                const vt =
                    localStreamRef.current?.getVideoTracks?.()[0] || null;
                if (vt && vt.readyState === "ended") {
                    await replaceVideoTrackOnPeers(null);
                    setVideoOff(true);
                }
                wsSend("meeting_track_state", {
                    meetingId,
                    muted: mutedRef.current,
                    videoOff: videoOffRef.current,
                    screenSharing: screenSharingRef.current,
                });
            } catch {
                /* best-effort */
            }
        };
        navigator.mediaDevices.addEventListener("devicechange", onChange);
        return () => {
            try {
                navigator.mediaDevices.removeEventListener(
                    "devicechange",
                    onChange,
                );
            } catch {
                /* ignore */
            }
        };
    }, [meetingId, replaceVideoTrackOnPeers, wsSend]);

    // ─── Network online/offline → FSM ───
    useEffect(() => {
        const onOnline = () => dispatchFsm("network_online");
        const onOffline = () => dispatchFsm("network_offline");
        window.addEventListener("online", onOnline);
        window.addEventListener("offline", onOffline);
        return () => {
            window.removeEventListener("online", onOnline);
            window.removeEventListener("offline", onOffline);
        };
    }, [dispatchFsm]);

    // ─── WS open/close → FSM ───
    useEffect(() => {
        if (!ws) return;
        const onOpen = () => dispatchFsm("ws_open");
        const onClose = () => dispatchFsm("ws_close");
        ws.addEventListener("open", onOpen);
        ws.addEventListener("close", onClose);
        if (ws.readyState === 1) dispatchFsm("ws_open");
        else if (ws.readyState >= 2) dispatchFsm("ws_close");
        return () => {
            try {
                ws.removeEventListener("open", onOpen);
            } catch {
                /* ignore */
            }
            try {
                ws.removeEventListener("close", onClose);
            } catch {
                /* ignore */
            }
        };
    }, [ws, dispatchFsm]);

    // ─── Hydrate chat history ───
    useEffect(() => {
        if (!code) return;
        let cancelled = false;
        const hydrate = () => {
            getMeetingMessages(code)
                .then((res) => {
                    if (cancelled) return;
                    const history = (
                        Array.isArray(res.data) ? res.data : []
                    ) as MeetingMessage[];
                    if (!history.length) return;
                    setMessages((prev) => {
                        const seenIds = new Set(
                            prev
                                .filter((m) => m.id != null)
                                .map((m) => m.id),
                        );
                        const seenClientIds = new Set(
                            prev
                                .filter((m) => m.clientMsgId)
                                .map((m) => m.clientMsgId),
                        );
                        const merged: MeetingMessage[] = [
                            ...history
                                .filter(
                                    (m) =>
                                        (m.id == null ||
                                            !seenIds.has(m.id)) &&
                                        (!m.client_msg_id ||
                                            !seenClientIds.has(
                                                m.client_msg_id as string,
                                            )),
                                )
                                .map((m) => ({
                                    ...m,
                                    clientMsgId:
                                        (m.client_msg_id as string) ||
                                        m.clientMsgId,
                                })),
                            ...prev,
                        ];
                        merged.sort((a, b) =>
                            String(a.created_at || "").localeCompare(
                                String(b.created_at || ""),
                            ),
                        );
                        return merged;
                    });
                })
                .catch(() => {
                    /* silent */
                });
        };

        hydrate();

        if (ws) {
            const onOpen = () => hydrate();
            ws.addEventListener("open", onOpen);
            return () => {
                cancelled = true;
                try {
                    ws.removeEventListener("open", onOpen);
                } catch {
                    /* ignore */
                }
            };
        }
        return () => {
            cancelled = true;
        };
    }, [code, ws]);

    // Safety net: add tracks to peer connections
    useEffect(() => {
        if (!localStreamRef.current) return;
        const stream = localStreamRef.current;
        for (const [peerId, pc] of pcsRef.current) {
            const senders = pc.getSenders().filter((s) => s.track);
            if (senders.length === 0 && stream.getTracks().length > 0) {
                stream.getTracks().forEach((track) => {
                    pc.addTrack(track, stream);
                    if (track.kind === "video") {
                        try {
                            (track as any).contentHint = "motion";
                        } catch {
                            /* not supported */
                        }
                    }
                });
                if (pc.signalingState === "stable") {
                    pc.createOffer()
                        .then((offer) => pc.setLocalDescription(offer))
                        .then(() =>
                            wsSend("meeting_signal", {
                                meetingId,
                                targetUserId: peerId,
                                signal: {
                                    type: "offer",
                                    sdp: pc.localDescription,
                                },
                            }),
                        )
                        .catch(console.error);
                }
            }
        }
    }, [localStream, meetingId, wsSend]);

    // Quality monitoring (every 8s)
    useEffect(() => {
        qualityTimerRef.current = setInterval(async () => {
            const qMap = new Map<number | string, string>();
            for (const [userId, pc] of pcsRef.current) {
                try {
                    const stats = await pc.getStats();
                    let totalPacketLoss = 0,
                        rtt = 0,
                        count = 0;
                    stats.forEach((s: any) => {
                        if (s.type === "inbound-rtp") {
                            const total =
                                (s.packetsReceived || 0) +
                                (s.packetsLost || 0);
                            if (total > 0) {
                                totalPacketLoss += s.packetsLost / total;
                                count++;
                            }
                        }
                        if (
                            s.type === "candidate-pair" &&
                            s.state === "succeeded"
                        )
                            rtt = (s.currentRoundTripTime || 0) * 1000;
                    });
                    const avgLoss = count > 0 ? totalPacketLoss / count : 0;
                    qMap.set(
                        userId,
                        rtt < 100 && avgLoss < 0.02
                            ? "good"
                            : rtt < 250 && avgLoss < 0.08
                              ? "medium"
                              : "poor",
                    );
                } catch {
                    /* ignore */
                }
            }
            setConnectionQualities(new Map(qMap));
        }, 8000);
        return () => {
            if (qualityTimerRef.current)
                clearInterval(qualityTimerRef.current);
        };
    }, []);

    // Create peer connection
    const createPeerConnection = useCallback(
        (
            remoteUserId: number | string,
            isInitiator: boolean,
        ): ExtendedPC | null => {
            const existing = pcsRef.current.get(remoteUserId);
            if (
                existing &&
                existing.connectionState !== "closed" &&
                existing.connectionState !== "failed"
            )
                return existing;
            if (existing) {
                try {
                    existing.close();
                } catch {
                    /* ignore */
                }
            }

            const pcConfig: RTCConfiguration = {
                // Phase 2.4 (G6) — strip the public Open Relay TURN entries when
                // the server forbids the public fallback. STUN is always kept.
                iceServers: applyPublicTurnPolicy(
                    iceServersRef.current,
                    iceAllowPublicRef.current,
                ),
                bundlePolicy: "max-bundle",
                rtcpMuxPolicy: "require",
                iceCandidatePoolSize: 4,
            };
            if (relayOnlyPeersRef.current.has(remoteUserId))
                pcConfig.iceTransportPolicy = "relay";

            let pc: ExtendedPC;
            try {
                pc = new RTCPeerConnection(pcConfig) as ExtendedPC;
            } catch {
                return null;
            }
            // Perfect Negotiation (Phase 2.1): deterministic politeness per peer.
            // The lexicographically-greater id is the POLITE peer (rolls back on
            // an offer collision); the other is IMPOLITE (ignores the colliding
            // offer, keeps its own). Stable + symmetric so both sides agree.
            pc._polite = String(user?.id ?? "") > String(remoteUserId);
            pc._makingOffer = false;
            pc._isSettingRemoteAnswerPending = false;
            // Phase 5.1 — fresh PC starts in `connecting`. Transitions run
            // through `dispatchPeerPhase` (the pure reducer) at each lifecycle
            // point; the `closed` phase is absorbing so a late `connected` from
            // THIS instance being torn down can't revive a removed tile.
            pc._phase = initialPeerPhase();
            pcsRef.current.set(remoteUserId, pc);

            if (localStreamRef.current) {
                localStreamRef.current.getTracks().forEach((track) => {
                    pc.addTrack(track, localStreamRef.current as MediaStream);
                    if (track.kind === "video") {
                        try {
                            (track as any).contentHint = "motion";
                        } catch {
                            /* not supported */
                        }
                    }
                });
            }

            setTimeout(() => {
                // Phase 4.1 — bandwidth governor. `pcsRef.current.size` is the
                // number of REMOTE peers (each PC = one remote), so this is the
                // N−1 uplink-fan-out count the ladder is tuned for. Audio is
                // pinned at `AUDIO_MAX_BITRATE` and never scaled down.
                const peerCount = pcsRef.current.size;
                const videoBitrate = videoBitrateForPeerCount(peerCount);
                for (const sender of pc.getSenders()) {
                    if (!sender.track) continue;
                    try {
                        const params = sender.getParameters();
                        if (
                            !params.encodings ||
                            params.encodings.length === 0
                        )
                            params.encodings = [{}];
                        if (sender.track.kind === "video") {
                            params.encodings[0].maxBitrate = videoBitrate;
                            params.degradationPreference =
                                "maintain-framerate";
                        } else {
                            params.encodings[0].maxBitrate =
                                AUDIO_MAX_BITRATE;
                        }
                        sender.setParameters(params).catch(() => {});
                    } catch {
                        /* ignore */
                    }
                }
            }, 0);

            const remoteStream = new MediaStream();
            const remoteScreenStream = new MediaStream();
            pc._remoteStream = remoteStream;
            pc._remoteScreenStream = remoteScreenStream;
            pc._screenTrackIds = new Set();

            const reclassifyTracks = () => {
                for (const t of [...remoteStream.getTracks()]) {
                    if (pc._screenTrackIds!.has(t.id)) {
                        try {
                            remoteStream.removeTrack(t);
                        } catch {
                            /* ignore */
                        }
                        if (
                            !remoteScreenStream
                                .getTracks()
                                .some((x) => x.id === t.id)
                        ) {
                            remoteScreenStream.addTrack(t);
                        }
                    }
                }
                for (const t of [...remoteScreenStream.getTracks()]) {
                    if (!pc._screenTrackIds!.has(t.id)) {
                        try {
                            remoteScreenStream.removeTrack(t);
                        } catch {
                            /* ignore */
                        }
                        if (
                            !remoteStream
                                .getTracks()
                                .some((x) => x.id === t.id)
                        ) {
                            remoteStream.addTrack(t);
                        }
                    }
                }
            };
            pc._reclassifyTracks = reclassifyTracks;

            pc.ontrack = (e) => {
                // Phase 5.1 — terminal-absorption guard. If this PC instance was
                // already closed (participant_left / teardown), a late `ontrack`
                // from the connection being torn down must NOT re-`upsert` the
                // removed tile.
                if (isPeerTerminal(pc._phase ?? initialPeerPhase())) return;
                if (
                    !remoteStream
                        .getTracks()
                        .some((t) => t.id === e.track.id) &&
                    !remoteScreenStream
                        .getTracks()
                        .some((t) => t.id === e.track.id)
                ) {
                    remoteStream.addTrack(e.track);
                }
                reclassifyTracks();

                e.track.onended = () => {
                    try {
                        remoteStream.removeTrack(e.track);
                    } catch {
                        /* ignore */
                    }
                    try {
                        remoteScreenStream.removeTrack(e.track);
                    } catch {
                        /* ignore */
                    }
                    pc._screenTrackIds!.delete(e.track.id);
                    setParticipants((prev) => {
                        const next = new Map(prev);
                        const ex = next.get(remoteUserId);
                        if (ex)
                            next.set(remoteUserId, {
                                ...ex,
                                stream: remoteStream,
                                screenStream: remoteScreenStream,
                            });
                        return next;
                    });
                };

                const hasVideo = remoteStream
                    .getVideoTracks()
                    .some((t) => t.readyState === "live");
                setParticipants((prev) => {
                    const next = new Map(prev);
                    const ex = next.get(remoteUserId) || {
                        userId: remoteUserId,
                    };
                    next.set(remoteUserId, {
                        ...ex,
                        stream: remoteStream,
                        screenStream: remoteScreenStream,
                        ...(hasVideo ? { videoOff: false } : {}),
                    });
                    return next;
                });
            };

            pc.onicecandidate = (e) => {
                if (e.candidate)
                    wsSend("meeting_signal", {
                        meetingId,
                        targetUserId: remoteUserId,
                        signal: { type: "candidate", candidate: e.candidate },
                    });
            };

            pc.oniceconnectionstatechange = () => {
                if (pc.iceConnectionState === "disconnected") {
                    setTimeout(() => {
                        if (
                            pc.iceConnectionState === "disconnected" &&
                            pc.signalingState === "stable"
                        ) {
                            const cnt =
                                iceRestartCountsRef.current.get(
                                    remoteUserId,
                                ) || 0;
                            if (cnt < 3) {
                                iceRestartCountsRef.current.set(
                                    remoteUserId,
                                    cnt + 1,
                                );
                                pc.createOffer({ iceRestart: true })
                                    .then((o) => pc.setLocalDescription(o))
                                    .then(() =>
                                        wsSend("meeting_signal", {
                                            meetingId,
                                            targetUserId: remoteUserId,
                                            signal: {
                                                type: "offer",
                                                sdp: pc.localDescription,
                                            },
                                        }),
                                    )
                                    .catch(() => {});
                            }
                        }
                    }, 2000);
                }
            };

            pc.onconnectionstatechange = () => {
                const state = pc.connectionState;
                // Phase 5.1 — terminal-absorption guard. Once THIS PC instance
                // has been closed (participant_left / teardown dispatched CLOSED),
                // a LATE connectionState transition from the connection being torn
                // down (classically a "connected" landing a beat after we removed
                // the tile) must be a no-op — it can neither revive the removed
                // participant nor flip global status back to connected.
                if (isPeerTerminal(pc._phase ?? initialPeerPhase())) return;
                // Phase 5.1 — record the live phase through the pure reducer.
                if (state === "connected")
                    dispatchPeerPhase(pc, { type: "CONNECTED" });
                else if (state === "failed")
                    dispatchPeerPhase(pc, { type: "FAILED" });
                else if (state === "disconnected" && pc._phase === "connected")
                    dispatchPeerPhase(pc, { type: "RECONNECTING" });
                setParticipants((prev) => {
                    const next = new Map(prev);
                    const ex = next.get(remoteUserId);
                    if (ex && ex.connectionState !== state) {
                        next.set(remoteUserId, {
                            ...ex,
                            connectionState: state,
                        });
                        return next;
                    }
                    return prev;
                });

                if (pc.connectionState === "connected") {
                    setStatus("connected");
                    dispatchFsm("peer_connected");
                    iceRestartCountsRef.current.delete(remoteUserId);
                    if (pc._disconnectTimer) {
                        clearTimeout(pc._disconnectTimer);
                        pc._disconnectTimer = null;
                    }
                    // Phase 3.1 (P4.19) — connected in time; cancel the
                    // relay-first fast-retry so it can't tear down a good PC.
                    if (pc._relayRetryTimer) {
                        clearTimeout(pc._relayRetryTimer);
                        pc._relayRetryTimer = null;
                    }
                    // Phase 3.2 (G5) — connected in time; cancel the 30s connect
                    // timeout and clear any prior `connectFailed` flag on the tile.
                    if (pc._connectTimeoutTimer) {
                        clearTimeout(pc._connectTimeoutTimer);
                        pc._connectTimeoutTimer = null;
                    }
                    setParticipants((prev) => {
                        const n = new Map(prev);
                        const p = n.get(remoteUserId);
                        if (p && p.connectFailed) {
                            n.set(remoteUserId, {
                                ...p,
                                connectFailed: false,
                            });
                            return n;
                        }
                        return prev;
                    });
                    wsSend("meeting_track_state", {
                        meetingId,
                        muted: mutedRef.current,
                        videoOff: videoOffRef.current,
                        screenSharing: screenSharingRef.current,
                    });
                } else if (pc.connectionState === "failed") {
                    dispatchFsm("peer_failed");
                    // Phase 3.1 (P4.19) — the fast-retry timer is redundant once
                    // we've reached `failed`; the failed-rebuild below covers it.
                    if (pc._relayRetryTimer) {
                        clearTimeout(pc._relayRetryTimer);
                        pc._relayRetryTimer = null;
                    }
                    setParticipants((prev) => {
                        const n = new Map(prev);
                        const p = n.get(remoteUserId);
                        if (p) {
                            if (p.stream)
                                (p.stream as MediaStream)
                                    .getTracks()
                                    .forEach((t) => t.stop());
                            n.set(remoteUserId, { ...p, stream: null });
                        }
                        return n;
                    });
                    if (!relayOnlyPeersRef.current.has(remoteUserId)) {
                        relayOnlyPeersRef.current.add(remoteUserId);
                        try {
                            pc.close();
                        } catch {
                            /* ignore */
                        }
                        pcsRef.current.delete(remoteUserId);
                        setTimeout(
                            () => createPeerConnection(remoteUserId, true),
                            500,
                        );
                    }
                } else if (pc.connectionState === "disconnected") {
                    dispatchFsm("peer_disconnected");
                    pc._disconnectTimer = setTimeout(() => {
                        if (
                            pc.connectionState === "disconnected" ||
                            pc.connectionState === "failed"
                        ) {
                            setParticipants((prev) => {
                                const n = new Map(prev);
                                const p = n.get(remoteUserId);
                                if (p) {
                                    if (p.stream)
                                        (p.stream as MediaStream)
                                            .getTracks()
                                            .forEach((t) => t.stop());
                                    n.set(remoteUserId, {
                                        ...p,
                                        stream: null,
                                    });
                                }
                                return n;
                            });
                        }
                    }, 5000);
                }
            };

            if (isInitiator) {
                // Mark our offer-in-flight window so a colliding inbound offer
                // arriving before setLocalDescription completes is still detected
                // as glare by the Perfect Negotiation guard in handleSignal.
                pc._makingOffer = true;
                (async () => {
                    try {
                        // Phase 2.4 (G6) — gate the FIRST offer on real TURN so
                        // the initial negotiation never runs against the public-
                        // only fallback. If genuine creds landed during the wait,
                        // refresh the PC's ICE servers via setConfiguration before
                        // gathering begins at setLocalDescription.
                        await waitForIceConfig();
                        try {
                            pc.setConfiguration({
                                iceServers: applyPublicTurnPolicy(
                                    iceServersRef.current,
                                    iceAllowPublicRef.current,
                                ),
                                bundlePolicy: "max-bundle",
                                rtcpMuxPolicy: "require",
                                iceCandidatePoolSize: 4,
                                ...(relayOnlyPeersRef.current.has(remoteUserId)
                                    ? { iceTransportPolicy: "relay" as const }
                                    : {}),
                            });
                        } catch {
                            /* setConfiguration unsupported / not critical */
                        }
                        const offer = await pc.createOffer();
                        await pc.setLocalDescription(offer);
                        wsSend("meeting_signal", {
                            meetingId,
                            targetUserId: remoteUserId,
                            signal: {
                                type: "offer",
                                sdp: pc.localDescription,
                            },
                        });
                    } catch (err) {
                        console.error(err);
                    } finally {
                        pc._makingOffer = false;
                    }
                })();
            }

            // Phase 3.1 (P4.19) — relay-first fast retry. On the INITIAL
            // (non-relay) PC, arm a one-shot ~5s timer: if this peer hasn't
            // reached `connected` by then (a UDP/STUN path a corporate proxy /
            // symmetric NAT silently blackholes), rebuild that ONE peer TURN-only
            // (`iceTransportPolicy:"relay"`, set via `relayOnlyPeersRef`) and
            // re-offer as the initiator. This is faster than waiting for the
            // browser's own ICE-`failed` (15–30s), so relay-required networks
            // connect promptly. Idempotent with the failed-rebuild path via the
            // per-peer `relayOnlyPeersRef` guard; skipped when already relay-only.
            if (!relayOnlyPeersRef.current.has(remoteUserId)) {
                pc._relayRetryTimer = setTimeout(() => {
                    pc._relayRetryTimer = null;
                    if (pcsRef.current.get(remoteUserId) !== pc) return;
                    if (pc.connectionState === "connected") return;
                    if (relayOnlyPeersRef.current.has(remoteUserId)) return;
                    relayOnlyPeersRef.current.add(remoteUserId);
                    try {
                        pc.close();
                    } catch {
                        /* ignore */
                    }
                    pcsRef.current.delete(remoteUserId);
                    createPeerConnection(remoteUserId, true);
                }, 5000);
            }

            // Phase 3.2 (G5) — per-peer 30s connect timeout. Both recovery
            // ladders above (relay-first fast-retry @5s, failed-rebuild) get a
            // chance inside this window. If the peer STILL isn't `connected`
            // after 30s we stop the infinite "Connecting…" spinner and flag the
            // tile `connectFailed` so the user gets a "Couldn't connect — Retry"
            // button (manual rebuild via `retryPeer`) instead of staring at a
            // dead tile. Only armed on the FIRST (non-relay) PC per peer so a
            // relay-rebuild doesn't reset the clock; cleared on connect (above)
            // and on teardown.
            if (!relayOnlyPeersRef.current.has(remoteUserId)) {
                pc._connectTimeoutTimer = setTimeout(() => {
                    pc._connectTimeoutTimer = null;
                    // Check the CURRENT PC for this peer (the relay-first
                    // fast-retry / failed-rebuild may have swapped `pc` for a
                    // fresh relay-only one). If whatever PC is live now has
                    // connected, there's nothing to flag.
                    const cur = pcsRef.current.get(remoteUserId);
                    if (cur && cur.connectionState === "connected") return;
                    setParticipants((prev) => {
                        const n = new Map(prev);
                        const p = n.get(remoteUserId);
                        if (p && p.connectFailed !== true) {
                            n.set(remoteUserId, {
                                ...p,
                                connectFailed: true,
                            });
                            return n;
                        }
                        return prev;
                    });
                }, PEER_CONNECT_TIMEOUT_MS);
            }
            return pc;
        },
        [meetingId, wsSend, dispatchFsm, user?.id, waitForIceConfig],
    );

    // Network change → ICE restart
    useEffect(() => {
        const restartAll = () => {
            for (const [peerId, pc] of pcsRef.current) {
                if (pc.signalingState !== "stable") continue;
                pc.createOffer({ iceRestart: true })
                    .then((o) => pc.setLocalDescription(o))
                    .then(() =>
                        wsSend("meeting_signal", {
                            meetingId,
                            targetUserId: peerId,
                            signal: {
                                type: "offer",
                                sdp: pc.localDescription,
                            },
                        }),
                    )
                    .catch(() => {});
            }
        };
        window.addEventListener("online", restartAll);
        const conn =
            (navigator as any).connection ||
            (navigator as any).mozConnection ||
            (navigator as any).webkitConnection;
        conn?.addEventListener?.("change", restartAll);
        return () => {
            window.removeEventListener("online", restartAll);
            conn?.removeEventListener?.("change", restartAll);
        };
    }, [meetingId, wsSend]);

    const flushPendingSignals = useCallback(
        async (userId: number | string, pc: ExtendedPC) => {
            const pending = pendingSignals.current.get(userId) || [];
            pendingSignals.current.delete(userId);
            for (const sig of pending) {
                try {
                    await handleSignal(userId, pc, sig);
                } catch {
                    /* ignore */
                }
            }
        },
        [], // eslint-disable-line react-hooks/exhaustive-deps
    );

    const handleSignal = useCallback(
        async (
            fromUserId: number | string,
            pc: ExtendedPC,
            signal: AnyRecord,
        ) => {
            if (!pc) return;
            if (signal.type === "offer") {
                // Perfect Negotiation (Phase 2.1) glare guard: an offer arriving
                // while our own offer is in flight (or we're not stable) is a
                // collision. The IMPOLITE peer ignores it (keeps its own offer);
                // the POLITE peer rolls back its local offer then accepts. This
                // governs ALL re-negotiation (video toggle, screen share, ICE
                // restart) and kills the renegotiation-glare deadlock (G3).
                const offerCollision =
                    !!pc._makingOffer || pc.signalingState !== "stable";
                if (offerCollision) {
                    if (!pc._polite) {
                        // Impolite peer — ignore the colliding offer.
                        return;
                    }
                    try {
                        await pc.setLocalDescription({
                            type: "rollback",
                        } as RTCLocalSessionDescriptionInit);
                    } catch {
                        /* some browsers auto-rollback on setRemoteDescription */
                    }
                }
                await pc.setRemoteDescription(
                    new RTCSessionDescription(
                        signal.sdp as RTCSessionDescriptionInit,
                    ),
                );
                // Phase 2.4 (G6) — gate the FIRST answer on real TURN (mirrors
                // the initiator gate) so the initial negotiation never runs
                // against the public-only fallback. Refresh the PC's ICE servers
                // via setConfiguration if genuine creds landed during the wait.
                await waitForIceConfig();
                try {
                    pc.setConfiguration({
                        iceServers: applyPublicTurnPolicy(
                            iceServersRef.current,
                            iceAllowPublicRef.current,
                        ),
                        bundlePolicy: "max-bundle",
                        rtcpMuxPolicy: "require",
                        iceCandidatePoolSize: 4,
                        ...(relayOnlyPeersRef.current.has(fromUserId)
                            ? { iceTransportPolicy: "relay" as const }
                            : {}),
                    });
                } catch {
                    /* setConfiguration unsupported / not critical */
                }
                const answer = await pc.createAnswer();
                await pc.setLocalDescription(answer);
                wsSend("meeting_signal", {
                    meetingId,
                    targetUserId: fromUserId,
                    signal: { type: "answer", sdp: pc.localDescription },
                });
                await flushPendingSignals(fromUserId, pc);
            } else if (signal.type === "answer") {
                if (pc.signalingState === "have-local-offer") {
                    await pc.setRemoteDescription(
                        new RTCSessionDescription(
                            signal.sdp as RTCSessionDescriptionInit,
                        ),
                    );
                    await flushPendingSignals(fromUserId, pc);
                }
            } else if (signal.type === "candidate") {
                if (pc.remoteDescription)
                    await pc.addIceCandidate(
                        new RTCIceCandidate(
                            signal.candidate as RTCIceCandidateInit,
                        ),
                    );
                else {
                    const q = pendingSignals.current.get(fromUserId) || [];
                    q.push(signal);
                    pendingSignals.current.set(fromUserId, q);
                }
            }
        },
        [meetingId, wsSend, flushPendingSignals, waitForIceConfig],
    );

    // STABLE WS handler
    const handleWsMessage = useCallback(
        (msg: { type: string; data: AnyRecord }) => {
            const { type, data } = msg;
            if (!data) return;
            switch (type) {
                case "meeting_participant_joined": {
                    let hasPeersToConnect = false;
                    if (
                        data.existingPeers &&
                        Array.isArray(data.existingPeers)
                    ) {
                        (data.existingPeers as AnyRecord[]).forEach((peer) => {
                            if (!peer?.userId) return;
                            const oldPc = pcsRef.current.get(
                                peer.userId as number | string,
                            );
                            if (oldPc) {
                                try {
                                    oldPc.close();
                                } catch {
                                    /* ignore */
                                }
                                pcsRef.current.delete(
                                    peer.userId as number | string,
                                );
                            }
                            const pc = createPeerConnection(
                                peer.userId as number | string,
                                false,
                            );
                            if (pc)
                                pcsRef.current.set(
                                    peer.userId as number | string,
                                    pc,
                                );
                            if (peer.userId !== user?.id) {
                                hasPeersToConnect = true;
                                setParticipants((prev) => {
                                    const next = new Map(prev);
                                    next.set(peer.userId as number | string, {
                                        userId: peer.userId as number | string,
                                        stream: null,
                                        muted: false,
                                        videoOff: false,
                                        raisedHand: false,
                                        role: "participant",
                                        screenSharing: false,
                                        ...(next.get(
                                            peer.userId as number | string,
                                        ) || {}),
                                        name:
                                            (peer.fullName as string) ||
                                            (peer.username as string) ||
                                            "Participant",
                                        avatar:
                                            (peer.avatar as string) || null,
                                    });
                                    return next;
                                });
                            }
                        });
                    }
                    if (data.userId !== user?.id) {
                        setParticipants((prev) => {
                            const next = new Map(prev);
                            next.set(data.userId as number | string, {
                                userId: data.userId as number | string,
                                stream: null,
                                muted: false,
                                videoOff: false,
                                raisedHand: false,
                                role:
                                    (data.role as string) || "participant",
                                screenSharing: false,
                                ...(next.get(
                                    data.userId as number | string,
                                ) || {}),
                                name:
                                    (data.fullName as string) ||
                                    (data.username as string) ||
                                    "Participant",
                                avatar: (data.avatar as string) || null,
                            });
                            return next;
                        });
                        if (!data.existingPeers) {
                            const oldPc = pcsRef.current.get(
                                data.userId as number | string,
                            );
                            if (oldPc) {
                                try {
                                    oldPc.close();
                                } catch {
                                    /* ignore */
                                }
                                pcsRef.current.delete(
                                    data.userId as number | string,
                                );
                            }
                            const pc = createPeerConnection(
                                data.userId as number | string,
                                true,
                            );
                            if (pc)
                                pcsRef.current.set(
                                    data.userId as number | string,
                                    pc,
                                );
                            wsSend("meeting_track_state", {
                                meetingId,
                                muted: mutedRef.current,
                                videoOff: videoOffRef.current,
                                screenSharing: screenSharingRef.current,
                            });
                        }
                    }
                    setStatus((prev) =>
                        hasPeersToConnect
                            ? prev === "connected"
                                ? prev
                                : "connecting"
                            : "connected",
                    );

                    // Phase 2.2 — our RTCPeerConnection set is now built; tell the
                    // server we're ready so it replays any buffered offer/ICE for
                    // us and asks the other peers to (re)offer toward us (the
                    // `meeting_peer_ready` fan-out). Idempotent via Perfect
                    // Negotiation; guarded to fire once per WS connection.
                    if (!readySentRef.current && hasPeersToConnect) {
                        readySentRef.current = true;
                        wsSend("meeting_ready", { meetingId });
                    }

                    // Phase 4.1 — bandwidth governor. A new peer joined, so the
                    // uplink is now split across more remotes: re-cap EVERY
                    // existing PC's video sender to the tier for the new count so
                    // the single uplink can't saturate (audio senders are left
                    // untouched — they stay pinned at `AUDIO_MAX_BITRATE`).
                    const peerCount = pcsRef.current.size;
                    if (peerCount > 1) {
                        const videoBitrate =
                            videoBitrateForPeerCount(peerCount);
                        for (const [, existingPc] of pcsRef.current) {
                            for (const sender of existingPc.getSenders()) {
                                if (
                                    !sender.track ||
                                    sender.track.kind !== "video"
                                )
                                    continue;
                                try {
                                    const params = sender.getParameters();
                                    if (
                                        !params.encodings ||
                                        params.encodings.length === 0
                                    )
                                        continue;
                                    params.encodings[0].maxBitrate =
                                        videoBitrate;
                                    sender
                                        .setParameters(params)
                                        .catch(() => {});
                                } catch {
                                    /* ignore */
                                }
                            }
                        }
                    }
                    break;
                }
                case "meeting_signal": {
                    const { fromUserId, signal } = data as {
                        fromUserId: number | string;
                        signal: AnyRecord;
                    };
                    let pc = pcsRef.current.get(fromUserId);
                    if (!pc) {
                        const created = createPeerConnection(
                            fromUserId,
                            false,
                        );
                        if (!created) break;
                        pc = created;
                        pcsRef.current.set(fromUserId, pc);
                    }
                    handleSignal(fromUserId, pc, signal).catch(console.error);
                    break;
                }
                case "meeting_peer_ready": {
                    // Phase 2.2 — the server tells us a peer (re)joined / became
                    // ready, asking US to (re)offer toward them. If we already
                    // have a live PC whose localDescription is an offer, re-send
                    // it once (idempotent via Perfect Negotiation). If we have a
                    // PC but it isn't offering (we're the answerer side), do
                    // nothing — they will offer. If no PC exists yet, create one
                    // as the initiator so a dropped bootstrap offer is recovered.
                    const { userId } = data as { userId: number | string };
                    if (userId == null || userId === user?.id) break;
                    const existing = pcsRef.current.get(userId);
                    if (existing) {
                        if (
                            existing.localDescription &&
                            existing.localDescription.type === "offer"
                        ) {
                            wsSend("meeting_signal", {
                                meetingId,
                                targetUserId: userId,
                                signal: {
                                    type: "offer",
                                    sdp: existing.localDescription,
                                },
                            });
                        }
                    } else {
                        const created = createPeerConnection(userId, true);
                        if (created) pcsRef.current.set(userId, created);
                    }
                    break;
                }
                case "meeting_participant_left": {
                    const { userId } = data as { userId: number | string };
                    // Phase 5.1 — dispatch CLOSED BEFORE tearing the PC down so a
                    // late `connected`/`ontrack` from the connection being closed
                    // can't revive the removed tile (the mesh P3.14 effect race).
                    const leavingPc = pcsRef.current.get(userId);
                    if (leavingPc)
                        dispatchPeerPhase(leavingPc, { type: "CLOSED" });
                    leavingPc?.close();
                    pcsRef.current.delete(userId);
                    setParticipants((prev) => {
                        const n = new Map(prev);
                        n.delete(userId);
                        return n;
                    });
                    if (presenterIdRef.current === userId)
                        setPresenterId(null);
                    break;
                }
                case "meeting_ended": {
                    if (screenStreamRef.current) {
                        screenStreamRef.current
                            .getTracks()
                            .forEach((t) => t.stop());
                        screenStreamRef.current = null;
                    }
                    if (localStreamRef.current) {
                        localStreamRef.current
                            .getTracks()
                            .forEach((t) => t.stop());
                        localStreamRef.current = null;
                    }
                    pcsRef.current.forEach((pc) => {
                        try {
                            pc.close();
                        } catch {
                            /* ignore */
                        }
                    });
                    pcsRef.current.clear();
                    if (qualityTimerRef.current) {
                        clearInterval(qualityTimerRef.current);
                        qualityTimerRef.current = null;
                    }
                    setStatus("ended");
                    break;
                }
                case "meeting_muted": {
                    const shouldMute = data.muted !== false;
                    setMuted(shouldMute);
                    if (localStreamRef.current)
                        localStreamRef.current
                            .getAudioTracks()
                            .forEach((t) => {
                                t.enabled = !shouldMute;
                            });
                    wsSend("meeting_track_state", {
                        meetingId,
                        muted: shouldMute,
                        videoOff: videoOffRef.current,
                        screenSharing: screenSharingRef.current,
                    });
                    break;
                }
                case "meeting_hand_raised": {
                    const { userId, raised } = data as {
                        userId: number | string;
                        raised: boolean;
                    };
                    setParticipants((prev) => {
                        const n = new Map(prev);
                        const p = n.get(userId);
                        if (p) n.set(userId, { ...p, raisedHand: raised });
                        return n;
                    });
                    break;
                }
                case "meeting_track_state": {
                    const {
                        userId,
                        muted: m,
                        videoOff: v,
                        screenSharing: s,
                    } = data as {
                        userId: number | string;
                        muted?: boolean;
                        videoOff?: boolean;
                        screenSharing?: boolean;
                    };
                    setParticipants((prev) => {
                        const n = new Map(prev);
                        const p = n.get(userId) || {
                            userId,
                            stream: null,
                            name: "Participant",
                            raisedHand: false,
                            role: "participant",
                        };
                        n.set(userId, {
                            ...p,
                            ...(m != null ? { muted: m } : {}),
                            ...(v != null ? { videoOff: v } : {}),
                            ...(s != null ? { screenSharing: s } : {}),
                        });
                        return n;
                    });
                    if (s) setPresenterId(userId);
                    else if (
                        s === false &&
                        presenterIdRef.current === userId
                    )
                        setPresenterId(null);
                    break;
                }
                case "meeting_screen_track_id": {
                    const { fromUserId, trackId, sharing } = data as {
                        fromUserId: number | string;
                        trackId?: string;
                        sharing?: boolean;
                    };
                    const pc = pcsRef.current.get(fromUserId);
                    if (!pc) break;
                    if (sharing && trackId) {
                        pc._screenTrackIds!.add(trackId);
                    } else if (!sharing) {
                        pc._screenTrackIds!.clear();
                    }
                    pc._reclassifyTracks && pc._reclassifyTracks();
                    setParticipants((prev) => {
                        const n = new Map(prev);
                        const ex = n.get(fromUserId);
                        if (ex)
                            n.set(fromUserId, {
                                ...ex,
                                stream: pc._remoteStream,
                                screenStream: pc._remoteScreenStream,
                            });
                        return n;
                    });
                    break;
                }
                case "meeting_message": {
                    const incoming = data.message as MeetingMessage;
                    if (!incoming) break;
                    const incClientId =
                        incoming.clientMsgId ||
                        (incoming.client_msg_id as string) ||
                        null;
                    if (
                        incClientId &&
                        pendingSendsRef.current.has(incClientId)
                    ) {
                        pendingSendsRef.current.delete(incClientId);
                    }
                    setMessages((prev) => {
                        if (incClientId) {
                            const idx = prev.findIndex(
                                (m) => m.clientMsgId === incClientId,
                            );
                            if (idx >= 0) {
                                const next = prev.slice();
                                next[idx] = {
                                    ...next[idx],
                                    ...incoming,
                                    clientMsgId: incClientId,
                                    _optimistic: false,
                                    _failed: false,
                                };
                                return next;
                            }
                        }
                        if (incoming.sender_id === user?.id) {
                            const idx = prev.findIndex(
                                (m) =>
                                    m._optimistic &&
                                    m.sender_id === incoming.sender_id &&
                                    m.text === incoming.text &&
                                    !m.clientMsgId,
                            );
                            if (idx >= 0) {
                                const next = prev.slice();
                                next[idx] = incoming;
                                return next;
                            }
                        }
                        if (
                            incoming.id != null &&
                            prev.some((m) => m.id === incoming.id)
                        ) {
                            return prev;
                        }
                        return [...prev, incoming];
                    });
                    break;
                }
                case "meeting_message_ack": {
                    const { clientMsgId, id, createdAt } = data as {
                        clientMsgId?: string;
                        id?: number | string;
                        createdAt?: string;
                    };
                    if (clientMsgId) {
                        pendingSendsRef.current.delete(clientMsgId);
                        markMessageStatus(clientMsgId, {
                            _optimistic: false,
                            _failed: false,
                            ...(id != null ? { id } : {}),
                            ...(createdAt ? { created_at: createdAt } : {}),
                        });
                    }
                    break;
                }
                case "meeting_message_error": {
                    const { clientMsgId, reason } = data as {
                        clientMsgId?: string;
                        reason?: string;
                    };
                    if (clientMsgId) {
                        markMessageStatus(clientMsgId, {
                            _failed: true,
                            _failureReason: reason || "unknown",
                        });
                    }
                    break;
                }
                case "meeting_request_quality": {
                    const { fromUserId, level } = data as {
                        fromUserId: number | string;
                        level: string;
                    };
                    if (
                        !fromUserId ||
                        !["q", "h", "f"].includes(level)
                    )
                        break;
                    requestedQualityRef.current.set(fromUserId, level);
                    applyQualityCapForPeer(fromUserId);
                    break;
                }
                case "meeting_audio_level": {
                    const { userId, level } = data as {
                        userId: number | string;
                        level: number;
                    };
                    if (typeof level !== "number") break;
                    audioLevelsRef.current.set(userId, {
                        level,
                        at: performance.now(),
                    });
                    break;
                }
                default:
                    break;
            }
        },
        [
            user,
            createPeerConnection,
            handleSignal,
            meetingId,
            wsSend,
            applyQualityCapForPeer,
        ],
    );

    // Register WS message handler
    const handleWsMessageRef = useRef(handleWsMessage);
    handleWsMessageRef.current = handleWsMessage;

    useEffect(() => {
        if (!ws) return;
        const onMessage = (e: MessageEvent) => {
            try {
                handleWsMessageRef.current(JSON.parse(e.data));
            } catch {
                /* ignore */
            }
        };
        ws.addEventListener("message", onMessage);
        return () => ws.removeEventListener("message", onMessage);
    }, [ws]);

    // Send WS join
    useEffect(() => {
        if (!ws || !meetingId) return;
        let retryTimer: ReturnType<typeof setTimeout> | null = null;
        let retryTimer2: ReturnType<typeof setTimeout> | null = null;
        let joined = false;

        if (pcsRef.current.size > 0) {
            pcsRef.current.forEach((pc) => {
                try {
                    pc.close();
                } catch {
                    /* ignore */
                }
            });
            pcsRef.current.clear();
            iceRestartCountsRef.current.clear();
            relayOnlyPeersRef.current.clear();
        }
        // Phase 2.2 — fresh WS connection: reset the reliable-delivery handshake
        // guards so `meeting_subscribe`/`meeting_ready` fire again on reconnect.
        subscribedRef.current = false;
        readySentRef.current = false;
        // Phase 2.3 (G4) — the PCs above were just torn down and will be rebuilt
        // from the authoritative `existingPeers`; any offer/ICE frames still
        // queued from the previous session reference dead connections, so drop
        // them rather than replaying stale signaling onto fresh PCs.
        outboundQueueRef.current = [];

        const sendJoin = () => {
            if (joined) return;
            joined = true;
            wsSend("meeting_join", { meetingId });
            // Phase 2.2 — reliable-delivery handshake: announce we're subscribed
            // so the server replays any buffered offer/ICE and tells the other
            // peers to (re)offer toward us via `meeting_peer_ready`. Distinct from
            // `meeting_ready` (PCs built) — this is "WS attached + listening".
            if (!subscribedRef.current) {
                subscribedRef.current = true;
                wsSend("meeting_subscribe", { meetingId });
            }
            setTimeout(
                () =>
                    wsSend("meeting_track_state", {
                        meetingId,
                        muted: mutedRef.current,
                        videoOff: videoOffRef.current,
                        screenSharing: screenSharingRef.current,
                    }),
                300,
            );
        };

        const onOpen = () => sendJoin();

        if (ws.readyState === WebSocket.OPEN) sendJoin();
        else if (ws.readyState === WebSocket.CONNECTING)
            ws.addEventListener("open", onOpen, { once: true });

        retryTimer = setTimeout(() => {
            if (!joined && ws.readyState === WebSocket.OPEN) {
                sendJoin();
            }
        }, 1000);

        retryTimer2 = setTimeout(() => {
            if (ws.readyState === WebSocket.OPEN) {
                wsSend("meeting_join", { meetingId });
            }
        }, 2500);

        return () => {
            if (retryTimer) clearTimeout(retryTimer);
            if (retryTimer2) clearTimeout(retryTimer2);
            try {
                ws.removeEventListener("open", onOpen);
            } catch {
                /* ignore */
            }
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [ws, meetingId]);

    // Meeting-level cleanup
    useEffect(() => {
        if (!meetingId) return;
        const onBeforeUnload = () => {
            const w = wsRef.current;
            if (w && w.readyState === WebSocket.OPEN) {
                try {
                    w.send(
                        JSON.stringify({
                            type: "meeting_leave",
                            data: { meetingId },
                        }),
                    );
                } catch {
                    /* ignore */
                }
            }
        };
        window.addEventListener("beforeunload", onBeforeUnload);
        return () => {
            window.removeEventListener("beforeunload", onBeforeUnload);
            if (!keepAliveOnUnmount) {
                wsSend("meeting_leave", { meetingId });
                pcsRef.current.forEach((pc) => {
                    try {
                        pc.close();
                    } catch {
                        /* ignore */
                    }
                });
                pcsRef.current.clear();
            }
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [meetingId]);

    // Actions
    const toggleMute = useCallback(() => {
        setMuted((v) => {
            const next = !v;
            if (localStreamRef.current)
                localStreamRef.current.getAudioTracks().forEach((t) => {
                    t.enabled = !next;
                });
            wsSend("meeting_track_state", {
                meetingId,
                muted: next,
                videoOff: videoOffRef.current,
                screenSharing: screenSharingRef.current,
            });
            return next;
        });
    }, [meetingId, wsSend]);

    const videoToggleInFlightRef = useRef(false);
    const toggleVideo = useCallback(async () => {
        if (videoToggleInFlightRef.current) return;
        videoToggleInFlightRef.current = true;
        try {
            const next = !videoOffRef.current;
            if (next) {
                for (const [, pc] of pcsRef.current) {
                    const videoSenders = pc
                        .getSenders()
                        .filter(
                            (s) => s.track && s.track.kind === "video",
                        );
                    for (const vs of videoSenders) {
                        try {
                            await vs.replaceTrack(null);
                        } catch {
                            /* ignore */
                        }
                    }
                }
                if (localStreamRef.current) {
                    const vts = localStreamRef.current.getVideoTracks();
                    vts.forEach((t) => {
                        try {
                            t.stop();
                        } catch {
                            /* ignore */
                        }
                        try {
                            localStreamRef.current!.removeTrack(t);
                        } catch {
                            /* ignore */
                        }
                    });
                    setLocalStream(
                        new MediaStream(
                            localStreamRef.current.getTracks(),
                        ),
                    );
                }
            } else {
                if (!localStreamRef.current) {
                    try {
                        const ns =
                            await navigator.mediaDevices.getUserMedia({
                                audio: true,
                                video: true,
                            });
                        localStreamRef.current = ns;
                        ns.getAudioTracks().forEach((t) => {
                            t.enabled = !mutedRef.current;
                        });
                        for (const [peerId, pc] of pcsRef.current) {
                            ns.getTracks().forEach((track) =>
                                pc.addTrack(track, ns),
                            );
                            try {
                                const offer = await pc.createOffer();
                                await pc.setLocalDescription(offer);
                                wsSend("meeting_signal", {
                                    meetingId,
                                    targetUserId: peerId,
                                    signal: {
                                        type: "offer",
                                        sdp: pc.localDescription,
                                    },
                                });
                            } catch {
                                /* ignore */
                            }
                        }
                        setLocalStream(ns);
                    } catch {
                        return;
                    }
                } else {
                    let ns: MediaStream;
                    try {
                        ns = await navigator.mediaDevices.getUserMedia({
                            video: true,
                            audio: false,
                        });
                    } catch (err) {
                        console.error(
                            "[meeting] re-acquire camera failed:",
                            err,
                        );
                        return;
                    }
                    const nt = ns.getVideoTracks()[0];
                    if (!nt) return;
                    try {
                        (nt as any).contentHint = "motion";
                    } catch {
                        /* ignore */
                    }
                    localStreamRef.current.addTrack(nt);

                    for (const [peerId, pc] of pcsRef.current) {
                        const vs =
                            pc
                                .getSenders()
                                .find(
                                    (s) =>
                                        s.track &&
                                        s.track.kind === "video",
                                ) ||
                            pc.getSenders().find((s) => !s.track);
                        if (vs) {
                            try {
                                await vs.replaceTrack(nt);
                            } catch (err) {
                                console.warn(
                                    "[meeting] replaceTrack failed, addTrack fallback:",
                                    (err as Error)?.message || err,
                                );
                                try {
                                    pc.addTrack(
                                        nt,
                                        localStreamRef.current as MediaStream,
                                    );
                                } catch {
                                    /* ignore */
                                }
                                try {
                                    const offer = await pc.createOffer();
                                    await pc.setLocalDescription(offer);
                                    wsSend("meeting_signal", {
                                        meetingId,
                                        targetUserId: peerId,
                                        signal: {
                                            type: "offer",
                                            sdp: pc.localDescription,
                                        },
                                    });
                                } catch {
                                    /* ignore */
                                }
                            }
                        } else {
                            try {
                                pc.addTrack(
                                    nt,
                                    localStreamRef.current as MediaStream,
                                );
                            } catch {
                                /* ignore */
                            }
                            try {
                                const offer = await pc.createOffer();
                                await pc.setLocalDescription(offer);
                                wsSend("meeting_signal", {
                                    meetingId,
                                    targetUserId: peerId,
                                    signal: {
                                        type: "offer",
                                        sdp: pc.localDescription,
                                    },
                                });
                            } catch {
                                /* ignore */
                            }
                        }
                    }
                    setLocalStream(
                        new MediaStream(
                            localStreamRef.current.getTracks(),
                        ),
                    );
                }
            }
            setVideoOff(next);
            wsSend("meeting_track_state", {
                meetingId,
                muted: mutedRef.current,
                videoOff: next,
                screenSharing: screenSharingRef.current,
            });
        } finally {
            videoToggleInFlightRef.current = false;
        }
    }, [meetingId, wsSend]);

    const screenSendersRef = useRef<
        Map<number | string, RTCRtpSender[]>
    >(new Map());

    const toggleScreenShare = useCallback(async () => {
        if (screenSharing) {
            if (screenStreamRef.current) {
                screenStreamRef.current
                    .getTracks()
                    .forEach((t) => t.stop());
                screenStreamRef.current = null;
            }
            for (const [peerId, senders] of screenSendersRef.current) {
                const pc = pcsRef.current.get(peerId);
                if (!pc) continue;
                for (const sender of senders) {
                    try {
                        pc.removeTrack(sender);
                    } catch {
                        /* ignore */
                    }
                }
                if (pc.signalingState === "stable") {
                    try {
                        const offer = await pc.createOffer();
                        await pc.setLocalDescription(offer);
                        wsSend("meeting_signal", {
                            meetingId,
                            targetUserId: peerId,
                            signal: {
                                type: "offer",
                                sdp: pc.localDescription,
                            },
                        });
                    } catch {
                        /* ignore */
                    }
                }
                wsSend("meeting_screen_track_id", {
                    meetingId,
                    targetUserId: peerId,
                    sharing: false,
                });
            }
            screenSendersRef.current.clear();

            setScreenSharing(false);
            setScreenStream(null);
            if (presenterIdRef.current === user?.id) setPresenterId(null);
            wsSend("meeting_track_state", {
                meetingId,
                muted: mutedRef.current,
                videoOff: videoOffRef.current,
                screenSharing: false,
            });
        } else {
            let ss: MediaStream;
            try {
                ss = await navigator.mediaDevices.getDisplayMedia({
                    video: true,
                    audio: true,
                });
            } catch {
                return;
            }
            screenStreamRef.current = ss;
            setScreenStream(ss);
            setScreenSharing(true);
            setPresenterId(user?.id ?? null);

            const screenVideoTrack = ss.getVideoTracks()[0];
            const screenAudioTrack = ss.getAudioTracks()[0];

            for (const [peerId, pc] of pcsRef.current) {
                const senders: RTCRtpSender[] = [];
                try {
                    senders.push(pc.addTrack(screenVideoTrack, ss));
                } catch {
                    /* ignore */
                }
                if (screenAudioTrack) {
                    try {
                        senders.push(pc.addTrack(screenAudioTrack, ss));
                    } catch {
                        /* ignore */
                    }
                }
                screenSendersRef.current.set(peerId, senders);

                if (pc.signalingState === "stable") {
                    try {
                        const offer = await pc.createOffer();
                        await pc.setLocalDescription(offer);
                        wsSend("meeting_signal", {
                            meetingId,
                            targetUserId: peerId,
                            signal: {
                                type: "offer",
                                sdp: pc.localDescription,
                            },
                        });
                    } catch {
                        /* ignore */
                    }
                }

                wsSend("meeting_screen_track_id", {
                    meetingId,
                    targetUserId: peerId,
                    sharing: true,
                    trackId: screenVideoTrack.id,
                });
            }

            screenVideoTrack.onended = () => {
                if (screenSharingRef.current) toggleScreenShare();
            };

            wsSend("meeting_track_state", {
                meetingId,
                muted: mutedRef.current,
                videoOff: videoOffRef.current,
                screenSharing: true,
            });
        }
    }, [screenSharing, meetingId, wsSend, user?.id]);

    const raiseHand = useCallback(() => {
        const next = !raisedHand;
        setRaisedHand(next);
        wsSend("meeting_raise_hand", {
            meetingId,
            raised: next,
            clientMsgId: newClientMsgId(),
        });
    }, [raisedHand, meetingId, wsSend]);

    const enqueueChatSend = useCallback(
        (payload: AnyRecord, optimisticPatch: AnyRecord) => {
            const clientMsgId =
                (payload.clientMsgId as string) || newClientMsgId();
            const fullPayload = { ...payload, clientMsgId, meetingId };
            const now = Date.now();
            pendingSendsRef.current.set(clientMsgId, {
                payload: fullPayload,
                firstSentAt: now,
                lastSentAt: now,
            });
            setMessages((prev) => [
                ...prev,
                {
                    clientMsgId,
                    sender_id: user?.id,
                    sender_name:
                        user?.full_name || user?.username || "You",
                    created_at: new Date(now).toISOString(),
                    _optimistic: true,
                    ...optimisticPatch,
                },
            ]);
            wsSend("meeting_chat", fullPayload);
            return clientMsgId;
        },
        [meetingId, wsSend, user],
    );

    const sendChatMessage = useCallback(
        (text: string) => {
            if (!text || !text.trim()) return;
            const trimmed = text.trim();
            enqueueChatSend({ text: trimmed }, { text: trimmed });
        },
        [enqueueChatSend],
    );

    const sendChatFile = useCallback(
        async (file: File) => {
            if (!file) return;
            const formData = new FormData();
            formData.append("file", file);
            const previewUrl = URL.createObjectURL(file);
            const clientMsgId = newClientMsgId();

            setMessages((prev) => [
                ...prev,
                {
                    clientMsgId,
                    sender_id: user?.id,
                    sender_name:
                        user?.full_name || user?.username || "You",
                    file_name: file.name,
                    file_size: file.size,
                    file_url: previewUrl,
                    created_at: new Date().toISOString(),
                    _optimistic: true,
                    _uploading: true,
                },
            ]);

            try {
                const convId = sessionStorage.getItem("meeting_conv_id");
                if (convId) {
                    const res = await uploadChatFile(convId, formData);
                    const rdata = res.data as {
                        fileUrl: string;
                        fileName: string;
                        fileSize: number;
                    };
                    enqueueChatSend(
                        {
                            clientMsgId,
                            file_url: rdata.fileUrl,
                            file_name: rdata.fileName,
                            file_size: rdata.fileSize,
                        },
                        {
                            file_name: rdata.fileName,
                            file_size: rdata.fileSize,
                            file_url: rdata.fileUrl,
                            _uploading: false,
                        },
                    );
                    setMessages((prev) => {
                        const idx = prev.findIndex(
                            (m, i) =>
                                m.clientMsgId === clientMsgId &&
                                i !== prev.length - 1,
                        );
                        if (idx < 0) return prev;
                        const next = prev.slice();
                        next.splice(idx, 1);
                        return next;
                    });
                } else {
                    enqueueChatSend(
                        {
                            clientMsgId,
                            text: `📎 ${file.name}`,
                            file_name: file.name,
                            file_size: file.size,
                        },
                        {
                            text: `📎 ${file.name}`,
                            file_name: file.name,
                            file_size: file.size,
                            _uploading: false,
                        },
                    );
                    setMessages((prev) => {
                        const idx = prev.findIndex(
                            (m, i) =>
                                m.clientMsgId === clientMsgId &&
                                i !== prev.length - 1,
                        );
                        if (idx < 0) return prev;
                        const next = prev.slice();
                        next.splice(idx, 1);
                        return next;
                    });
                }
            } catch {
                markMessageStatus(clientMsgId, {
                    _failed: true,
                    _uploading: false,
                    _failureReason: "upload-failed",
                });
            }
            setTimeout(() => URL.revokeObjectURL(previewUrl), 60_000);
        },
        [enqueueChatSend, markMessageStatus, user],
    );

    const retryMessage = useCallback(
        (clientMsgId: string) => {
            if (!clientMsgId) return;
            const entry = pendingSendsRef.current.get(clientMsgId);
            if (!entry) {
                markMessageStatus(clientMsgId, { _failed: false });
                return;
            }
            entry.firstSentAt = Date.now();
            entry.lastSentAt = Date.now();
            markMessageStatus(clientMsgId, {
                _failed: false,
                _failureReason: null,
                _optimistic: true,
            });
            wsSend("meeting_chat", entry.payload);
        },
        [markMessageStatus, wsSend],
    );

    // Periodic pending-send retry loop
    useEffect(() => {
        const t = setInterval(() => {
            const now = Date.now();
            const w = wsRef.current;
            const wsOpen = w && w.readyState === 1;
            for (const [clientMsgId, entry] of pendingSendsRef.current) {
                const age = now - entry.firstSentAt;
                const sinceLast = now - entry.lastSentAt;
                if (age > PENDING_SEND_FAIL_AFTER_MS) {
                    markMessageStatus(clientMsgId, {
                        _failed: true,
                        _failureReason: "timeout",
                    });
                }
                if (
                    wsOpen &&
                    sinceLast > PENDING_SEND_RETRY_EVERY_MS &&
                    w
                ) {
                    entry.lastSentAt = now;
                    try {
                        w.send(
                            JSON.stringify({
                                type: "meeting_chat",
                                data: entry.payload,
                            }),
                        );
                    } catch {
                        /* ignore */
                    }
                }
            }
        }, 1500);
        return () => clearInterval(t);
    }, [markMessageStatus]);

    // On every WS open: flush + replay
    useEffect(() => {
        if (!ws) return;
        const flushAndReplay = () => {
            // Phase 2.3 (G4) — replay any mesh-signal frames (offer / answer /
            // ICE / track-state) that `wsSend` queued while the socket was not
            // OPEN, so a reconnect window doesn't silently drop signaling.
            flushOutboundQueue();
            // Phase 5.2 — reconnect orchestration. On a WS reopen the server may
            // have dropped our meeting membership (grace-expiry) and any peer that
            // (re)joined while we were offline won't know about us. RE-ANNOUNCE
            // ourselves: `meeting_join` re-registers us + re-fetches the
            // authoritative `existingPeers` (which `meeting_participant_joined`
            // reconciles — pruning phantoms + rebuilding missing PCs), then
            // `meeting_subscribe` replays any buffered offer/ICE + fans out
            // `meeting_peer_ready` so the others re-offer toward us. The Network
            // change → ICE restart effect handles same-membership blips; this
            // covers the membership-lost case. Idempotent server-side.
            if (meetingId) {
                subscribedRef.current = false;
                readySentRef.current = false;
                try {
                    ws.send(
                        JSON.stringify({
                            type: "meeting_join",
                            data: { meetingId },
                        }),
                    );
                    ws.send(
                        JSON.stringify({
                            type: "meeting_subscribe",
                            data: { meetingId },
                        }),
                    );
                    subscribedRef.current = true;
                } catch {
                    /* ignore — periodic handshake / join effect will recover */
                }
            }
            const now = Date.now();
            for (const [, entry] of pendingSendsRef.current) {
                entry.lastSentAt = now;
                try {
                    ws.send(
                        JSON.stringify({
                            type: "meeting_chat",
                            data: entry.payload,
                        }),
                    );
                } catch {
                    /* ignore */
                }
            }
            if (meetingId) {
                let highest = 0;
                for (const m of messages) {
                    if (typeof m.id === "number" && m.id > highest)
                        highest = m.id;
                }
                try {
                    ws.send(
                        JSON.stringify({
                            type: "meeting_chat_replay",
                            data: { meetingId, sinceMessageId: highest },
                        }),
                    );
                } catch {
                    /* ignore */
                }
            }
        };
        if (ws.readyState === 1) {
            flushAndReplay();
        }
        ws.addEventListener("open", flushAndReplay);
        return () => {
            try {
                ws.removeEventListener("open", flushAndReplay);
            } catch {
                /* ignore */
            }
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [ws, meetingId]);

    const cleanupMedia = useCallback(() => {
        if (screenStreamRef.current) {
            screenStreamRef.current.getTracks().forEach((t) => t.stop());
            screenStreamRef.current = null;
            setScreenStream(null);
        }
        if (localStreamRef.current) {
            localStreamRef.current.getTracks().forEach((t) => t.stop());
            localStreamRef.current = null;
            setLocalStream(null);
        }
        pcsRef.current.forEach((pc) => {
            try {
                pc.close();
            } catch {
                /* ignore */
            }
        });
        pcsRef.current.clear();
        if (qualityTimerRef.current) {
            clearInterval(qualityTimerRef.current);
            qualityTimerRef.current = null;
        }
    }, []);

    const endMeeting = useCallback(() => {
        wsSend("meeting_end", { meetingId });
        cleanupMedia();
        setStatus("ended");
    }, [meetingId, wsSend, cleanupMedia]);
    const leaveMeeting = useCallback(() => {
        wsSend("meeting_leave", { meetingId });
        cleanupMedia();
        setStatus("left");
    }, [meetingId, wsSend, cleanupMedia]);
    const muteParticipant = useCallback(
        (targetUserId: number | string, muted = true) => {
            wsSend("meeting_mute_participant", {
                meetingId,
                targetUserId,
                muted,
                clientMsgId: newClientMsgId(),
            });
        },
        [meetingId, wsSend],
    );
    const addParticipant = useCallback(
        (targetUserId: number | string) => {
            wsSend("meeting_add_participant", { meetingId, targetUserId });
        },
        [meetingId, wsSend],
    );

    // Phase 3.2 (G5) — manual per-peer rebuild. Wired to the "Couldn't connect —
    // Retry" tile button that appears after the 30s connect timeout flags a peer
    // `connectFailed`. Tears the peer's dead PC down, resets its recovery state
    // (relay-escalation + ICE-restart counters + connectFailed flag) so it starts
    // fresh on the normal STUN+TURN path, then rebuilds as the initiator. The
    // rebuilt PC re-arms both the relay-first fast-retry (3.1) and a new 30s
    // connect timeout, so a second failure surfaces the Retry button again.
    const retryPeer = useCallback(
        (peerId: number | string) => {
            if (peerId == null) return;
            const existing = pcsRef.current.get(peerId);
            if (existing) {
                if (existing._relayRetryTimer) {
                    clearTimeout(existing._relayRetryTimer);
                    existing._relayRetryTimer = null;
                }
                if (existing._connectTimeoutTimer) {
                    clearTimeout(existing._connectTimeoutTimer);
                    existing._connectTimeoutTimer = null;
                }
                try {
                    existing.close();
                } catch {
                    /* ignore */
                }
                pcsRef.current.delete(peerId);
            }
            // Reset recovery state so the manual retry starts from a clean slate
            // on the normal (STUN+TURN) path rather than being pinned relay-only.
            relayOnlyPeersRef.current.delete(peerId);
            iceRestartCountsRef.current.delete(peerId);
            setParticipants((prev) => {
                const n = new Map(prev);
                const p = n.get(peerId);
                if (p) {
                    n.set(peerId, {
                        ...p,
                        connectFailed: false,
                        stream: null,
                    });
                    return n;
                }
                return prev;
            });
            const pc = createPeerConnection(peerId, true);
            if (pc) pcsRef.current.set(peerId, pc);
            // Ask the peer to (re)offer toward us too, in case they're the natural
            // initiator side — idempotent under Perfect Negotiation (2.1).
            wsSend("meeting_ready", { meetingId });
        },
        [createPeerConnection, wsSend, meetingId],
    );

    const switchAudioDevice = useCallback(async (deviceId: string) => {
        try {
            const ns = await navigator.mediaDevices.getUserMedia({
                audio: { deviceId: { exact: deviceId } },
            });
            const nt = ns.getAudioTracks()[0];
            if (!nt || !localStreamRef.current) return;
            const old = localStreamRef.current.getAudioTracks()[0];
            if (old) {
                localStreamRef.current.removeTrack(old);
                old.stop();
            }
            localStreamRef.current.addTrack(nt);
            nt.enabled = !mutedRef.current;
            for (const [, pc] of pcsRef.current) {
                const s = pc
                    .getSenders()
                    .find((s) => s.track?.kind === "audio");
                if (s) await s.replaceTrack(nt).catch(() => {});
            }
            setLocalStream(
                new MediaStream(localStreamRef.current.getTracks()),
            );
        } catch {
            /* ignore */
        }
    }, []);

    const switchVideoDevice = useCallback(async (deviceId: string) => {
        try {
            const ns = await navigator.mediaDevices.getUserMedia({
                video: { deviceId: { exact: deviceId } },
            });
            const nt = ns.getVideoTracks()[0];
            if (!nt || !localStreamRef.current) return;
            const old = localStreamRef.current.getVideoTracks()[0];
            if (old) {
                localStreamRef.current.removeTrack(old);
                old.stop();
            }
            localStreamRef.current.addTrack(nt);
            nt.enabled = !videoOffRef.current;
            for (const [, pc] of pcsRef.current) {
                const s = pc
                    .getSenders()
                    .find((s) => s.track?.kind === "video");
                if (s) await s.replaceTrack(nt).catch(() => {});
            }
            setLocalStream(
                new MediaStream(localStreamRef.current.getTracks()),
            );
        } catch {
            /* ignore */
        }
    }, []);

    // ─── Phase 5 — Local audio-level publisher ───
    useEffect(() => {
        if (!localStream || muted) return;
        const audioTrack = localStream.getAudioTracks?.()[0];
        if (!audioTrack) return;
        const AudioCtx =
            window.AudioContext || (window as any).webkitAudioContext;
        if (!AudioCtx) return;
        let ctx: AudioContext;
        try {
            ctx = new AudioCtx();
        } catch {
            return;
        }
        let cancelled = false;
        let timer: ReturnType<typeof setInterval> | null = null;
        let source: MediaStreamAudioSourceNode;
        let analyser: AnalyserNode;
        try {
            const audioOnly = new MediaStream([audioTrack]);
            source = ctx.createMediaStreamSource(audioOnly);
            analyser = ctx.createAnalyser();
            analyser.fftSize = 256;
            analyser.smoothingTimeConstant = 0.7;
            source.connect(analyser);
        } catch {
            try {
                ctx.close();
            } catch {
                /* ignore */
            }
            return;
        }
        if (ctx.state === "suspended")
            ctx.resume().catch(() => {
                /* ignore */
            });
        const data = new Uint8Array(analyser.frequencyBinCount);
        let lastSent = 0;
        const tick = () => {
            if (cancelled) return;
            analyser.getByteFrequencyData(data);
            let sum = 0;
            for (let i = 0; i < data.length; i++) sum += data[i];
            const level = Math.min(1, sum / data.length / 128);
            audioLevelsRef.current.set(user?.id ?? -1, {
                level,
                at: performance.now(),
            });
            const now = Date.now();
            if (level > 0.05 && now - lastSent > 500) {
                lastSent = now;
                wsSend("meeting_audio_level", {
                    meetingId,
                    level: +level.toFixed(3),
                });
            }
        };
        timer = setInterval(tick, 200);
        return () => {
            cancelled = true;
            if (timer) clearInterval(timer);
            try {
                source.disconnect();
            } catch {
                /* ignore */
            }
            try {
                analyser.disconnect();
            } catch {
                /* ignore */
            }
            try {
                ctx.close();
            } catch {
                /* ignore */
            }
        };
    }, [localStream, muted, meetingId, wsSend, user?.id]);

    // ─── Phase 5 — Active-speaker selector ───
    useEffect(() => {
        const t = setInterval(() => {
            const now = performance.now();
            let bestId: number | string | null = null;
            let bestLevel = 0;
            for (const [uid, { level, at }] of audioLevelsRef.current) {
                if (now - at > 2_000) continue;
                if (level < 0.08) continue;
                if (level > bestLevel) {
                    bestLevel = level;
                    bestId = uid;
                }
            }
            // Phase 4.2 — record when a peer holds the floor so the high-count
            // demotion policy can keep it at full video for a short window after
            // it stops speaking (hysteresis against conversational pauses).
            if (bestId != null && bestId !== (user?.id ?? -1)) {
                recentSpeakersRef.current.set(bestId, Date.now());
            }
            setActiveSpeakerId((prev) => (prev === bestId ? prev : bestId));
        }, 350);
        return () => clearInterval(t);
    }, [user?.id]);

    // ─── Phase 4.2 — Active-speaker-driven video demotion at high counts ───
    // Below `HIGH_COUNT_VIDEO_THRESHOLD` remote peers the mesh can carry
    // everyone's video, so the presenter + active speaker get full video (`f`)
    // and the rest get mid (`h`) — the original Phase 5 policy. At/above the
    // threshold the mesh can't carry N video streams, so we upgrade ONLY a
    // bounded priority set (presenter + dominant speaker + recent speakers,
    // capped at `MAX_PRIORITY_VIDEO_PEERS`) to full video and demote everyone
    // else to `q` (thumbnail → effectively audio+avatar). This runs on a short
    // interval (not just on activeSpeakerId change) so recent-speaker windows
    // expire and demote stale tiles even when nobody new is talking. The
    // per-peer `requestPeerQuality` send is deduped (`lastRequestSentRef`), so a
    // steady state produces no WS traffic.
    useEffect(() => {
        const applyPolicy = () => {
            if (participants.size === 0) return;
            const remotePeerIds: Array<number | string> = [];
            for (const [peerId] of participants) {
                if (peerId === user?.id) continue;
                remotePeerIds.push(peerId);
            }
            if (remotePeerIds.length === 0) return;

            const now = Date.now();
            // Prune expired recent-speaker entries so the priority set shrinks
            // back down once a peer has been quiet past the hysteresis window.
            for (const [uid, at] of recentSpeakersRef.current) {
                if (now - at > RECENT_SPEAKER_WINDOW_MS)
                    recentSpeakersRef.current.delete(uid);
            }

            const highCount =
                remotePeerIds.length >= HIGH_COUNT_VIDEO_THRESHOLD;

            if (!highCount) {
                // Small call — everyone fits. Presenter + active speaker get
                // full video; the rest get mid (original Phase 5 behaviour).
                for (const peerId of remotePeerIds) {
                    const isPresenterPeer = peerId === presenterId;
                    const isSpeaker = peerId === activeSpeakerId;
                    requestPeerQuality(
                        peerId,
                        isPresenterPeer || isSpeaker ? "f" : "h",
                    );
                }
                return;
            }

            // High count — build the bounded priority set that keeps full
            // video: presenter first (always), then the dominant speaker, then
            // the most-recent speakers, up to `MAX_PRIORITY_VIDEO_PEERS`.
            const priority = new Set<number | string>();
            if (
                presenterId != null &&
                presenterId !== user?.id &&
                participants.has(presenterId)
            )
                priority.add(presenterId);
            if (
                activeSpeakerId != null &&
                activeSpeakerId !== user?.id &&
                participants.has(activeSpeakerId) &&
                priority.size < MAX_PRIORITY_VIDEO_PEERS
            )
                priority.add(activeSpeakerId);
            if (priority.size < MAX_PRIORITY_VIDEO_PEERS) {
                const recent = [...recentSpeakersRef.current.entries()]
                    .filter(
                        ([uid]) =>
                            uid !== user?.id && participants.has(uid),
                    )
                    .sort((a, b) => b[1] - a[1]);
                for (const [uid] of recent) {
                    if (priority.size >= MAX_PRIORITY_VIDEO_PEERS) break;
                    priority.add(uid);
                }
            }

            for (const peerId of remotePeerIds) {
                requestPeerQuality(
                    peerId,
                    priority.has(peerId) ? "f" : "q",
                );
            }
        };

        applyPolicy();
        const t = setInterval(applyPolicy, 2_000);
        return () => clearInterval(t);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeSpeakerId, presenterId, participants.size]);

    const connectionBanner = describeState(fsmState);

    useEffect(() => {
        meetingStore.setState({
            muted,
            videoOff,
            screenSharing,
            raisedHand,
            status,
            fsmState,
            connectionBanner,
            activeSpeakerId,
            presenterId,
            messages,
        });
    }, [
        muted,
        videoOff,
        screenSharing,
        raisedHand,
        status,
        fsmState,
        connectionBanner,
        activeSpeakerId,
        presenterId,
        messages,
    ]);

    return {
        localStream,
        screenStream,
        muted,
        videoOff,
        screenSharing,
        participants,
        status,
        raisedHand,
        messages,
        activePanel,
        setActivePanel,
        connectionQualities,
        presenterId,
        mediaReady,
        toggleMute,
        toggleVideo,
        toggleScreenShare,
        raiseHand,
        sendChatMessage,
        sendChatFile,
        retryMessage,
        endMeeting,
        leaveMeeting,
        muteParticipant,
        addParticipant,
        switchAudioDevice,
        switchVideoDevice,
        handleWsMessage,
        // Phase 3.2 (G5) — manual per-peer rebuild for the "Couldn't connect —
        // Retry" tile.
        retryPeer,
        // Phase 1 — Resilience Pack additions:
        fsmState,
        connectionBanner,
        // Phase 5 — Mesh quality additions:
        activeSpeakerId,
        requestPeerQuality,
    };
}

// Silence the unused-warning for these helpers — they're exported for tests
void upsertCachedMessage;
void applyCachedMessages;
import { useEffect, useRef, useState, useCallback } from 'react';
import { useAuth } from '../../AuthContext';
import { getIceConfig, uploadChatFile, getMeetingMessages } from '../../api';
import {
    getCachedMessages,
    setCachedMessages,
    upsertCachedMessage,
    applyCachedMessages,
} from './messagesCache';
import { retryWithBackoff } from '../../utils/retryWithBackoff';
import { STATES, nextState as fsmNext, describeState } from './connectionStateMachine';
// ADR-008 — MeetingStore singleton. We mirror the highest-traffic state
// slices into the store on every change so future consumers can
// subscribe to one slice instead of importing the whole hook return.
// The hook's own `useState` values stay authoritative; the store is a
// read-only projection during this incremental migration window.
import { createMeetingStore, DEFAULT_MEETING_STATE } from './meetingStore';

/**
 * Singleton store shared by every meeting view in the tab. We use a
 * module-scope instance (not a per-hook one) because the consumers we
 * want to migrate later — MeetingChat, ParticipantTile, MeetingBottomBar —
 * are siblings of the hook, not children, and React Context would mean
 * a render-cascade-back to the parent for every state change.
 */
export const meetingStore = createMeetingStore({ ...DEFAULT_MEETING_STATE });

/**
 * Generate a stable, collision-resistant id for in-flight chat messages.
 * Round-tripped to the server in the `clientMsgId` field so the server can
 * INSERT idempotently (ON CONFLICT DO NOTHING on the partial unique index
 * over `messages.client_msg_id`) and so the receiver can dedupe its
 * optimistic bubble against the server echo regardless of text/file shape.
 *
 * crypto.randomUUID() is available in every modern browser + Electron.
 * The Math.random fallback is for the test environment (jsdom older than
 * 22) and exotic embedded WebViews.
 */
function newClientMsgId() {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID();
    }
    return `m_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/** How long an outgoing message can sit in the pending-send queue before we
 *  surface it as `_failed` in the UI. */
const PENDING_SEND_FAIL_AFTER_MS = 10_000;
/** Retry cadence for the pending-send queue when WS is OPEN. */
const PENDING_SEND_RETRY_EVERY_MS = 3_000;

const DEFAULT_ICE_SERVERS = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
];

function buildMeetingMediaProfiles(wantVideo) {
    const audio = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
    if (!wantVideo) return [{ audio, video: false }];
    const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
    if (isMobile) {
        return [
            { audio, video: { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 24, max: 30 } } },
            { audio, video: true },
            { audio, video: false },
        ];
    }
    return [
        { audio, video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 } } },
        { audio, video: { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 24, max: 30 } } },
        { audio, video: { width: { ideal: 320 }, height: { ideal: 240 }, frameRate: { ideal: 15, max: 24 } } },
        { audio, video: true },
        { audio, video: false },
    ];
}

async function acquireMeetingMedia(wantVideo) {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('NoMediaDevices');
    const profiles = buildMeetingMediaProfiles(wantVideo);
    let lastError;
    for (let i = 0; i < profiles.length; i++) {
        try {
            const st = await navigator.mediaDevices.getUserMedia(profiles[i]);
            if (i > 0) console.warn('[meeting] media acquired with reduced profile #' + i);
            return st;
        } catch (err) { lastError = err; }
    }
    throw lastError;
}

/**
 * Core meeting state hook — handles media, WebRTC mesh, signaling, and chat.
 * Optimized: no background effects, stable WS handler (no presenterId dep).
 */
export function useMeetingState({ meetingId, code, ws, initialMuted = false, initialVideoOff = false, keepAliveOnUnmount = false, existingStream = null }) {
    const { user } = useAuth();

    const [localStream, setLocalStream] = useState(null);
    const [screenStream, setScreenStream] = useState(null);
    const [muted, setMuted] = useState(initialMuted);
    const [videoOff, setVideoOff] = useState(initialVideoOff);
    const [screenSharing, setScreenSharing] = useState(false);
    const [participants, setParticipants] = useState(new Map());
    const [presenterId, setPresenterId] = useState(null);
    // Phase 5 — Active speaker (the loudest participant in the last ~2 s,
    // or null if nobody is talking). Computed from local + remote
    // `meeting_audio_level` samples in a separate effect below.
    const [activeSpeakerId, setActiveSpeakerId] = useState(null);
    // Phase 5 — Map of userId → most recent audio level (0..1) with the
    // sample timestamp. Stored in a ref because we read it from the
    // active-speaker timer without wanting to re-render every 100 ms.
    const audioLevelsRef = useRef(new Map()); // userId → { level, at }
    // Phase 5 — Per-peer requested-quality cap (q/h/f). Receivers set this
    // via `meeting_request_quality`; on every fresh RTCRtpSender (e.g. after
    // an ICE restart or camera re-acquire) we re-apply the cap.
    const requestedQualityRef = useRef(new Map()); // peerId → 'q' | 'h' | 'f'
    // Phase 5 — Last quality level we asked of each peer (receiver-side
    // throttle so we don't spam WS).
    const lastRequestSentRef = useRef(new Map()); // peerId → 'q' | 'h' | 'f'
    const [activePanel, setActivePanel] = useState(null);
    // Seed from the per-meeting module-scope cache so a remount of
    // MeetingRoom (PiP swap, navigation, Strict Mode) doesn't blank the
    // chat panel for the ~200-800ms it takes to hydrate from the server.
    const [messages, setMessages] = useState(() => getCachedMessages(code));
    // `status` is the public flat string we've always exposed; `fsmState`
    // is the new typed FSM state which drives the degraded-mode banner.
    // We keep `status` as a back-compat shim — every existing consumer
    // (MeetingRoom.jsx checks for 'ended' / 'left' / 'failed') continues
    // to work because the FSM state names are a strict superset.
    const [status, setStatus] = useState('joining');
    const [fsmState, setFsmState] = useState(STATES.IDLE);
    const fsmStateRef = useRef(fsmState);
    fsmStateRef.current = fsmState;
    /**
     * Single funnel for FSM transitions. Use this everywhere instead of
     * calling setFsmState directly so transitions stay legal and so the
     * legacy `status` string stays in sync (mostly so consumers like the
     * `useEffect([status])` in MeetingRoom keep firing on `ended`/`left`).
     */
    const dispatchFsm = useCallback((event) => {
        const cur = fsmStateRef.current;
        const next = fsmNext(cur, event);
        if (next !== cur) {
            setFsmState(next);
            // Mirror onto the legacy status string for back-compat.
            // We collapse a few FSM states onto the same legacy strings
            // so older code paths don't see a sudden new value.
            const legacy = next === STATES.RECONNECTING || next === STATES.DEGRADED
                ? 'connecting'
                : next;
            setStatus(legacy);
        }
    }, []);
    const [raisedHand, setRaisedHand] = useState(false);
    const [connectionQualities, setConnectionQualities] = useState(new Map());
    const [mediaReady, setMediaReady] = useState(!!existingStream);

    const localStreamRef = useRef(null);
    const screenStreamRef = useRef(null);
    const pcsRef = useRef(new Map());
    const pendingSignals = useRef(new Map());
    const qualityTimerRef = useRef(null);
    const wsRef = useRef(ws);
    wsRef.current = ws;
    const iceServersRef = useRef(DEFAULT_ICE_SERVERS);
    const iceExpiresAtRef = useRef(0);
    const relayOnlyPeersRef = useRef(new Set());
    const iceRestartCountsRef = useRef(new Map());
    const presenterIdRef = useRef(presenterId);
    presenterIdRef.current = presenterId;
    const mutedRef = useRef(muted);
    mutedRef.current = muted;
    const videoOffRef = useRef(videoOff);
    videoOffRef.current = videoOff;
    const screenSharingRef = useRef(screenSharing);
    screenSharingRef.current = screenSharing;

    // Mirror every messages change back into the cache so the next remount
    // can seed from it. Cheap — array reference equality short-circuits when
    // setMessages was a no-op.
    useEffect(() => {
        if (code) setCachedMessages(code, messages);
    }, [code, messages]);

    // ── Pending-send queue (at-least-once delivery for in-meeting chat) ──
    // Every outgoing message is recorded here with its clientMsgId. The
    // entry is removed when the server confirms persistence via
    // `meeting_message_ack` (or the broadcast echo carrying the same
    // clientMsgId, whichever arrives first). A periodic retry timer
    // re-sends anything older than PENDING_SEND_RETRY_EVERY_MS while the
    // WS is OPEN, and flips the optimistic message to `_failed` after
    // PENDING_SEND_FAIL_AFTER_MS so the UI can surface a retry button.
    const pendingSendsRef = useRef(new Map()); // clientMsgId → { payload, firstSentAt, lastSentAt }

    const markMessageStatus = useCallback((clientMsgId, patch) => {
        if (!clientMsgId) return;
        setMessages(prev => {
            const idx = prev.findIndex(m => m.clientMsgId === clientMsgId);
            if (idx < 0) return prev;
            const next = prev.slice();
            next[idx] = { ...next[idx], ...patch };
            return next;
        });
    }, []);

    const replaceVideoTrackOnPeers = useCallback(async (newTrack) => {
        const tasks = [];
        for (const [, pc] of pcsRef.current) {
            const sender = pc.getSenders().find(s => s.track?.kind === 'video');
            if (sender) tasks.push(sender.replaceTrack(newTrack || null).catch(() => { }));
        }
        await Promise.all(tasks);
    }, []);

    const wsSend = useCallback((type, data) => {
        if (wsRef.current && wsRef.current.readyState === 1) {
            wsRef.current.send(JSON.stringify({ type, data }));
        }
    }, []);

    // ─── Phase 5 — Per-peer adaptive bitrate helpers ───────────────────────
    /**
     * Apply the currently-requested quality cap for one peer's video sender.
     * Called whenever a `meeting_request_quality` arrives AND whenever a
     * fresh RTCRtpSender appears (ICE restart, camera re-acquire).
     */
    const applyQualityCapForPeer = useCallback((peerId) => {
        const pc = pcsRef.current.get(peerId);
        if (!pc) return;
        const level = requestedQualityRef.current.get(peerId) || 'h';
        const maxBitrate = level === 'q' ? 150_000 : level === 'h' ? 500_000 : 1_200_000;
        for (const sender of pc.getSenders()) {
            if (!sender.track || sender.track.kind !== 'video') continue;
            try {
                const params = sender.getParameters();
                if (!params.encodings || params.encodings.length === 0) params.encodings = [{}];
                params.encodings[0].maxBitrate = maxBitrate;
                sender.setParameters(params).catch(() => { });
            } catch { /* ignore */ }
        }
    }, []);

    /**
     * Receiver-side helper: tell a peer to lower / raise their upstream
     * quality (q/h/f). Throttles to one request per (peer, level).
     * Wired into ParticipantTile via the returned `requestPeerQuality`.
     */
    const requestPeerQuality = useCallback((peerId, level) => {
        if (!peerId || !['q', 'h', 'f'].includes(level)) return;
        if (lastRequestSentRef.current.get(peerId) === level) return;
        lastRequestSentRef.current.set(peerId, level);
        wsSend('meeting_request_quality', { meetingId, targetUserId: peerId, level });
    }, [meetingId, wsSend]);

    // Acquire local media
    useEffect(() => {
        if (existingStream) {
            localStreamRef.current = existingStream;
            // Sync mute/video state from the actual track state — the PiP
            // widget may have toggled tracks while we were display:none.
            const audioEnabled = existingStream.getAudioTracks().some(t => t.enabled);
            const videoEnabled = existingStream.getVideoTracks().some(t => t.enabled);
            setMuted(!audioEnabled);
            setVideoOff(!videoEnabled);
            setLocalStream(existingStream);
            setMediaReady(true);
            return;
        }
        let stream;
        let cancelled = false;
        (async () => {
            try {
                const st = await acquireMeetingMedia(!initialVideoOff);
                if (cancelled) { st.getTracks().forEach(t => t.stop()); return; }
                stream = st;
                st.getAudioTracks().forEach(t => { t.enabled = !initialMuted; });
                if (st.getVideoTracks().length === 0) setVideoOff(true);
                localStreamRef.current = st;
                setLocalStream(st);
                setMediaReady(true);
            } catch (err) {
                if (cancelled) return;
                setMuted(true);
                setVideoOff(true);
                setMediaReady(true);
            }
        })();
        return () => {
            cancelled = true;
            if (!keepAliveOnUnmount && stream) stream.getTracks().forEach(t => t.stop());
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Fetch ICE config.
    //
    // Wrapped in retryWithBackoff so a single transient HTTP failure at
    // join time doesn't strand the user on the default STUN-only set
    // (which can't traverse symmetric NATs / corporate firewalls).
    // 4 attempts × 0.3-5s gives a worst-case ~10s before we give up and
    // fall back to defaults — well under the user-visible "joining" budget.
    useEffect(() => {
        let cancelled = false;
        const refresh = async () => {
            try {
                const { data } = await retryWithBackoff(
                    () => getIceConfig(),
                    { maxAttempts: 4, baseDelayMs: 300, maxDelayMs: 4_000 }
                );
                if (cancelled) return;
                if (data?.iceServers?.length) {
                    iceServersRef.current = data.iceServers;
                    iceExpiresAtRef.current = data.expiresAt || 0;
                }
            } catch { /* keep defaults */ }
        };
        refresh();
        const t = setInterval(() => {
            if (iceExpiresAtRef.current && iceExpiresAtRef.current - Math.floor(Date.now() / 1000) < 300) refresh();
        }, 60_000);
        return () => { cancelled = true; clearInterval(t); };
    }, []);

    // ─── Devicechange listener ──────────────────────────────────────────────
    // When the user unplugs / plugs a USB headset or a laptop lid wakes
    // and the camera enumerates differently, the OS fires `devicechange`.
    // The previous code didn't react at all — leaving the meeting using
    // a track that no longer exists (silent black tile to the other side).
    //
    // We do the lightest possible thing: re-broadcast our current track
    // state so peers can re-render the right indicator, and call
    // `replaceVideoTrackOnPeers(currentTrack)` on each peer so any peer
    // connection whose underlying track was severed gets a fresh sender.
    // We DON'T force re-acquisition — that would surprise the user.
    useEffect(() => {
        if (!navigator.mediaDevices?.addEventListener) return;
        const onChange = async () => {
            try {
                const vt = localStreamRef.current?.getVideoTracks?.()[0] || null;
                // If the current video track has ended (camera unplugged)
                // replace with null so peers see "video off" rather than a
                // frozen frame.
                if (vt && vt.readyState === 'ended') {
                    await replaceVideoTrackOnPeers(null);
                    setVideoOff(true);
                }
                wsSend('meeting_track_state', {
                    meetingId,
                    muted: mutedRef.current,
                    videoOff: videoOffRef.current,
                    screenSharing: screenSharingRef.current,
                });
            } catch { /* best-effort */ }
        };
        navigator.mediaDevices.addEventListener('devicechange', onChange);
        return () => { try { navigator.mediaDevices.removeEventListener('devicechange', onChange); } catch { /* ignore */ } };
    }, [meetingId, replaceVideoTrackOnPeers, wsSend]);

    // ─── Network online/offline → FSM ───────────────────────────────────────
    useEffect(() => {
        const onOnline = () => dispatchFsm('network_online');
        const onOffline = () => dispatchFsm('network_offline');
        window.addEventListener('online', onOnline);
        window.addEventListener('offline', onOffline);
        return () => {
            window.removeEventListener('online', onOnline);
            window.removeEventListener('offline', onOffline);
        };
    }, [dispatchFsm]);

    // ─── WS open/close → FSM ────────────────────────────────────────────────
    useEffect(() => {
        if (!ws) return;
        const onOpen = () => dispatchFsm('ws_open');
        const onClose = () => dispatchFsm('ws_close');
        ws.addEventListener('open', onOpen);
        ws.addEventListener('close', onClose);
        // Sync initial state.
        if (ws.readyState === 1) dispatchFsm('ws_open');
        else if (ws.readyState >= 2) dispatchFsm('ws_close');
        return () => {
            try { ws.removeEventListener('open', onOpen); } catch { /* ignore */ }
            try { ws.removeEventListener('close', onClose); } catch { /* ignore */ }
        };
    }, [ws, dispatchFsm]);

    // ─── Hydrate chat history on join / rejoin / WS reconnect ───────────────
    //
    // The server persists every `meeting_chat` message to the meeting's
    // underlying conversation row, so on join (and on every WS reconnect)
    // we backfill missed messages via GET /meetings/:code/messages.
    //
    // We re-run when `ws` changes too, because:
    //   • A flaky network can drop the WS for 5-15s. Any messages sent
    //     during that gap won't have been broadcast to us. Refetching on
    //     reconnect closes that hole without needing a server replay.
    //   • The fetch is idempotent and de-duped by id + clientMsgId so
    //     re-running it on every reconnect is cheap and never produces
    //     duplicates.
    //
    // Live messages still arrive over WS via `meeting_message`; the handler
    // de-dups by id / clientMsgId so a message that's both in history AND
    // broadcast in-flight only appears once.
    useEffect(() => {
        if (!code) return;
        let cancelled = false;
        const hydrate = () => {
            getMeetingMessages(code)
                .then(res => {
                    if (cancelled) return;
                    const history = Array.isArray(res.data) ? res.data : [];
                    if (!history.length) return;
                    setMessages(prev => {
                        // Merge by id AND clientMsgId — keep any optimistic /
                        // live messages that arrived before the fetch resolved
                        // (including pending-sends not yet acked).
                        const seenIds = new Set(prev.filter(m => m.id != null).map(m => m.id));
                        const seenClientIds = new Set(prev.filter(m => m.clientMsgId).map(m => m.clientMsgId));
                        const merged = [
                            ...history.filter(m =>
                                (m.id == null || !seenIds.has(m.id))
                                && (!m.client_msg_id || !seenClientIds.has(m.client_msg_id))
                            ).map(m => ({ ...m, clientMsgId: m.client_msg_id || m.clientMsgId })),
                            ...prev,
                        ];
                        // Sort by created_at (string ISO sorts lexicographically OK for ISO-8601)
                        merged.sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')));
                        return merged;
                    });
                })
                .catch(() => { /* silent — chat just stays whatever was cached */ });
        };

        hydrate();

        // Re-hydrate every time the WS transitions to OPEN. This is the
        // critical fix for the "chat disappears on reconnect" class of bug.
        if (ws) {
            const onOpen = () => hydrate();
            ws.addEventListener('open', onOpen);
            return () => { cancelled = true; try { ws.removeEventListener('open', onOpen); } catch { /* ignore */ } };
        }
        return () => { cancelled = true; };
    }, [code, ws]);

    // Safety net: add tracks to peer connections
    useEffect(() => {
        if (!localStreamRef.current) return;
        const stream = localStreamRef.current;
        for (const [peerId, pc] of pcsRef.current) {
            const senders = pc.getSenders().filter(s => s.track);
            if (senders.length === 0 && stream.getTracks().length > 0) {
                stream.getTracks().forEach(track => {
                    pc.addTrack(track, stream);
                    if (track.kind === 'video') {
                        try { track.contentHint = 'motion'; } catch { /* not supported */ }
                    }
                });
                if (pc.signalingState === 'stable') {
                    pc.createOffer()
                        .then(offer => pc.setLocalDescription(offer))
                        .then(() => wsSend('meeting_signal', { meetingId, targetUserId: peerId, signal: { type: 'offer', sdp: pc.localDescription } }))
                        .catch(console.error);
                }
            }
        }
    }, [localStream, meetingId, wsSend]);

    // Quality monitoring (every 8s for smoothness)
    useEffect(() => {
        qualityTimerRef.current = setInterval(async () => {
            const qMap = new Map();
            for (const [userId, pc] of pcsRef.current) {
                try {
                    const stats = await pc.getStats();
                    let totalPacketLoss = 0, rtt = 0, count = 0;
                    stats.forEach(s => {
                        if (s.type === 'inbound-rtp') {
                            const total = (s.packetsReceived || 0) + (s.packetsLost || 0);
                            if (total > 0) { totalPacketLoss += s.packetsLost / total; count++; }
                        }
                        if (s.type === 'candidate-pair' && s.state === 'succeeded') rtt = (s.currentRoundTripTime || 0) * 1000;
                    });
                    const avgLoss = count > 0 ? totalPacketLoss / count : 0;
                    qMap.set(userId, rtt < 100 && avgLoss < 0.02 ? 'good' : rtt < 250 && avgLoss < 0.08 ? 'medium' : 'poor');
                } catch { /* ignore */ }
            }
            setConnectionQualities(new Map(qMap));
        }, 8000);
        return () => clearInterval(qualityTimerRef.current);
    }, []);

    // Create peer connection
    const createPeerConnection = useCallback((remoteUserId, isInitiator) => {
        const existing = pcsRef.current.get(remoteUserId);
        if (existing && existing.connectionState !== 'closed' && existing.connectionState !== 'failed') return existing;
        if (existing) { try { existing.close(); } catch { } }

        const pcConfig = {
            iceServers: iceServersRef.current,
            bundlePolicy: 'max-bundle',
            rtcpMuxPolicy: 'require',
            iceCandidatePoolSize: 4,
        };
        if (relayOnlyPeersRef.current.has(remoteUserId)) pcConfig.iceTransportPolicy = 'relay';

        let pc;
        try { pc = new RTCPeerConnection(pcConfig); }
        catch { return null; }
        pcsRef.current.set(remoteUserId, pc);

        if (localStreamRef.current) {
            localStreamRef.current.getTracks().forEach(track => {
                pc.addTrack(track, localStreamRef.current);
                if (track.kind === 'video') {
                    try { track.contentHint = 'motion'; } catch { /* not supported */ }
                }
            });
        }

        // Bitrate caps — adaptive based on number of peer connections.
        // Full mesh means N-1 upload streams; lower per-peer bitrate as peers grow.
        setTimeout(() => {
            const peerCount = pcsRef.current.size;
            const videoBitrate = peerCount <= 2 ? 1_200_000 : peerCount <= 4 ? 600_000 : 400_000;
            for (const sender of pc.getSenders()) {
                if (!sender.track) continue;
                try {
                    const params = sender.getParameters();
                    if (!params.encodings || params.encodings.length === 0) params.encodings = [{}];
                    if (sender.track.kind === 'video') {
                        params.encodings[0].maxBitrate = videoBitrate;
                        params.degradationPreference = 'maintain-framerate';
                    } else {
                        params.encodings[0].maxBitrate = 48_000;
                    }
                    sender.setParameters(params).catch(() => { });
                } catch { /* ignore */ }
            }
        }, 0);

        // Stable per-peer remote streams. We keep the SAME stream objects
        // for the lifetime of the peer connection so the participant tile's
        // <video srcObject> never needs to be re-assigned when an additional
        // track arrives. Re-assigning srcObject forces the browser to tear
        // down the decoder, blank the element, and re-negotiate playback.
        //
        // We maintain TWO separate streams per peer:
        //   - camera + mic            → shown in the participant tile
        //   - screen-share video      → shown in the PresenterView (main pane)
        // Tracks coming in over the peer connection are routed to the camera
        // stream by default, then *re-routed* to the screen stream when the
        // sending peer announces (via `meeting_screen_track_id`) which track
        // id is the screen share. We can't reliably classify "camera vs
        // screen" from SDP alone, so the sender tells us explicitly.
        const remoteStream = new MediaStream();          // camera + mic
        const remoteScreenStream = new MediaStream();    // screen share only
        pc._remoteStream = remoteStream;
        pc._remoteScreenStream = remoteScreenStream;
        pc._screenTrackIds = new Set();                  // ids announced as screen

        const reclassifyTracks = () => {
            // Re-route any tracks that should be on the screen stream.
            // Idempotent — safe to call after every ontrack / announcement.
            for (const t of [...remoteStream.getTracks()]) {
                if (pc._screenTrackIds.has(t.id)) {
                    try { remoteStream.removeTrack(t); } catch { /* ignore */ }
                    if (!remoteScreenStream.getTracks().some(x => x.id === t.id)) {
                        remoteScreenStream.addTrack(t);
                    }
                }
            }
            for (const t of [...remoteScreenStream.getTracks()]) {
                if (!pc._screenTrackIds.has(t.id)) {
                    try { remoteScreenStream.removeTrack(t); } catch { /* ignore */ }
                    if (!remoteStream.getTracks().some(x => x.id === t.id)) {
                        remoteStream.addTrack(t);
                    }
                }
            }
        };
        pc._reclassifyTracks = reclassifyTracks;

        pc.ontrack = (e) => {
            // Default: add to the camera stream. If the sender has already
            // told us this track id is a screen share, reclassifyTracks()
            // will immediately move it to the screen stream below.
            if (!remoteStream.getTracks().some(t => t.id === e.track.id) &&
                !remoteScreenStream.getTracks().some(t => t.id === e.track.id)) {
                remoteStream.addTrack(e.track);
            }
            reclassifyTracks();

            // When a track ends (peer turned off camera OR stopped sharing),
            // drop it from whichever stream owns it.
            e.track.onended = () => {
                try { remoteStream.removeTrack(e.track); } catch { /* ignore */ }
                try { remoteScreenStream.removeTrack(e.track); } catch { /* ignore */ }
                pc._screenTrackIds.delete(e.track.id);
                setParticipants(prev => {
                    const next = new Map(prev);
                    const ex = next.get(remoteUserId);
                    if (ex) next.set(remoteUserId, { ...ex, stream: remoteStream, screenStream: remoteScreenStream });
                    return next;
                });
            };

            const hasVideo = remoteStream.getVideoTracks().some(t => t.readyState === 'live');
            setParticipants(prev => {
                const next = new Map(prev);
                const ex = next.get(remoteUserId) || { userId: remoteUserId };
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
            if (e.candidate) wsSend('meeting_signal', { meetingId, targetUserId: remoteUserId, signal: { type: 'candidate', candidate: e.candidate } });
        };

        pc.oniceconnectionstatechange = () => {
            if (pc.iceConnectionState === 'disconnected') {
                setTimeout(() => {
                    if (pc.iceConnectionState === 'disconnected' && pc.signalingState === 'stable') {
                        const cnt = iceRestartCountsRef.current.get(remoteUserId) || 0;
                        if (cnt < 3) {
                            iceRestartCountsRef.current.set(remoteUserId, cnt + 1);
                            pc.createOffer({ iceRestart: true })
                                .then(o => pc.setLocalDescription(o))
                                .then(() => wsSend('meeting_signal', { meetingId, targetUserId: remoteUserId, signal: { type: 'offer', sdp: pc.localDescription } }))
                                .catch(() => { });
                        }
                    }
                }, 2000);
            }
        };

        pc.onconnectionstatechange = () => {
            // Mirror the peer-connection state onto the corresponding
            // participant entry so the tile can show clear feedback
            // ("Connecting…" spinner, "Reconnecting…", etc.) instead of a
            // blank black square while we wait for the first video frame.
            const state = pc.connectionState;
            setParticipants(prev => {
                const next = new Map(prev);
                const ex = next.get(remoteUserId);
                if (ex && ex.connectionState !== state) {
                    next.set(remoteUserId, { ...ex, connectionState: state });
                    return next;
                }
                return prev;
            });

            if (pc.connectionState === 'connected') {
                setStatus('connected');
                dispatchFsm('peer_connected');
                iceRestartCountsRef.current.delete(remoteUserId);
                if (pc._disconnectTimer) { clearTimeout(pc._disconnectTimer); pc._disconnectTimer = null; }
                // Broadcast our track state so the peer knows our current mute/video status
                wsSend('meeting_track_state', { meetingId, muted: mutedRef.current, videoOff: videoOffRef.current, screenSharing: screenSharingRef.current });
            } else if (pc.connectionState === 'failed') {
                dispatchFsm('peer_failed');
                setParticipants(prev => {
                    const n = new Map(prev);
                    const p = n.get(remoteUserId);
                    if (p) {
                        if (p.stream) p.stream.getTracks().forEach(t => t.stop());
                        n.set(remoteUserId, { ...p, stream: null });
                    }
                    return n;
                });
                if (!relayOnlyPeersRef.current.has(remoteUserId)) {
                    relayOnlyPeersRef.current.add(remoteUserId);
                    try { pc.close(); } catch { }
                    pcsRef.current.delete(remoteUserId);
                    setTimeout(() => createPeerConnection(remoteUserId, true), 500);
                }
            } else if (pc.connectionState === 'disconnected') {
                dispatchFsm('peer_disconnected');
                pc._disconnectTimer = setTimeout(() => {
                    if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
                        setParticipants(prev => {
                            const n = new Map(prev);
                            const p = n.get(remoteUserId);
                            if (p) {
                                if (p.stream) p.stream.getTracks().forEach(t => t.stop());
                                n.set(remoteUserId, { ...p, stream: null });
                            }
                            return n;
                        });
                    }
                }, 5000);
            }
        };

        if (isInitiator) {
            pc.createOffer()
                .then(offer => pc.setLocalDescription(offer))
                .then(() => wsSend('meeting_signal', { meetingId, targetUserId: remoteUserId, signal: { type: 'offer', sdp: pc.localDescription } }))
                .catch(console.error);
        }
        return pc;
    }, [meetingId, wsSend]);

    // Network change → ICE restart
    useEffect(() => {
        const restartAll = () => {
            for (const [peerId, pc] of pcsRef.current) {
                if (pc.signalingState !== 'stable') continue;
                pc.createOffer({ iceRestart: true })
                    .then(o => pc.setLocalDescription(o))
                    .then(() => wsSend('meeting_signal', { meetingId, targetUserId: peerId, signal: { type: 'offer', sdp: pc.localDescription } }))
                    .catch(() => { });
            }
        };
        window.addEventListener('online', restartAll);
        const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
        conn?.addEventListener?.('change', restartAll);
        return () => { window.removeEventListener('online', restartAll); conn?.removeEventListener?.('change', restartAll); };
    }, [meetingId, wsSend]);

    const flushPendingSignals = useCallback(async (userId, pc) => {
        const pending = pendingSignals.current.get(userId) || [];
        pendingSignals.current.delete(userId);
        for (const sig of pending) {
            try { await handleSignal(userId, pc, sig); } catch { /* ignore */ }
        }
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    const handleSignal = useCallback(async (fromUserId, pc, signal) => {
        if (!pc) return;
        if (signal.type === 'offer') {
            await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            wsSend('meeting_signal', { meetingId, targetUserId: fromUserId, signal: { type: 'answer', sdp: pc.localDescription } });
            await flushPendingSignals(fromUserId, pc);
        } else if (signal.type === 'answer') {
            if (pc.signalingState === 'have-local-offer') {
                await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
                await flushPendingSignals(fromUserId, pc);
            }
        } else if (signal.type === 'candidate') {
            if (pc.remoteDescription) await pc.addIceCandidate(new RTCIceCandidate(signal.candidate));
            else { const q = pendingSignals.current.get(fromUserId) || []; q.push(signal); pendingSignals.current.set(fromUserId, q); }
        }
    }, [meetingId, wsSend, flushPendingSignals]);

    // STABLE WS handler — uses presenterIdRef instead of presenterId state
    const handleWsMessage = useCallback((msg) => {
        const { type, data } = msg;
        if (!data) return;
        switch (type) {
            case 'meeting_participant_joined': {
                let hasPeersToConnect = false;
                if (data.existingPeers && Array.isArray(data.existingPeers)) {
                    data.existingPeers.forEach(peer => {
                        if (!peer?.userId) return;
                        // Close stale peer connection before creating a new one
                        const oldPc = pcsRef.current.get(peer.userId);
                        if (oldPc) {
                            try { oldPc.close(); } catch { }
                            pcsRef.current.delete(peer.userId);
                        }
                        const pc = createPeerConnection(peer.userId, false);
                        if (pc) pcsRef.current.set(peer.userId, pc);
                        if (peer.userId !== user?.id) {
                            hasPeersToConnect = true;
                            setParticipants(prev => {
                                const next = new Map(prev);
                                next.set(peer.userId, { userId: peer.userId, stream: null, muted: false, videoOff: false, raisedHand: false, role: 'participant', screenSharing: false, ...(next.get(peer.userId) || {}), name: peer.fullName || peer.username || 'Participant', avatar: peer.avatar || null });
                                return next;
                            });
                        }
                    });
                }
                if (data.userId !== user?.id) {
                    setParticipants(prev => {
                        const next = new Map(prev);
                        next.set(data.userId, { userId: data.userId, stream: null, muted: false, videoOff: false, raisedHand: false, role: data.role || 'participant', screenSharing: false, ...(next.get(data.userId) || {}), name: data.fullName || data.username || 'Participant', avatar: data.avatar || null });
                        return next;
                    });
                    if (!data.existingPeers) {
                        // Close stale peer connection before creating a new one
                        const oldPc = pcsRef.current.get(data.userId);
                        if (oldPc) {
                            try { oldPc.close(); } catch { }
                            pcsRef.current.delete(data.userId);
                        }
                        const pc = createPeerConnection(data.userId, true);
                        if (pc) pcsRef.current.set(data.userId, pc);
                        wsSend('meeting_track_state', { meetingId, muted: mutedRef.current, videoOff: videoOffRef.current, screenSharing: screenSharingRef.current });
                    }
                }
                // Show "connecting" while peer connections are being established;
                // pc.onconnectionstatechange will flip status to "connected" when ready.
                setStatus(prev => hasPeersToConnect ? (prev === 'connected' ? prev : 'connecting') : 'connected');

                // Re-adjust bitrate for all existing peers based on new peer count
                const peerCount = pcsRef.current.size;
                if (peerCount > 1) {
                    const videoBitrate = peerCount <= 2 ? 1_200_000 : peerCount <= 4 ? 600_000 : 400_000;
                    for (const [, existingPc] of pcsRef.current) {
                        for (const sender of existingPc.getSenders()) {
                            if (!sender.track || sender.track.kind !== 'video') continue;
                            try {
                                const params = sender.getParameters();
                                if (!params.encodings || params.encodings.length === 0) continue;
                                params.encodings[0].maxBitrate = videoBitrate;
                                sender.setParameters(params).catch(() => { });
                            } catch { /* ignore */ }
                        }
                    }
                }
                break;
            }
            case 'meeting_signal': {
                const { fromUserId, signal } = data;
                let pc = pcsRef.current.get(fromUserId);
                if (!pc) { pc = createPeerConnection(fromUserId, false); if (!pc) break; pcsRef.current.set(fromUserId, pc); }
                handleSignal(fromUserId, pc, signal).catch(console.error);
                break;
            }
            case 'meeting_participant_left': {
                const { userId } = data;
                pcsRef.current.get(userId)?.close();
                pcsRef.current.delete(userId);
                setParticipants(prev => { const n = new Map(prev); n.delete(userId); return n; });
                if (presenterIdRef.current === userId) setPresenterId(null);
                break;
            }
            case 'meeting_ended': {
                if (screenStreamRef.current) { screenStreamRef.current.getTracks().forEach(t => t.stop()); screenStreamRef.current = null; }
                if (localStreamRef.current) { localStreamRef.current.getTracks().forEach(t => t.stop()); localStreamRef.current = null; }
                pcsRef.current.forEach(pc => { try { pc.close(); } catch { } });
                pcsRef.current.clear();
                if (qualityTimerRef.current) { clearInterval(qualityTimerRef.current); qualityTimerRef.current = null; }
                setStatus('ended');
                break;
            }
            case 'meeting_muted': {
                const shouldMute = data.muted !== false;
                setMuted(shouldMute);
                if (localStreamRef.current) localStreamRef.current.getAudioTracks().forEach(t => { t.enabled = !shouldMute; });
                wsSend('meeting_track_state', { meetingId, muted: shouldMute, videoOff: videoOffRef.current, screenSharing: screenSharingRef.current });
                break;
            }
            case 'meeting_hand_raised': {
                const { userId, raised } = data;
                setParticipants(prev => { const n = new Map(prev); const p = n.get(userId); if (p) n.set(userId, { ...p, raisedHand: raised }); return n; });
                break;
            }
            case 'meeting_track_state': {
                const { userId, muted: m, videoOff: v, screenSharing: s } = data;
                setParticipants(prev => {
                    const n = new Map(prev);
                    const p = n.get(userId) || { userId, stream: null, name: 'Participant', raisedHand: false, role: 'participant' };
                    n.set(userId, {
                        ...p,
                        ...(m != null ? { muted: m } : {}),
                        ...(v != null ? { videoOff: v } : {}),
                        ...(s != null ? { screenSharing: s } : {}),
                    });
                    return n;
                });
                if (s) setPresenterId(userId);
                else if (s === false && presenterIdRef.current === userId) setPresenterId(null);
                break;
            }
            case 'meeting_screen_track_id': {
                // The sending peer is telling us which of the tracks they
                // sent us is the screen-share video. We add the id to the
                // peer connection's screenTrackIds set and re-route the
                // matching MediaStreamTrack from the camera stream to the
                // screen stream. This lets the local camera continue to be
                // shown in the participant tile while the screen share
                // appears in the main PresenterView.
                const { fromUserId, trackId, sharing } = data;
                const pc = pcsRef.current.get(fromUserId);
                if (!pc) break;
                if (sharing && trackId) {
                    pc._screenTrackIds.add(trackId);
                } else if (!sharing) {
                    // Stopped sharing — clear all classifications
                    pc._screenTrackIds.clear();
                }
                pc._reclassifyTracks && pc._reclassifyTracks();
                setParticipants(prev => {
                    const n = new Map(prev);
                    const ex = n.get(fromUserId);
                    if (ex) n.set(fromUserId, { ...ex, stream: pc._remoteStream, screenStream: pc._remoteScreenStream });
                    return n;
                });
                break;
            }
            case 'meeting_message': {
                const incoming = data.message;
                if (!incoming) break;
                // Server echoes back the same `clientMsgId` we sent (or
                // `client_msg_id` from the persisted-row shape). Once the
                // echo arrives we know the server has the message — clear
                // it from the pending-send retry queue.
                const incClientId = incoming.clientMsgId || incoming.client_msg_id || null;
                if (incClientId && pendingSendsRef.current.has(incClientId)) {
                    pendingSendsRef.current.delete(incClientId);
                }
                setMessages(prev => {
                    // De-dup #1 (preferred): by clientMsgId — bulletproof for
                    // text + file messages alike, and survives identical-text
                    // double-sends.
                    if (incClientId) {
                        const idx = prev.findIndex(m => m.clientMsgId === incClientId);
                        if (idx >= 0) {
                            const next = prev.slice();
                            next[idx] = { ...next[idx], ...incoming, clientMsgId: incClientId, _optimistic: false, _failed: false };
                            return next;
                        }
                    }
                    // De-dup #2: legacy (sender + text) fallback for messages
                    // sent before this fix shipped (no clientMsgId in flight).
                    if (incoming.sender_id === user?.id) {
                        const idx = prev.findIndex(m => m._optimistic && m.sender_id === incoming.sender_id && m.text === incoming.text && !m.clientMsgId);
                        if (idx >= 0) { const next = prev.slice(); next[idx] = incoming; return next; }
                    }
                    // De-dup #3: same persisted id arrived twice (history +
                    // in-flight). Server always includes `id` on echo.
                    if (incoming.id != null && prev.some(m => m.id === incoming.id)) {
                        return prev;
                    }
                    return [...prev, incoming];
                });
                break;
            }
            case 'meeting_message_ack': {
                // Server confirmed persistence (decoupled from broadcast). We
                // can clear the pending-send queue even if the broadcast
                // hasn't reached us yet (which is the only way to clear it
                // for messages whose broadcast is filtered out by the
                // not-currently-joined check on the server).
                const { clientMsgId, id, createdAt } = data;
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
            case 'meeting_message_error': {
                // Server rejected the message (validation, persist failure,
                // etc.). Flip the optimistic bubble to _failed so the UI
                // can surface a retry button. We DO leave it in the
                // pending-send queue so the next periodic retry attempt
                // gets another shot — most "error" cases are transient
                // (DB hiccup, race during reconnect).
                const { clientMsgId, reason } = data;
                if (clientMsgId) {
                    markMessageStatus(clientMsgId, { _failed: true, _failureReason: reason || 'unknown' });
                }
                break;
            }
            case 'meeting_request_quality': {
                // Phase 5 — receiver-driven adaptive bitrate. Persist the
                // request and immediately apply the cap to that peer's
                // outbound video sender.
                const { fromUserId, level } = data;
                if (!fromUserId || !['q', 'h', 'f'].includes(level)) break;
                requestedQualityRef.current.set(fromUserId, level);
                applyQualityCapForPeer(fromUserId);
                break;
            }
            case 'meeting_audio_level': {
                // Phase 5 — active-speaker signal. Just record the level;
                // the active-speaker timer (below) picks the loudest.
                const { userId, level } = data;
                if (typeof level !== 'number') break;
                audioLevelsRef.current.set(userId, { level, at: performance.now() });
                break;
            }
            default: break;
        }
    }, [user, createPeerConnection, handleSignal, meetingId, wsSend, applyQualityCapForPeer]);

    // Register WS message handler
    const handleWsMessageRef = useRef(handleWsMessage);
    handleWsMessageRef.current = handleWsMessage;

    useEffect(() => {
        if (!ws) return;
        const onMessage = (e) => { try { handleWsMessageRef.current(JSON.parse(e.data)); } catch { /* ignore */ } };
        ws.addEventListener('message', onMessage);
        return () => ws.removeEventListener('message', onMessage);
    }, [ws]);

    // Send WS join — re-runs whenever the underlying WS changes (e.g. reconnect)
    // IMPORTANT: this effect intentionally does NOT send meeting_leave on cleanup,
    // because a ws prop change (reconnect) should NOT kick the user out of the meeting.
    // The unmount cleanup is handled in a separate effect below (keyed on meetingId only).
    useEffect(() => {
        if (!ws || !meetingId) return;
        let retryTimer = null;
        let retryTimer2 = null;
        let joined = false;

        // On reconnect, close stale peer connections so fresh ones are established
        // when the server sends meeting_participant_joined with existingPeers.
        if (pcsRef.current.size > 0) {
            pcsRef.current.forEach(pc => { try { pc.close(); } catch { } });
            pcsRef.current.clear();
            iceRestartCountsRef.current.clear();
            relayOnlyPeersRef.current.clear();
        }

        const sendJoin = () => {
            if (joined) return;
            joined = true;
            wsSend('meeting_join', { meetingId });
            setTimeout(() => wsSend('meeting_track_state', { meetingId, muted: mutedRef.current, videoOff: videoOffRef.current, screenSharing: screenSharingRef.current }), 300);
        };

        const onOpen = () => sendJoin();

        if (ws.readyState === WebSocket.OPEN) sendJoin();
        else if (ws.readyState === WebSocket.CONNECTING) ws.addEventListener('open', onOpen, { once: true });

        // Retry join after 1s if first attempt didn't send (WS was still
        // connecting at this point). Earlier code waited 3s here which made
        // the "Joining…" overlay feel like a hang on slow networks.
        retryTimer = setTimeout(() => {
            if (!joined && ws.readyState === WebSocket.OPEN) {
                sendJoin();
            }
        }, 1000);

        // Second retry at 2.5s — covers the rare race where the first
        // meeting_join WS frame was lost during connection setup. The
        // server is idempotent (`ON CONFLICT DO UPDATE`) so this is safe.
        retryTimer2 = setTimeout(() => {
            if (ws.readyState === WebSocket.OPEN) {
                wsSend('meeting_join', { meetingId });
            }
        }, 2500);

        return () => {
            clearTimeout(retryTimer);
            clearTimeout(retryTimer2);
            try { ws.removeEventListener('open', onOpen); } catch { /* ignore */ }
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [ws, meetingId]);

    // Meeting-level cleanup — runs only when the meetingId truly changes or component unmounts.
    // Sends meeting_leave + tears down peer connections so the user is removed from the meeting.
    useEffect(() => {
        if (!meetingId) return;
        const onBeforeUnload = () => {
            const w = wsRef.current;
            if (w && w.readyState === WebSocket.OPEN) {
                try { w.send(JSON.stringify({ type: 'meeting_leave', data: { meetingId } })); } catch { /* ignore */ }
            }
        };
        window.addEventListener('beforeunload', onBeforeUnload);
        return () => {
            window.removeEventListener('beforeunload', onBeforeUnload);
            if (!keepAliveOnUnmount) {
                wsSend('meeting_leave', { meetingId });
                pcsRef.current.forEach(pc => { try { pc.close(); } catch { /* ignore */ } });
                pcsRef.current.clear();
            }
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [meetingId]);

    // Actions
    const toggleMute = useCallback(() => {
        setMuted(v => {
            const next = !v;
            if (localStreamRef.current) localStreamRef.current.getAudioTracks().forEach(t => { t.enabled = !next; });
            wsSend('meeting_track_state', { meetingId, muted: next, videoOff: videoOffRef.current, screenSharing: screenSharingRef.current });
            return next;
        });
    }, [meetingId, wsSend]);

    // ─── Camera ON/OFF — fully releases the hardware when turned off ─────────
    //
    // Previously this only flipped `track.enabled = false`, which keeps the OS
    // camera capture alive (LED stays on, camera shows as "in use"). We now
    // stop the track and remove it from every peer connection sender so the
    // camera is truly released, then re-acquire on next ON.
    const videoToggleInFlightRef = useRef(false);
    const toggleVideo = useCallback(async () => {
        if (videoToggleInFlightRef.current) return;
        videoToggleInFlightRef.current = true;
        try {
            const next = !videoOffRef.current;
            if (next) {
                // ── Turn camera OFF ────────────────────────────────────────
                // 1. Tell every peer to stop receiving our video immediately.
                for (const [, pc] of pcsRef.current) {
                    const videoSenders = pc.getSenders().filter(s => s.track && s.track.kind === 'video');
                    for (const vs of videoSenders) {
                        try { await vs.replaceTrack(null); } catch { /* ignore */ }
                    }
                }
                // 2. Stop & remove all local video tracks → releases the camera.
                if (localStreamRef.current) {
                    const vts = localStreamRef.current.getVideoTracks();
                    vts.forEach(t => {
                        try { t.stop(); } catch { /* ignore */ }
                        try { localStreamRef.current.removeTrack(t); } catch { /* ignore */ }
                    });
                    setLocalStream(new MediaStream(localStreamRef.current.getTracks()));
                }
            } else {
                // ── Turn camera ON ─────────────────────────────────────────
                if (!localStreamRef.current) {
                    // No local stream at all — acquire fresh (audio + video).
                    try {
                        const ns = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
                        localStreamRef.current = ns;
                        ns.getAudioTracks().forEach(t => { t.enabled = !mutedRef.current; });
                        for (const [peerId, pc] of pcsRef.current) {
                            ns.getTracks().forEach(track => pc.addTrack(track, ns));
                            try {
                                const offer = await pc.createOffer();
                                await pc.setLocalDescription(offer);
                                wsSend('meeting_signal', { meetingId, targetUserId: peerId, signal: { type: 'offer', sdp: pc.localDescription } });
                            } catch { /* ignore */ }
                        }
                        setLocalStream(ns);
                    } catch { return; }
                } else {
                    // Acquire a NEW video-only stream and graft it onto the
                    // existing local stream. We use replaceTrack on existing
                    // video senders so the peer's tile never goes through
                    // an SDP renegotiation — no flicker, no spontaneous drop.
                    let ns;
                    try {
                        ns = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
                    } catch (err) {
                        console.error('[meeting] re-acquire camera failed:', err);
                        return;
                    }
                    const nt = ns.getVideoTracks()[0];
                    if (!nt) return;
                    try { nt.contentHint = 'motion'; } catch { /* ignore */ }
                    localStreamRef.current.addTrack(nt);

                    for (const [peerId, pc] of pcsRef.current) {
                        // Prefer an existing video sender (may currently be
                        // null after we called replaceTrack(null) on OFF).
                        const vs = pc.getSenders().find(s => s.track && s.track.kind === 'video')
                            || pc.getSenders().find(s => !s.track);
                        if (vs) {
                            try { await vs.replaceTrack(nt); } catch (err) {
                                console.warn('[meeting] replaceTrack failed, addTrack fallback:', err?.message || err);
                                try { pc.addTrack(nt, localStreamRef.current); } catch { /* ignore */ }
                                // Only renegotiate if we had to addTrack.
                                try {
                                    const offer = await pc.createOffer();
                                    await pc.setLocalDescription(offer);
                                    wsSend('meeting_signal', { meetingId, targetUserId: peerId, signal: { type: 'offer', sdp: pc.localDescription } });
                                } catch { /* ignore */ }
                            }
                        } else {
                            try { pc.addTrack(nt, localStreamRef.current); } catch { /* ignore */ }
                            try {
                                const offer = await pc.createOffer();
                                await pc.setLocalDescription(offer);
                                wsSend('meeting_signal', { meetingId, targetUserId: peerId, signal: { type: 'offer', sdp: pc.localDescription } });
                            } catch { /* ignore */ }
                        }
                    }
                    setLocalStream(new MediaStream(localStreamRef.current.getTracks()));
                }
            }
            setVideoOff(next);
            wsSend('meeting_track_state', { meetingId, muted: mutedRef.current, videoOff: next, screenSharing: screenSharingRef.current });
        } finally {
            videoToggleInFlightRef.current = false;
        }
    }, [meetingId, wsSend]);

    // Track the screen-share senders we ADDED per peer (so we can remove
    // them cleanly when sharing stops without disturbing the camera sender).
    const screenSendersRef = useRef(new Map()); // peerId -> [RTCRtpSender]

    const toggleScreenShare = useCallback(async () => {
        if (screenSharing) {
            // ── STOP sharing ──────────────────────────────────────────────
            // Stop all local screen tracks first.
            if (screenStreamRef.current) {
                screenStreamRef.current.getTracks().forEach(t => t.stop());
                screenStreamRef.current = null;
            }
            // Remove the dedicated screen-share senders we added — DO NOT
            // touch the camera sender (this was the original bug: replacing
            // the camera with the screen track removed the camera entirely,
            // so when sharing stopped some participants' camera was gone).
            for (const [peerId, senders] of screenSendersRef.current) {
                const pc = pcsRef.current.get(peerId);
                if (!pc) continue;
                for (const sender of senders) {
                    try { pc.removeTrack(sender); } catch { /* ignore */ }
                }
                // Renegotiate so the remote peer drops the m-line cleanly.
                if (pc.signalingState === 'stable') {
                    try {
                        const offer = await pc.createOffer();
                        await pc.setLocalDescription(offer);
                        wsSend('meeting_signal', { meetingId, targetUserId: peerId, signal: { type: 'offer', sdp: pc.localDescription } });
                    } catch { /* ignore */ }
                }
                // Tell the peer the screen share is over so they clear
                // their screen-track classification.
                wsSend('meeting_screen_track_id', { meetingId, targetUserId: peerId, sharing: false });
            }
            screenSendersRef.current.clear();

            setScreenSharing(false);
            setScreenStream(null);
            if (presenterIdRef.current === user?.id) setPresenterId(null);
            wsSend('meeting_track_state', { meetingId, muted: mutedRef.current, videoOff: videoOffRef.current, screenSharing: false });
        } else {
            // ── START sharing ─────────────────────────────────────────────
            let ss;
            try {
                ss = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
            } catch {
                return; // user cancelled
            }
            screenStreamRef.current = ss;
            setScreenStream(ss);
            setScreenSharing(true);
            setPresenterId(user?.id);

            const screenVideoTrack = ss.getVideoTracks()[0];
            const screenAudioTrack = ss.getAudioTracks()[0]; // optional

            // Add the screen track(s) as NEW senders alongside the camera.
            // This preserves remote viewers' ability to keep seeing the
            // camera feed in the participant tile while ALSO receiving the
            // screen-share track for the PresenterView pane.
            for (const [peerId, pc] of pcsRef.current) {
                const senders = [];
                try {
                    senders.push(pc.addTrack(screenVideoTrack, ss));
                } catch { /* ignore */ }
                if (screenAudioTrack) {
                    try { senders.push(pc.addTrack(screenAudioTrack, ss)); } catch { /* ignore */ }
                }
                screenSendersRef.current.set(peerId, senders);

                // Renegotiate so the new transceiver is created on the
                // remote side and the receiving peer fires `ontrack`.
                if (pc.signalingState === 'stable') {
                    try {
                        const offer = await pc.createOffer();
                        await pc.setLocalDescription(offer);
                        wsSend('meeting_signal', { meetingId, targetUserId: peerId, signal: { type: 'offer', sdp: pc.localDescription } });
                    } catch { /* ignore */ }
                }

                // Tell the receiving peer which incoming track id is the
                // screen share so they can route it to PresenterView
                // instead of the participant tile.
                wsSend('meeting_screen_track_id', {
                    meetingId,
                    targetUserId: peerId,
                    sharing: true,
                    trackId: screenVideoTrack.id,
                });
            }

            // Auto-stop when the browser-level "Stop sharing" button is clicked
            screenVideoTrack.onended = () => {
                if (screenSharingRef.current) toggleScreenShare();
            };

            wsSend('meeting_track_state', { meetingId, muted: mutedRef.current, videoOff: videoOffRef.current, screenSharing: true });
        }
    }, [screenSharing, meetingId, wsSend, user?.id]);

    const raiseHand = useCallback(() => {
        const next = !raisedHand;
        setRaisedHand(next);
        // Phase 2 — at-least-once delivery for the hand-toggle. The server
        // dedupes by (tenantId, senderId, type, clientMsgId) so the auto-
        // reconnect retry path can re-send the same toggle without
        // re-flipping the broadcast for every other participant.
        wsSend('meeting_raise_hand', { meetingId, raised: next, clientMsgId: newClientMsgId() });
    }, [raisedHand, meetingId, wsSend]);

    /**
     * Enqueue an outgoing chat payload + send-or-queue.
     *
     * The payload's `clientMsgId` lives in TWO places:
     *   • on the optimistic message in `messages` (so dedup against the
     *     server echo / ack is trivial)
     *   • in `pendingSendsRef` (so the retry loop and `retryMessage` can
     *     re-send the same logical message after a WS hiccup)
     */
    const enqueueChatSend = useCallback((payload, optimisticPatch) => {
        const clientMsgId = payload.clientMsgId || newClientMsgId();
        const fullPayload = { ...payload, clientMsgId, meetingId };
        const now = Date.now();
        pendingSendsRef.current.set(clientMsgId, {
            payload: fullPayload,
            firstSentAt: now,
            lastSentAt: now,
        });
        setMessages(prev => [
            ...prev,
            {
                clientMsgId,
                sender_id: user?.id,
                sender_name: user?.full_name || user?.username || 'You',
                created_at: new Date(now).toISOString(),
                _optimistic: true,
                ...optimisticPatch,
            },
        ]);
        wsSend('meeting_chat', fullPayload);
        return clientMsgId;
    }, [meetingId, wsSend, user]);

    const sendChatMessage = useCallback((text) => {
        if (!text || !text.trim()) return;
        const trimmed = text.trim();
        enqueueChatSend({ text: trimmed }, { text: trimmed });
    }, [enqueueChatSend]);

    const sendChatFile = useCallback(async (file) => {
        if (!file) return;
        const formData = new FormData();
        formData.append('file', file);
        const previewUrl = URL.createObjectURL(file);
        // Use a stable clientMsgId so the optimistic row, the upload, and
        // the WS broadcast all share one identity.
        const clientMsgId = newClientMsgId();

        // Optimistic row first — gives the user immediate feedback even
        // while the upload is in flight.
        setMessages(prev => [
            ...prev,
            {
                clientMsgId,
                sender_id: user?.id,
                sender_name: user?.full_name || user?.username || 'You',
                file_name: file.name,
                file_size: file.size,
                file_url: previewUrl,
                created_at: new Date().toISOString(),
                _optimistic: true,
                _uploading: true,
            },
        ]);

        try {
            const convId = sessionStorage.getItem('meeting_conv_id');
            if (convId) {
                const res = await uploadChatFile(convId, formData);
                enqueueChatSend(
                    {
                        clientMsgId,
                        file_url: res.data.fileUrl,
                        file_name: res.data.fileName,
                        file_size: res.data.fileSize,
                    },
                    { file_name: res.data.fileName, file_size: res.data.fileSize, file_url: res.data.fileUrl, _uploading: false }
                );
                // The optimistic row was created above; enqueueChatSend
                // adds a SECOND row. Collapse by clientMsgId.
                setMessages(prev => {
                    const idx = prev.findIndex((m, i) => m.clientMsgId === clientMsgId && i !== prev.length - 1);
                    if (idx < 0) return prev;
                    const next = prev.slice();
                    next.splice(idx, 1); // keep the latest, which has the resolved file_url
                    return next;
                });
            } else {
                // No conversation context — degrade to filename-as-text.
                enqueueChatSend(
                    { clientMsgId, text: `📎 ${file.name}`, file_name: file.name, file_size: file.size },
                    { text: `📎 ${file.name}`, file_name: file.name, file_size: file.size, _uploading: false }
                );
                setMessages(prev => {
                    const idx = prev.findIndex((m, i) => m.clientMsgId === clientMsgId && i !== prev.length - 1);
                    if (idx < 0) return prev;
                    const next = prev.slice();
                    next.splice(idx, 1);
                    return next;
                });
            }
        } catch {
            markMessageStatus(clientMsgId, { _failed: true, _uploading: false, _failureReason: 'upload-failed' });
        }
        setTimeout(() => URL.revokeObjectURL(previewUrl), 60_000);
    }, [enqueueChatSend, markMessageStatus, user]);

    /** Re-send a previously-failed chat message (UI's "tap to retry"). */
    const retryMessage = useCallback((clientMsgId) => {
        if (!clientMsgId) return;
        const entry = pendingSendsRef.current.get(clientMsgId);
        if (!entry) {
            // Was already acked / cleared. Nothing to do.
            markMessageStatus(clientMsgId, { _failed: false });
            return;
        }
        entry.firstSentAt = Date.now();
        entry.lastSentAt = Date.now();
        markMessageStatus(clientMsgId, { _failed: false, _failureReason: null, _optimistic: true });
        wsSend('meeting_chat', entry.payload);
    }, [markMessageStatus, wsSend]);

    // Periodic pending-send retry loop. Runs every PENDING_SEND_RETRY_EVERY_MS;
    // resends anything still pending, and after PENDING_SEND_FAIL_AFTER_MS
    // flips the optimistic bubble to `_failed` so the UI offers a retry.
    useEffect(() => {
        const t = setInterval(() => {
            const now = Date.now();
            const w = wsRef.current;
            const wsOpen = w && w.readyState === 1;
            for (const [clientMsgId, entry] of pendingSendsRef.current) {
                const age = now - entry.firstSentAt;
                const sinceLast = now - entry.lastSentAt;
                if (age > PENDING_SEND_FAIL_AFTER_MS) {
                    markMessageStatus(clientMsgId, { _failed: true, _failureReason: 'timeout' });
                }
                if (wsOpen && sinceLast > PENDING_SEND_RETRY_EVERY_MS) {
                    entry.lastSentAt = now;
                    try { w.send(JSON.stringify({ type: 'meeting_chat', data: entry.payload })); } catch { /* ignore */ }
                }
            }
        }, 1500);
        return () => clearInterval(t);
    }, [markMessageStatus]);

    // On every WS open:
    //   1. Drain anything that was waiting for the socket (pending-send
    //      retry queue gets a fast-path retry).
    //   2. Ask the server to replay any chat messages we missed while
    //      disconnected (`meeting_chat_replay` with `sinceMessageId =
    //      highest id we've already seen`). The REST hydration runs in
    //      parallel; the WS path is just faster and avoids the round-trip
    //      to the meetings endpoint when the gap is tiny.
    useEffect(() => {
        if (!ws) return;
        const flushAndReplay = () => {
            const now = Date.now();
            for (const [, entry] of pendingSendsRef.current) {
                entry.lastSentAt = now;
                try { ws.send(JSON.stringify({ type: 'meeting_chat', data: entry.payload })); } catch { /* ignore */ }
            }
            if (meetingId) {
                // Find the highest persisted id we already have. Use a
                // simple reduce — the message list is small (<200 typical).
                let highest = 0;
                for (const m of messages) {
                    if (typeof m.id === 'number' && m.id > highest) highest = m.id;
                }
                try {
                    ws.send(JSON.stringify({
                        type: 'meeting_chat_replay',
                        data: { meetingId, sinceMessageId: highest },
                    }));
                } catch { /* ignore */ }
            }
        };
        if (ws.readyState === 1) {
            // Already open at mount; drain immediately.
            flushAndReplay();
        }
        ws.addEventListener('open', flushAndReplay);
        return () => { try { ws.removeEventListener('open', flushAndReplay); } catch { /* ignore */ } };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [ws, meetingId]);

    const cleanupMedia = useCallback(() => {
        if (screenStreamRef.current) { screenStreamRef.current.getTracks().forEach(t => t.stop()); screenStreamRef.current = null; setScreenStream(null); }
        if (localStreamRef.current) { localStreamRef.current.getTracks().forEach(t => t.stop()); localStreamRef.current = null; setLocalStream(null); }
        pcsRef.current.forEach(pc => { try { pc.close(); } catch { } }); pcsRef.current.clear();
        if (qualityTimerRef.current) { clearInterval(qualityTimerRef.current); qualityTimerRef.current = null; }
    }, []);

    const endMeeting = useCallback(() => { wsSend('meeting_end', { meetingId }); cleanupMedia(); setStatus('ended'); }, [meetingId, wsSend, cleanupMedia]);
    const leaveMeeting = useCallback(() => { wsSend('meeting_leave', { meetingId }); cleanupMedia(); setStatus('left'); }, [meetingId, wsSend, cleanupMedia]);
    const muteParticipant = useCallback((targetUserId, muted = true) => {
        // Phase 2 — at-least-once delivery: host clicks "mute" once, the
        // network drops, the auto-reconnect retries the message. With
        // clientMsgId the second arrival is a free no-op instead of
        // flipping the target's mic state back and forth.
        wsSend('meeting_mute_participant', { meetingId, targetUserId, muted, clientMsgId: newClientMsgId() });
    }, [meetingId, wsSend]);
    const addParticipant = useCallback((targetUserId) => { wsSend('meeting_add_participant', { meetingId, targetUserId }); }, [meetingId, wsSend]);

    const switchAudioDevice = useCallback(async (deviceId) => {
        try {
            const ns = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: deviceId } } });
            const nt = ns.getAudioTracks()[0];
            if (!nt || !localStreamRef.current) return;
            const old = localStreamRef.current.getAudioTracks()[0];
            if (old) { localStreamRef.current.removeTrack(old); old.stop(); }
            localStreamRef.current.addTrack(nt);
            nt.enabled = !mutedRef.current;
            for (const [, pc] of pcsRef.current) { const s = pc.getSenders().find(s => s.track?.kind === 'audio'); if (s) await s.replaceTrack(nt).catch(() => { }); }
            setLocalStream(new MediaStream(localStreamRef.current.getTracks()));
        } catch { /* ignore */ }
    }, []);

    const switchVideoDevice = useCallback(async (deviceId) => {
        try {
            const ns = await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: deviceId } } });
            const nt = ns.getVideoTracks()[0];
            if (!nt || !localStreamRef.current) return;
            const old = localStreamRef.current.getVideoTracks()[0];
            if (old) { localStreamRef.current.removeTrack(old); old.stop(); }
            localStreamRef.current.addTrack(nt);
            nt.enabled = !videoOffRef.current;
            for (const [, pc] of pcsRef.current) { const s = pc.getSenders().find(s => s.track?.kind === 'video'); if (s) await s.replaceTrack(nt).catch(() => { }); }
            setLocalStream(new MediaStream(localStreamRef.current.getTracks()));
        } catch { /* ignore */ }
    }, []);

    // ─── Phase 5 — Local audio-level publisher ─────────────────────────────
    // Sample the local mic's RMS via a WebAudio analyser ~5×/s and broadcast
    // as `meeting_audio_level`. The receiver-side timer below picks the
    // loudest publisher in the last 2 s as the active speaker.
    //
    // We mount our own AudioContext + analyser (the participant tile already
    // has its own per-tile analyser, but it's scoped to *remote* tracks for
    // speaking ring detection — sampling our own mic separately keeps the
    // graph trivial and avoids touching the tile's render path).
    useEffect(() => {
        if (!localStream || muted) return;
        const audioTrack = localStream.getAudioTracks?.()[0];
        if (!audioTrack) return;
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (!AudioCtx) return;
        let ctx;
        try { ctx = new AudioCtx(); } catch { return; }
        let cancelled = false;
        let timer = null;
        let source, analyser;
        try {
            const audioOnly = new MediaStream([audioTrack]);
            source = ctx.createMediaStreamSource(audioOnly);
            analyser = ctx.createAnalyser();
            analyser.fftSize = 256;
            analyser.smoothingTimeConstant = 0.7;
            source.connect(analyser);
        } catch {
            try { ctx.close(); } catch { /* ignore */ }
            return;
        }
        if (ctx.state === 'suspended') ctx.resume().catch(() => { /* ignore */ });
        const data = new Uint8Array(analyser.frequencyBinCount);
        let lastSent = 0;
        const tick = () => {
            if (cancelled) return;
            analyser.getByteFrequencyData(data);
            let sum = 0;
            for (let i = 0; i < data.length; i++) sum += data[i];
            const level = Math.min(1, (sum / data.length) / 128);
            // Always update our local entry so the active-speaker timer
            // can rank us against everyone else.
            audioLevelsRef.current.set(user?.id, { level, at: performance.now() });
            // Throttle WS sends to ~2/s and only when there's audible
            // activity, so we don't flood the channel with silence.
            const now = Date.now();
            if (level > 0.05 && now - lastSent > 500) {
                lastSent = now;
                wsSend('meeting_audio_level', { meetingId, level: +level.toFixed(3) });
            }
        };
        timer = setInterval(tick, 200);
        return () => {
            cancelled = true;
            if (timer) clearInterval(timer);
            try { source.disconnect(); } catch { /* ignore */ }
            try { analyser.disconnect(); } catch { /* ignore */ }
            try { ctx.close(); } catch { /* ignore */ }
        };
    }, [localStream, muted, meetingId, wsSend, user?.id]);

    // ─── Phase 5 — Active-speaker selector ──────────────────────────────────
    // Picks the user with the highest recent audio level (within the last
    // 2 s). Updates ~3×/s — slow enough to avoid flicker between two
    // close-volume speakers, fast enough to feel responsive.
    useEffect(() => {
        const t = setInterval(() => {
            const now = performance.now();
            let bestId = null;
            let bestLevel = 0;
            for (const [uid, { level, at }] of audioLevelsRef.current) {
                if (now - at > 2_000) continue;       // stale → ignore
                if (level < 0.08) continue;           // below speaking floor
                if (level > bestLevel) { bestLevel = level; bestId = uid; }
            }
            setActiveSpeakerId(prev => (prev === bestId ? prev : bestId));
        }, 350);
        return () => clearInterval(t);
    }, []);

    // ─── Phase 5 — Adaptive bitrate from active speaker + presenter ────────
    // When the set of "active speaker" / "presenter" changes, downgrade
    // everyone who isn't either to 'h' (half-rate). The presenter (and
    // the active speaker if different) gets 'f' (full). Off-screen tiles
    // are downgraded further to 'q' by the IntersectionObserver hook in
    // ParticipantTile via the exported `requestPeerQuality` helper.
    useEffect(() => {
        if (participants.size === 0) return;
        for (const [peerId] of participants) {
            if (peerId === user?.id) continue;
            const isPresenterPeer = peerId === presenterId;
            const isSpeaker = peerId === activeSpeakerId;
            const level = (isPresenterPeer || isSpeaker) ? 'f' : 'h';
            requestPeerQuality(peerId, level);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeSpeakerId, presenterId, participants.size]);

    // Pre-compute the banner descriptor so the consumer doesn't have to
    // know about the FSM module to render it.
    const connectionBanner = describeState(fsmState);

    // ADR-008 — Mirror the high-traffic slices into the singleton
    // MeetingStore. Sibling components (admin panels, future
    // ParticipantTile selector consumers) can now subscribe to
    // `meetingStore(s => s.muted)` etc. without re-rendering on every
    // unrelated state tick.
    //
    // Cheap: setState is a shallow merge, the store does its own ref
    // equality so unchanged values produce zero subscriber callbacks.
    // We deliberately mirror only the slices that change at low-to-medium
    // frequency — high-frequency stuff (audio levels, peer connection
    // state) stays in refs to avoid store churn.
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
        muted, videoOff, screenSharing, raisedHand,
        status, fsmState, connectionBanner,
        activeSpeakerId, presenterId, messages,
    ]);

    return {
        localStream, screenStream, muted, videoOff, screenSharing,
        participants, status, raisedHand, messages,
        activePanel, setActivePanel, connectionQualities, presenterId,
        toggleMute, toggleVideo, toggleScreenShare, raiseHand,
        sendChatMessage, sendChatFile, retryMessage,
        endMeeting, leaveMeeting, muteParticipant, addParticipant,
        switchAudioDevice, switchVideoDevice, handleWsMessage,
        // Phase 1 — Resilience Pack additions:
        fsmState, connectionBanner,
        // Phase 5 — Mesh quality additions:
        activeSpeakerId,
        /**
         * Receiver-driven quality request used by ParticipantTile's
         * IntersectionObserver: tile reports 'q' when off-screen, 'h'
         * when visible (the active-speaker effect then overrides to 'f'
         * for the speaker/presenter).
         */
        requestPeerQuality,
    };
}

// Silence the unused-warning for these helpers — they're exported for tests
// and may be consumed by Phase-4 store work; keeping them adjacent to the
// hook documents the chat-reliability seam.
void upsertCachedMessage;
void applyCachedMessages;

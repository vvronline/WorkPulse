/* eslint-disable @typescript-eslint/no-explicit-any */
import { useState, useEffect, useRef, useCallback } from "react";
import { getIceConfig } from "../../../api";
import {
    applyVideoEncodingTarget,
    VIDEO_ENCODING_TARGETS,
} from "./callQuality";
import {
    forgetInboundSignal,
    rememberInboundSignal,
} from "./callSignalDeduplicator";

// Default ICE servers used when the server's /ice-config request fails.
// Includes the free Metered Open Relay TURN service so calls still work for
// peers behind restrictive NATs (same-NAT-no-hairpinning, symmetric NAT, etc.)
// even if the backend hasn't exposed a TURN configuration.
const FALLBACK_ICE_SERVERS: RTCIceServer[] = [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    { urls: "stun:stun2.l.google.com:19302" },
    { urls: "turn:openrelay.metered.ca:80", username: "openrelayproject", credential: "openrelayproject" },
    { urls: "turn:openrelay.metered.ca:443", username: "openrelayproject", credential: "openrelayproject" },
    { urls: "turn:openrelay.metered.ca:443?transport=tcp", username: "openrelayproject", credential: "openrelayproject" }
];

// P1.8 — Deterministic ICE-config gating. A config has "real" (provisioned)
// TURN only when the server returned managed credentials (Cloudflare Calls /
// self-hosted coturn / a static 3rd-party provider) rather than the public
// Open Relay fallback or STUN-only. The server's `mode` is authoritative
// (cloudflare-calls | coturn-rest | static = real; public-fallback | stun-only
// = fallback). When `mode` is absent (older server) we sniff the URLs for a
// non-openrelay turn:/turns: entry. The FIRST offer/answer must never be
// negotiated against the public-only fallback: on a network that requires a
// relay this makes the first call hang ("Connecting…") even though a retry
// works once the real creds are cached — the classic "fresh load: first call
// doesn't connect" bug.
// P1.9 — Gate the public Open Relay TURN fallback. The server's /ice-config
// returns `allowPublicFallback`; when it is FALSE the client must NOT relay
// through the public openrelay.metered.ca service (a deployment that disabled
// DISABLE_PUBLIC_TURN must not be silently bypassed by the client's hard-coded
// FALLBACK_ICE_SERVERS). STUN is ALWAYS allowed; only public TURN URLs are
// stripped. Returns the servers unchanged when public fallback is allowed.
function applyPublicTurnPolicy(servers: RTCIceServer[], allowPublic: boolean): RTCIceServer[] {
    if (allowPublic) return servers;
    const out: RTCIceServer[] = [];
    for (const s of servers || []) {
        const urls = Array.isArray(s?.urls) ? s.urls : [s?.urls];
        const kept = urls.filter(
            (u) => typeof u === "string" && !u.toLowerCase().includes("openrelay.metered.ca"),
        );
        if (kept.length === 0) continue; // entry was entirely public TURN — drop it
        out.push({ ...s, urls: kept.length === 1 ? kept[0] : kept });
    }
    return out;
}

const REAL_TURN_MODES = new Set(["cloudflare-calls", "coturn-rest", "static"]);
function hasRealTurn(cfg: { mode?: string; iceServers?: RTCIceServer[] } | null | undefined): boolean {
    if (!cfg) return false;
    if (cfg.mode && REAL_TURN_MODES.has(cfg.mode)) return true;
    const servers = cfg.iceServers || [];
    for (const s of servers) {
        const urls = Array.isArray(s?.urls) ? s.urls : [s?.urls];
        for (const u of urls) {
            if (typeof u !== "string") continue;
            const lower = u.toLowerCase();
            if ((lower.startsWith("turn:") || lower.startsWith("turns:")) &&
                !lower.includes("openrelay.metered.ca")) {
                return true;
            }
        }
    }
    return false;
}

/**
 * Progressively-relaxed audio/video constraints. Each step is attempted in
 * order until getUserMedia succeeds. This is essential on mobile networks /
 * older devices where ideal constraints (1280x720@30fps) often fail.
 */
function buildMediaConstraintProfiles(isVideoCall: boolean, isMobile: boolean): MediaStreamConstraints[] {
    const audio: MediaTrackConstraints = {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
    };
    if (!isVideoCall) {
        return [
            { audio, video: false },
            { audio: true, video: false }, // last-resort: bare audio
        ];
    }
    if (isMobile) {
        return [
            { audio, video: { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 24, max: 30 }, facingMode: "user" } },
            { audio, video: true },
            { audio, video: false },
        ];
    }
    return [
        { audio, video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 }, facingMode: "user" } },
        { audio, video: { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 24, max: 30 }, facingMode: "user" } },
        { audio, video: { width: { ideal: 320 }, height: { ideal: 240 }, frameRate: { ideal: 15, max: 24 }, facingMode: "user" } },
        { audio, video: true },
        { audio, video: false },
    ];
}

interface UseWebRTCParams {
    callState: any;
    callType: string;
    wsSend: (type: string, payload: any) => void;
    onEnd: () => void;
    onStatusChange: (status: string) => void;
}

export default function useWebRTC({ callState, callType, wsSend, onEnd, onStatusChange }: UseWebRTCParams) {
    const {
        callId, conversationId, isIncoming, callerId, acceptedBy,
        accepted, onSignal, onEndExternal, localStream, isReconnect, reconnectTo,
        preAccepted, peerReadyNonce
    } = callState;

    const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
    // P0.6 — keep the latest callId in a ref so the long-lived RTCPeerConnection
    // event handlers (created via useCallback that does NOT depend on callId)
    // always include the CURRENT callId in their `call_signal` payloads. The
    // server needs callId to buffer offer/ICE for a not-yet-subscribed callee
    // (push / cold-start / lock-screen answer). For an OUTGOING call the id is
    // only known after `call_started`, so a plain closure would capture the
    // initial `undefined`.
    const callIdRef = useRef(callId);
    callIdRef.current = callId;
    const [remoteVideoOff, setRemoteVideoOff] = useState(false);
    const [remoteHasVideo, setRemoteHasVideo] = useState(false);
    const [remoteMuted, setRemoteMuted] = useState(false);
    const [remoteScreenSharing, setRemoteScreenSharing] = useState(false);
    // Peer's self-reported connection quality (via the `quality-state` signal).
    // Drives a Teams/Meet-style "<name>'s connection is unstable" banner so a
    // freeze/stutter is attributed to the correct side. Mobile already emits
    // this; the server now whitelists it (see VALID_SIGNAL_TYPES in ws.ts).
    const [remotePeerQuality, setRemotePeerQuality] = useState<"good" | "fair" | "poor" | "unknown">("unknown");
    // Last quality value we SENT to the peer — used to only emit on a real
    // change (not every sample) so we don't spam the relay.
    const lastSentQualityRef = useRef<string | null>(null);

    // Track whether the *local* user has their camera explicitly off, so the
    // peer can be told and render an avatar instead of a frozen black frame.
    const [localVideoOff, setLocalVideoOff] = useState(false);

    const pcRef = useRef<RTCPeerConnection | null>(null);
    const localStreamRef = useRef<MediaStream | null>(null);
    const screenStreamRef = useRef<MediaStream | null>(null);
    const remoteStreamRef = useRef<MediaStream | null>(null);
    const localVideoRef = useRef<HTMLVideoElement | null>(null);
    const remoteVideoRef = useRef<HTMLVideoElement | null>(null);
    const remoteAudioRef = useRef<HTMLAudioElement | null>(null);
    const pendingSignalsRef = useRef<any[]>([]);
    const seenSignalIdsRef = useRef(new Set<string>());
    const screenSenderRef = useRef<RTCRtpSender | null>(null);
    const connectionTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const ringtoneRef = useRef<any>(null);
    const handleEndRef = useRef<(() => void) | null>(null);
    const iceRestartAttemptedRef = useRef(false);
    const disconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    // P1.10 — Black-video watchdog. A few seconds after `connected`, if a video
    // call still has no live remote video track, ask the peer to re-announce
    // their `video-state` once (recovers a dropped/late original video-state so
    // we stop painting a black tile with no avatar). Armed in
    // onconnectionstatechange, cleared on teardown; gated to once per call.
    const remoteVideoWatchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const videoStateRequestedRef = useRef(false);
    const pendingIceCandidatesRef = useRef<any[]>([]);
    const iceServersRef = useRef<RTCIceServer[]>(FALLBACK_ICE_SERVERS);
    const iceExpiresAtRef = useRef(0);
    const relayOnlyRef = useRef(false); // set true after a UDP-relay failure to force TURN/TCP/TLS only
    // ── Perfect Negotiation (glare handling) ──────────────────────────────
    // Both peers can offer simultaneously (initial offer + ICE-restart +
    // renegotiation). The callee is POLITE (rolls back + accepts the incoming
    // offer on collision); the caller is IMPOLITE (ignores it, keeps its own).
    // makingOfferRef marks our own offer-in-flight window so a colliding
    // inbound offer is detected as glare and handled instead of throwing
    // "Failed to set remote description: wrong state".
    const politeRef = useRef(!!isIncoming);
    const makingOfferRef = useRef(false);
    const networkOnlineRef = useRef(navigator.onLine);
    const initialIceConfigLoadedRef = useRef(false);
    // P1.8 — whether the CURRENTLY-loaded ICE config carries real, provisioned
    // TURN (Cloudflare/coturn/static) rather than the public Open Relay / STUN
    // fallback. Drives the deterministic gate in waitForIceConfig so the FIRST
    // negotiation never proceeds against the public-only fallback when real TURN
    // is still in flight.
    const iceHasRealTurnRef = useRef(false);
    // P1.9 — whether the server permits the public Open Relay TURN fallback for
    // this client. Defaults to true (backwards-compat for older servers that
    // don't send `allowPublicFallback`). When false, the public
    // openrelay.metered.ca TURN entries are stripped from the ICE list we hand
    // to RTCPeerConnection (STUN is always kept).
    const iceAllowPublicRef = useRef(true);
    // P1.8 — set once the very first offer/answer for this call has begun. After
    // that we no longer block on real-TURN arrival (a later ICE-restart /
    // renegotiation must proceed promptly with whatever creds we have); only the
    // FIRST connection is gated on genuine TURN.
    const firstNegotiationStartedRef = useRef(false);
    const deferredOfferRef = useRef<any>(null);
    const preWarmStreamRef = useRef<any>(null);
    const preWarmAbortRef = useRef(false);
    const bitrateRampTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

    // Fetch ICE config (STUN + optional TURN). Re-fetch when credentials are
    // about to expire (coturn ephemeral REST API issues short-lived creds).
    const refreshIceConfig = useCallback(async () => {
        try {
            const { data } = await getIceConfig();
            if (data?.iceServers?.length) {
                iceServersRef.current = data.iceServers;
                iceExpiresAtRef.current = data.expiresAt || 0;
                initialIceConfigLoadedRef.current = true;
                // P1.9 — honour the server's public-TURN policy. Absent on older
                // servers → treated as allowed for backwards-compat.
                iceAllowPublicRef.current = data.allowPublicFallback !== false;
                // P1.8 — record whether this config carries real, provisioned TURN
                // so the first-negotiation gate can fast-exit / decide to keep
                // waiting for genuine creds.
                iceHasRealTurnRef.current = hasRealTurn(data);
                console.log("[call-webrtc] ICE config refreshed (mode:", data.mode || "unknown", ", expiresAt:", data.expiresAt || "never", ", realTurn:", iceHasRealTurnRef.current, ")");
            }
        } catch (err: any) {
            console.warn("[call-webrtc] ICE config fetch failed, using fallback:", err?.message || err);
        }
    }, []);

    const waitForIceConfig = useCallback(async (timeoutMs = 2000) => {
        // P1.8 — DETERMINISTIC ICE-CONFIG GATING. Two distinct waits:
        //   1. Wait for ANY config to load (the live fetch finished).
        //   2. On the FIRST negotiation, ADDITIONALLY wait (bounded) for REAL,
        //      provisioned TURN to arrive — never negotiate the first
        //      offer/answer against the public Open Relay / STUN-only fallback.
        //      On a network that requires a relay, doing so makes the first call
        //      hang ("Connecting…") even though a retry works once the real
        //      creds are cached (the classic "fresh load: first call doesn't
        //      connect" bug). A later ICE-restart / renegotiation must proceed
        //      promptly, so only the FIRST connection is gated on genuine TURN.
        const start = Date.now();

        // Stage 1 — ensure SOME config is loaded.
        if (!initialIceConfigLoadedRef.current) {
            while (!initialIceConfigLoadedRef.current && (Date.now() - start) < timeoutMs) {
                await new Promise(r => setTimeout(r, 100));
            }
            if (!initialIceConfigLoadedRef.current) {
                console.warn("[call-webrtc] ICE config not loaded after", timeoutMs, "ms — proceeding with fallback");
            }
        }

        // Stage 2 — FIRST-negotiation real-TURN gate. Only blocks the very first
        // offer/answer of this call, and only when we don't already have
        // provisioned TURN. If real TURN never shows up within the deadline we
        // proceed with what we have (the recovery ladder / relay-only rebuild
        // still applies) rather than hanging forever. We actively re-fetch once
        // since the initial config may have resolved to the public fallback
        // before the managed creds were ready.
        if (!firstNegotiationStartedRef.current && !iceHasRealTurnRef.current) {
            // P-RELIABILITY — Cloudflare TURN creds are minted+cached server-side
            // and warmed at app start, so the genuine TURN config is almost
            // always already available by the time we negotiate. Cap the
            // first-negotiation real-TURN wait TIGHT (~1.5s, down from 6s) so we
            // never eat into the connect budget waiting for creds that are
            // usually already here — the long wait was a primary "call sometimes
            // doesn't connect" cause. If real TURN still hasn't landed we proceed
            // with what we have; the recovery ladder rebuilds relay-only on stall.
            const REAL_TURN_DEADLINE_MS = Math.max(timeoutMs, 1500);
            let refetched = false;
            while (!iceHasRealTurnRef.current && (Date.now() - start) < REAL_TURN_DEADLINE_MS) {
                if (!refetched) {
                    refetched = true;
                    // Best-effort: ask the server again in case the first config
                    // landed before managed TURN creds were provisioned.
                    void refreshIceConfig();
                }
                await new Promise(r => setTimeout(r, 150));
            }
            if (!iceHasRealTurnRef.current) {
                console.warn("[call-webrtc] real TURN not available before first negotiation — proceeding with fallback ICE");
            }
        }
        firstNegotiationStartedRef.current = true;
    }, [refreshIceConfig]);

    useEffect(() => {
        refreshIceConfig();
        // Periodically check if creds are about to expire and refresh proactively.
        const checkInterval = setInterval(() => {
            const expiresAt = iceExpiresAtRef.current;
            if (expiresAt && expiresAt - Math.floor(Date.now() / 1000) < 300) {
                refreshIceConfig();
            }
        }, 60_000);
        return () => clearInterval(checkInterval);
    }, [refreshIceConfig]);

    const stopRingtone = useCallback(() => {
        if (ringtoneRef.current) {
            try { ringtoneRef.current.osc.stop(); ringtoneRef.current.ctx.close(); } catch { /* noop */ }
            ringtoneRef.current = null;
        }
    }, []);

    // ─── Media helpers ───
    // Tries progressively-relaxed constraint profiles so the call still
    // succeeds on weak mobile networks, low-end webcams, or when the user has
    // an audio device but no working camera. Bubbles up a single useful error
    // message rather than silently dropping the call.
    const startMedia = useCallback(async (): Promise<MediaStream | null> => {
        if (!navigator.mediaDevices?.getUserMedia) {
            alert("Your browser does not support audio/video calls. Please use Chrome, Edge, Firefox or Safari over HTTPS.");
            return null;
        }
        const profiles = buildMediaConstraintProfiles(callType === "video", isMobile);
        let lastError: any = null;

        for (let i = 0; i < profiles.length; i++) {
            const constraints = profiles[i];
            try {
                const stream = await navigator.mediaDevices.getUserMedia(constraints);
                if (i > 0) {
                    console.warn("[call-webrtc] media acquired with reduced profile #" + i, constraints);
                }
                localStreamRef.current = stream;
                if (localVideoRef.current && callType === "video" && stream.getVideoTracks().length) {
                    localVideoRef.current.srcObject = stream;
                }
                return stream;
            } catch (err: any) {
                lastError = err;
                console.warn("[call-webrtc] getUserMedia profile", i, "failed:", err?.name, err?.message);
                // Permission denial / device unavailable are unrecoverable — stop early.
                if (err?.name === "NotAllowedError" || err?.name === "SecurityError") break;
            }
        }

        console.error("[call-webrtc] getUserMedia exhausted all profiles:", lastError);
        const device = callType === "video" ? "camera/microphone" : "microphone";
        if (lastError?.name === "NotAllowedError") {
            alert(`${device} access is blocked.\n\n1. Click the lock/tune icon in the address bar → allow ${device}\n2. If the setting is locked, your organization may be blocking it — contact your IT admin to whitelist this site`);
        } else if (lastError?.name === "NotFoundError" || lastError?.name === "OverconstrainedError") {
            alert(`No usable ${device} found on this device.\n\nCheck:\n• Camera/mic is plugged in and not used by another app\n• Browser tab has permission (lock icon → Site Settings)\n• On Windows: Settings → Privacy → Camera/Microphone → Allow desktop apps`);
        } else if (lastError?.name === "NotReadableError" || lastError?.name === "TrackStartError") {
            alert(`Your ${device} is in use by another application (e.g. Zoom, Teams, Skype). Please close that app and try again.`);
        } else if (lastError) {
            alert(`Could not access ${device}: ${lastError.message || lastError.name}`);
        }
        return null;
    }, [callType]);

    const cleanup = useCallback(() => {
        if (screenStreamRef.current) {
            screenStreamRef.current.getTracks().forEach(t => t.stop());
            screenStreamRef.current = null;
        }
        if (localStreamRef.current) {
            localStreamRef.current.getTracks().forEach(t => t.stop());
            localStreamRef.current = null;
        }
        if (remoteAudioRef.current) remoteAudioRef.current.srcObject = null;
        if (pcRef.current) { pcRef.current.close(); pcRef.current = null; }
        pendingSignalsRef.current = [];
        pendingIceCandidatesRef.current = [];
        seenSignalIdsRef.current.clear();
        if (connectionTimeoutRef.current) clearTimeout(connectionTimeoutRef.current);
        if (disconnectTimerRef.current) clearTimeout(disconnectTimerRef.current);
        // P1.10 — stop the black-video watchdog so it can't fire post-teardown.
        if (remoteVideoWatchdogRef.current) { clearTimeout(remoteVideoWatchdogRef.current); remoteVideoWatchdogRef.current = null; }
        bitrateRampTimersRef.current.forEach(t => clearTimeout(t));
        bitrateRampTimersRef.current = [];
        iceRestartAttemptedRef.current = false;
    }, []);

    const applyBitrateRampUp = useCallback((pc: RTCPeerConnection | null) => {
        if (!pc) return;
        const INITIAL_BITRATE = isMobile ? 300_000 : 400_000;
        const TARGET_BITRATE = isMobile ? 800_000 : VIDEO_ENCODING_TARGETS.good.maxBitrate;
        const RAMP_STEPS = 3;
        const RAMP_STEP_MS = 800;

        const setVideoBitrate = (bitrate: number) => {
            void applyVideoEncodingTarget(pc, {
                maxBitrate: bitrate,
                scaleResolutionDownBy: 1,
            });
        };

        for (const sender of pc.getSenders()) {
            if (!sender.track || sender.track.kind !== "audio") continue;
            try {
                const params = sender.getParameters();
                if (!params.encodings || params.encodings.length === 0) params.encodings = [{}];
                params.encodings[0].maxBitrate = 48_000;
                sender.setParameters(params).catch(() => { });
            } catch { /* ignore */ }
        }

        setVideoBitrate(INITIAL_BITRATE);

        for (let step = 1; step <= RAMP_STEPS; step++) {
            const timer = setTimeout(() => {
                if (pc.connectionState !== "connected") return;
                const bitrate = Math.round(INITIAL_BITRATE + ((TARGET_BITRATE - INITIAL_BITRATE) * step / RAMP_STEPS));
                setVideoBitrate(bitrate);
                if (step === RAMP_STEPS) {
                    console.log("[call-webrtc] bitrate ramp-up complete:", TARGET_BITRATE);
                }
            }, RAMP_STEP_MS * step);
            bitrateRampTimersRef.current.push(timer);
        }
    }, [isMobile]);

    const forceKeyframe = useCallback((pc: RTCPeerConnection | null) => {
        if (!pc) return;
        setTimeout(() => {
            for (const sender of pc.getSenders()) {
                if (!sender.track || sender.track.kind !== "video") continue;
                try {
                    const params = sender.getParameters();
                    if (!params.encodings?.length) continue;
                    params.encodings[0].active = false;
                    sender.setParameters(params).then(() => {
                        setTimeout(() => {
                            try {
                                const p2 = sender.getParameters();
                                if (p2.encodings?.length) {
                                    p2.encodings[0].active = true;
                                    sender.setParameters(p2).catch(() => { });
                                }
                            } catch { /* ignore */ }
                        }, 50);
                    }).catch(() => { });
                } catch { /* ignore */ }
            }
        }, 200);
    }, []);

    const addIceCandidateSafe = useCallback(async (candidate: any) => {
        if (!pcRef.current) return;
        try {
            if (candidate === null) {
                // End-of-candidates marker. Some browsers (Firefox) reject null;
                // pass an empty candidate string as a portable fallback. Failure
                // here is non-fatal — the browser will time out trickle on its own.
                try {
                    await pcRef.current.addIceCandidate(null as any);
                } catch {
                    try { await pcRef.current.addIceCandidate({ candidate: "" } as any); } catch { /* ignore */ }
                }
            } else {
                await pcRef.current.addIceCandidate(new RTCIceCandidate(candidate));
            }
        } catch (err: any) {
            // Don't let one bad candidate kill the whole ICE exchange.
            console.warn("[call-webrtc] addIceCandidate failed (ignored):", err?.message || err);
        }
    }, []);

    const flushPendingIceCandidates = useCallback(async () => {
        if (!pcRef.current?.remoteDescription) return;
        const pendingCandidates = pendingIceCandidatesRef.current.splice(0);
        console.log("[call-webrtc] flushing", pendingCandidates.length, "buffered ICE candidate(s)");
        for (const candidate of pendingCandidates) {
            await addIceCandidateSafe(candidate);
        }
    }, [addIceCandidateSafe]);

    const attachLocalTracks = useCallback(async (stream: MediaStream | null) => {
        if (!pcRef.current || !stream) return;
        const transceivers = pcRef.current.getTransceivers();
        const usedTransceivers = new Set<RTCRtpTransceiver>();

        for (const track of stream.getTracks()) {
            // Skip if this exact track is already on some sender
            const alreadyAttached = transceivers.some(t => t.sender.track && t.sender.track.id === track.id);
            if (alreadyAttached) continue;

            if (track.kind === "video") {
                try { (track as any).contentHint = "motion"; } catch { /* not supported */ }
            }

            // Find an unused transceiver of MATCHING kind that the remote offer
            // created. We must match by kind otherwise replaceTrack throws
            // "Track kind does not match Sender kind".
            const matchingTr = transceivers.find(t => {
                if (usedTransceivers.has(t)) return false;
                if (t.sender.track) return false; // already in use
                // The receiver's track kind reflects what the remote offered
                // for this transceiver's m-section.
                const trKind = t.receiver?.track?.kind;
                return trKind === track.kind;
            });

            if (matchingTr) {
                usedTransceivers.add(matchingTr);
                try {
                    await matchingTr.sender.replaceTrack(track);
                    // Upgrade the direction so we actually send media on this m-line.
                    try { matchingTr.direction = "sendrecv"; } catch { /* not always settable */ }
                    if (track.kind === "video") screenSenderRef.current = matchingTr.sender;
                } catch (err: any) {
                    console.warn("[call-webrtc] replaceTrack failed, falling back to addTrack:", err?.message || err);
                    const sender = pcRef.current.addTrack(track, stream);
                    if (track.kind === "video") screenSenderRef.current = sender;
                }
            } else {
                // No matching transceiver from the remote offer (e.g. caller
                // sent voice-only but we somehow have a video track) — addTrack
                // will create a new m-line and trigger renegotiation.
                const sender = pcRef.current.addTrack(track, stream);
                if (track.kind === "video") screenSenderRef.current = sender;
            }
        }
    }, []);

    const createPeerConnection = useCallback((stream: MediaStream | null, targetUserId: any, addTracksNow = true): RTCPeerConnection => {
        // When relayOnlyRef is true (after a previous host/srflx ICE failure), force
        // RTCPeerConnection to ignore host candidates and use TURN exclusively. This
        // is the lifeline for restrictive corporate networks that block UDP/STUN.
        const pcConfig: RTCConfiguration = {
            // P1.9 — strip the public Open Relay TURN entries when the server
            // forbids the public fallback (DISABLE_PUBLIC_TURN=true). STUN kept.
            iceServers: applyPublicTurnPolicy(iceServersRef.current, iceAllowPublicRef.current),
            iceCandidatePoolSize: 10,
            // bundlePolicy=max-bundle reduces port usage — better with corporate firewalls
            bundlePolicy: "max-bundle",
            rtcpMuxPolicy: "require",
        };
        if (relayOnlyRef.current) {
            pcConfig.iceTransportPolicy = "relay";
            console.log("[call-webrtc] creating PC in RELAY-ONLY mode (TURN-only) — corporate proxy fallback");
        }
        const pc = new RTCPeerConnection(pcConfig);
        pcRef.current = pc;

        // Track whether initial negotiation is done to avoid duplicate offers
        let initialNegotiationDone = false;

        // Surface TURN configuration so missing TURN doesn't silently break NAT traversal
        const hasTurn = (iceServersRef.current || []).some(srv => {
            const urls = Array.isArray(srv.urls) ? srv.urls : [srv.urls];
            return urls.some(u => typeof u === "string" && u.startsWith("turn"));
        });
        if (!hasTurn) {
            console.warn("[call-webrtc] No TURN server configured — calls may fail on restrictive networks. Configure TURN_HOST + TURN_STATIC_AUTH_SECRET (coturn) on the server.");
        }

        // For the OFFERER we need tracks before createOffer. For the ANSWERER,
        // tracks must be attached AFTER setRemoteDescription(offer) so they
        // bind to the existing transceivers instead of creating new m-lines.
        if (stream && addTracksNow) {
            stream.getTracks().forEach(track => {
                const sender = pc.addTrack(track, stream);
                if (track.kind === "video") {
                    screenSenderRef.current = sender;
                    try { (track as any).contentHint = "motion"; } catch { /* not supported */ }
                }
            });
        }

        // Auto-renegotiate when tracks are added/removed mid-call (e.g. screen share)
        pc.onnegotiationneeded = async () => {
            if (!initialNegotiationDone) return;
            try {
                // Mark the offer-in-flight window so a colliding inbound offer is
                // detected as glare (Perfect Negotiation).
                makingOfferRef.current = true;
                const offer = await pc.createOffer();
                await pc.setLocalDescription(offer);
                wsSend("call_signal", {
                    callId: callIdRef.current, conversationId, targetUserId,
                    signal: { type: "offer", sdp: offer.sdp }
                });
            } catch (err) {
                console.error("Renegotiation failed:", err);
            } finally {
                makingOfferRef.current = false;
            }
        };

        pc.ontrack = (e) => {
            // Defensively build the remote stream:
            //   • Some browsers/SFU configurations fire ontrack with an empty
            //     `e.streams` array — we must never let that drop the track.
            //   • ontrack fires once per kind (audio, then video). We must add
            //     each new track to the SAME MediaStream so the <video> tag
            //     plays both, instead of replacing the stream and losing audio.
            let remoteStream = remoteStreamRef.current;
            if (e.streams && e.streams[0]) {
                // Browser gave us a real stream — adopt it.
                remoteStream = e.streams[0];
            } else if (!remoteStream) {
                // Fallback: build our own stream container.
                remoteStream = new MediaStream();
            }
            // Make sure THIS track is in the stream (replaceTrack on an existing
            // transceiver does NOT add the track to e.streams[0] in some paths).
            if (e.track && !remoteStream.getTracks().some(t => t.id === e.track.id)) {
                remoteStream.addTrack(e.track);
            }
            remoteStreamRef.current = remoteStream;

            console.log("[call-webrtc] ontrack:", e.track?.kind, "muted=", e.track?.muted, "streamTracks=", remoteStream.getTracks().map(t => t.kind).join(","));

            // Attach to audio sink (always — covers both video and audio calls).
            if (remoteAudioRef.current && remoteAudioRef.current.srcObject !== remoteStream) {
                remoteAudioRef.current.srcObject = remoteStream;
                remoteAudioRef.current.volume = 1.0;
                remoteAudioRef.current.play().catch((err: any) => console.warn("[call-webrtc] remote audio autoplay blocked:", err?.message || err));
            }

            if (remoteVideoRef.current) {
                if (remoteVideoRef.current.srcObject !== remoteStream) {
                    remoteVideoRef.current.srcObject = remoteStream;
                }
                if (isMobile) remoteVideoRef.current.muted = true;
                remoteVideoRef.current.play().catch((err: any) => console.warn("[call-webrtc] remote video autoplay blocked:", err?.message || err));
            }

            if (e.track.kind === "video") {
                setRemoteHasVideo(true);
                // IMPORTANT: do NOT seed remoteVideoOff from e.track.muted —
                // per spec, a freshly received track is muted until the first
                // RTP packet arrives. Treating that as "video off" hides the
                // video forever if the unmute event is dropped (which happens
                // on some Android Chrome builds and Firefox-on-Linux). Start
                // optimistic; the onmute handler below catches the real case
                // where the remote turns their camera off mid-call.
                setRemoteVideoOff(false);
                e.track.onmute = () => {
                    console.log("[call-webrtc] remote video track muted");
                    setRemoteVideoOff(true);
                };
                e.track.onunmute = () => {
                    console.log("[call-webrtc] remote video track unmuted");
                    setRemoteVideoOff(false);
                    if (remoteVideoRef.current && remoteStreamRef.current) {
                        if (remoteVideoRef.current.srcObject !== remoteStreamRef.current) {
                            remoteVideoRef.current.srcObject = remoteStreamRef.current;
                        }
                        remoteVideoRef.current.play().catch(() => { });
                    }
                };
                e.track.onended = () => {
                    console.log("[call-webrtc] remote video track ended");
                    setRemoteHasVideo(false);
                };
            }
        };

        pc.onicecandidate = (e) => {
            if (e.candidate) {
                const c = e.candidate;
                console.log("[call-webrtc] local ICE candidate →", c.type || "?", c.protocol || "?", c.address || c.candidate?.split(" ")[4] || "?");
                // P0.7 — Reliable local-ICE transport. `wsSend` (useWebSocket
                // sendMessage) is NOT a bare fire-and-forget: when the socket is
                // momentarily not OPEN (foreground reconnect / brief network
                // blip) it QUEUES the frame (capped, drop-oldest) and
                // flushQueue() re-sends every queued frame IN ORDER on the next
                // onopen. So an ICE candidate emitted during a transient WS
                // outage is not lost — it is delivered the instant the socket
                // recovers. callId is included (P0.6) for server-side buffering.
                wsSend("call_signal", {
                    callId: callIdRef.current, conversationId, targetUserId,
                    signal: { type: "ice-candidate", candidate: c.toJSON() }
                });
            }
            // We intentionally do NOT forward the null end-of-candidates marker:
            // it is unreliable across browsers (Firefox throws on addIceCandidate(null))
            // and the peer will infer end-of-trickle from the ICE gathering timeout.
        };

        pc.onicecandidateerror = (e: any) => {
            console.warn("[call-webrtc] ICE candidate error:", e.errorCode, e.errorText, e.url);
        };

        pc.oniceconnectionstatechange = () => {
            console.log("[call-webrtc] ICE connection state:", pc.iceConnectionState);
            if (pc.iceConnectionState === "failed") {
                console.warn("[call-webrtc] ICE failed — will attempt restart. Persistent failures usually mean a TURN server is required (corporate proxy / symmetric NAT).");
                // Dump candidate-pair stats for diagnosis
                try {
                    pc.getStats().then(stats => {
                        const pairs: any[] = [];
                        stats.forEach((r: any) => {
                            if (r.type === "candidate-pair") pairs.push({ state: r.state, nominated: r.nominated, local: r.localCandidateId, remote: r.remoteCandidateId });
                        });
                        console.warn("[call-webrtc] candidate pairs:", pairs);
                    }).catch(() => { });
                } catch { /* ignore */ }
            } else if (pc.iceConnectionState === "disconnected") {
                // Brief network blip on mobile / VPN — try a fast ICE restart proactively
                // before the connectionState=failed handler tears the call down.
                if (initialNegotiationDone && !iceRestartAttemptedRef.current) {
                    setTimeout(() => {
                        if (pc.iceConnectionState === "disconnected" || pc.iceConnectionState === "failed") {
                            console.log("[call-webrtc] still disconnected after 2s — issuing ICE restart");
                            iceRestartAttemptedRef.current = true;
                            pc.createOffer({ iceRestart: true })
                                .then(o => pc.setLocalDescription(o))
                                .then(() => wsSend("call_signal", {
                                    callId: callIdRef.current, conversationId, targetUserId,
                                    signal: { type: "offer", sdp: pc.localDescription!.sdp }
                                }))
                                .catch(err => console.warn("[call-webrtc] ICE restart failed:", err));
                        }
                    }, 2000);
                }
            }
        };

        pc.onicegatheringstatechange = () => {
            console.log("[call-webrtc] ICE gathering state:", pc.iceGatheringState);
        };

        pc.onconnectionstatechange = () => {
            console.log("[call-webrtc] connection state:", pc.connectionState);
            if (pc.connectionState === "connected") {
                initialNegotiationDone = true;
                onStatusChange("connected");
                stopRingtone();
                if (disconnectTimerRef.current) clearTimeout(disconnectTimerRef.current);
                iceRestartAttemptedRef.current = false;
                applyBitrateRampUp(pc);
                forceKeyframe(pc);
                iceRestartAttemptedRef.current = false;
                // P1.10 — Black-video watchdog. If a video call still has no live
                // remote video track a few seconds after connect, the peer's
                // original `video-state` (and any track-unmute) may have been
                // dropped, leaving us painting a black tile. Ask the peer to
                // re-announce their camera state ONCE; their inbound
                // `request-video-state` handler replies with the ground truth.
                if (callType === "video" && !videoStateRequestedRef.current) {
                    if (remoteVideoWatchdogRef.current) clearTimeout(remoteVideoWatchdogRef.current);
                    remoteVideoWatchdogRef.current = setTimeout(() => {
                        remoteVideoWatchdogRef.current = null;
                        if (pcRef.current !== pc) return;
                        if (videoStateRequestedRef.current) return;
                        const remote = remoteStreamRef.current;
                        const liveRemoteVideo =
                            !!remote &&
                            remote.getVideoTracks().some(t => t.readyState !== "ended");
                        if (liveRemoteVideo) return;
                        videoStateRequestedRef.current = true;
                        const tgt = isIncoming ? callerId : (acceptedBy || reconnectTo);
                        if (!tgt) return;
                        try {
                            wsSend("call_signal", {
                                callId: callIdRef.current, conversationId, targetUserId: tgt,
                                signal: { type: "request-video-state" }
                            });
                        } catch (err: any) {
                            console.warn("[call-webrtc] request-video-state failed:", err?.message || err);
                        }
                    }, 3000);
                }
            } else if (pc.connectionState === "disconnected") {
                // Grace period: temporary network hiccup — wait 5s before ending
                if (disconnectTimerRef.current) clearTimeout(disconnectTimerRef.current);
                disconnectTimerRef.current = setTimeout(() => {
                    if (handleEndRef.current) handleEndRef.current();
                }, 5000);
            } else if (pc.connectionState === "failed") {
                if (disconnectTimerRef.current) clearTimeout(disconnectTimerRef.current);
                // Strategy: ICE restart → relay-only rebuild → give up.
                if (!iceRestartAttemptedRef.current && initialNegotiationDone) {
                    iceRestartAttemptedRef.current = true;
                    pc.createOffer({ iceRestart: true }).then(offer => {
                        return pc.setLocalDescription(offer);
                    }).then(() => {
                        wsSend("call_signal", {
                            callId: callIdRef.current, conversationId, targetUserId,
                            signal: { type: "offer", sdp: pc.localDescription!.sdp }
                        });
                    }).catch(() => {
                        if (handleEndRef.current) handleEndRef.current();
                    });
                } else if (!relayOnlyRef.current && hasTurn) {
                    // ICE restart failed too — escalate to relay-only and rebuild
                    // the connection. This is the corporate-proxy escape hatch:
                    // every byte goes through TURN over TCP/TLS so even networks
                    // that block UDP/STUN entirely can complete the call.
                    console.warn("[call-webrtc] escalating to RELAY-ONLY mode after ICE restart failed");
                    relayOnlyRef.current = true;
                    onStatusChange("reconnecting");
                    refreshIceConfig().finally(() => {
                        if (pcRef.current) { try { pcRef.current.close(); } catch { /* noop */ } pcRef.current = null; }
                        const newPc = createPeerConnection(localStreamRef.current, targetUserId, true);
                        newPc.createOffer().then(o => newPc.setLocalDescription(o)).then(() => {
                            wsSend("call_signal", {
                                callId: callIdRef.current, conversationId, targetUserId,
                                signal: { type: "offer", sdp: newPc.localDescription!.sdp }
                            });
                        }).catch(err => {
                            console.error("[call-webrtc] relay-only rebuild failed:", err);
                            if (handleEndRef.current) handleEndRef.current();
                        });
                    });
                } else {
                    if (handleEndRef.current) handleEndRef.current();
                }
            }
        };

        return pc;
    }, [conversationId, wsSend, stopRingtone, isMobile, onStatusChange, refreshIceConfig, applyBitrateRampUp, forceKeyframe]);

    // ─── Signal handling with buffering ───
    const flushPendingSignals = useCallback(() => {
        if (!pcRef.current) return;
        const pending = pendingSignalsRef.current.splice(0);
        for (const { signal, fromUserId } of pending) {
            handleSignalInternal(signal, fromUserId);
        }
    }, []);

    const handleSignalInternal = useCallback(async (signal: any, fromUserId: any) => {
        if (!pcRef.current) return;
        if (!rememberInboundSignal(signal, seenSignalIdsRef.current)) {
            console.debug("[call-webrtc] ignored replayed signal:", signal.type);
            return;
        }
        try {
            console.log("[call-webrtc] handleSignal:", signal.type, "from:", fromUserId, "pcState:", pcRef.current.signalingState);
            if (signal.type === "offer") {
                // Perfect Negotiation glare guard: an offer arriving while our
                // own offer is in flight (or we're mid-creation) is a collision.
                // Impolite peer ignores it; polite peer rolls back and accepts.
                const offerCollision =
                    makingOfferRef.current || pcRef.current.signalingState !== "stable";
                if (offerCollision) {
                    if (!politeRef.current) {
                        console.warn("[call-webrtc] ignoring colliding offer (impolite peer)");
                        return;
                    }
                    try {
                        await pcRef.current.setLocalDescription({ type: "rollback" } as RTCLocalSessionDescriptionInit);
                    } catch {
                        /* some browsers auto-rollback on setRemoteDescription(offer) */
                    }
                }
                await pcRef.current.setRemoteDescription(new RTCSessionDescription(signal));
                // CRITICAL: attach local tracks AFTER setRemoteDescription so they
                // bind to the transceivers created by the offer, instead of producing
                // extra unmatched m-sections that prevent ICE from establishing.
                await attachLocalTracks(localStreamRef.current);
                const answer = await pcRef.current.createAnswer();
                await pcRef.current.setLocalDescription(answer);
                console.log("[call-webrtc] sending answer to:", fromUserId);
                wsSend("call_signal", {
                    callId: callIdRef.current, conversationId, targetUserId: fromUserId,
                    signal: { type: "answer", sdp: answer.sdp }
                });
                await flushPendingIceCandidates();
            } else if (signal.type === "answer") {
                // Ignore stray answers when we are not expecting one (avoids
                // "Failed to set remote answer sdp: Called in wrong state").
                if (pcRef.current.signalingState !== "have-local-offer") {
                    console.warn("[call-webrtc] ignoring answer in state:", pcRef.current.signalingState);
                } else {
                    await pcRef.current.setRemoteDescription(new RTCSessionDescription(signal));
                    await flushPendingIceCandidates();
                }
            } else if (signal.type === "ice-candidate") {
                // null/empty candidate is the end-of-candidates marker. We don't
                // need to forward it to addIceCandidate — drop it silently.
                if (signal.candidate == null || signal.candidate.candidate === "") {
                    return;
                }
                if (pcRef.current.remoteDescription) {
                    await addIceCandidateSafe(signal.candidate);
                } else {
                    pendingIceCandidatesRef.current.push(signal.candidate);
                }
            } else if (signal.type === "video-state") {
                // Peer told us they toggled their outgoing video. Browsers'
                // track.onmute / track.onended are unreliable (Chrome lags
                // 5–10 s, Firefox often never fires, and removeTrack on a
                // sender does NOT reliably end the receiver's track at all),
                // so this explicit signal is the source of truth.
                const videoOff = !!signal.videoOff;
                setRemoteVideoOff(videoOff);

                if (callType !== "video") {
                    // ── Audio call ────────────────────────────────────────
                    // The only video that ever exists here is the peer's
                    // screen share. When they stop sharing we drop the video
                    // entirely so the tile collapses back to the audio UI.
                    if (videoOff) {
                        setRemoteHasVideo(false);
                        if (remoteVideoRef.current) {
                            try { remoteVideoRef.current.srcObject = null; } catch { /* ignore */ }
                        }
                        // The remote stream may also still hold a stopped
                        // video track from the peer's removeTrack — drop it
                        // so a subsequent share starts from a clean slate.
                        if (remoteStreamRef.current) {
                            remoteStreamRef.current.getVideoTracks().forEach(t => {
                                try { remoteStreamRef.current!.removeTrack(t); } catch { /* ignore */ }
                            });
                        }
                    } else if (remoteStreamRef.current?.getVideoTracks().length) {
                        // Peer is sharing again and we already have a video
                        // track on the remote stream (e.g. the renegotiation
                        // re-used the transceiver) — restore the tile.
                        setRemoteHasVideo(true);
                        if (remoteVideoRef.current && !remoteVideoRef.current.srcObject) {
                            remoteVideoRef.current.srcObject = remoteStreamRef.current;
                            remoteVideoRef.current.play().catch(() => { });
                        }
                    }
                } else {
                    // ── Video call ────────────────────────────────────────
                    if (videoOff) {
                        if (remoteVideoRef.current) {
                            try { remoteVideoRef.current.pause(); } catch { /* ignore */ }
                            try { remoteVideoRef.current.srcObject = null; } catch { /* ignore */ }
                        }
                    } else if (remoteVideoRef.current) {
                        // Build/restore the stream that drives the <video>.
                        let stream = remoteStreamRef.current;
                        if (!stream || stream.getVideoTracks().length === 0) {
                            const receivers = pcRef.current?.getReceivers?.() || [];
                            const videoTracks = receivers
                                .filter(r => r.track && r.track.kind === "video")
                                .map(r => r.track);
                            if (!stream) stream = new MediaStream();
                            for (const t of videoTracks) {
                                if (!stream.getTracks().some(x => x.id === t.id)) {
                                    try { stream.addTrack(t); } catch { /* ignore */ }
                                }
                            }
                            remoteStreamRef.current = stream;
                        }
                        try {
                            if (remoteVideoRef.current.srcObject !== stream) {
                                remoteVideoRef.current.srcObject = stream;
                            }
                            remoteVideoRef.current.play().catch(() => { });
                        } catch { /* ignore */ }
                    }
                }
            } else if (signal.type === "request-video-state") {
                // P1.10 — Black-video hardening. The peer's watchdog fired: a few
                // seconds after `connected` it still had no live remote video, so
                // it asked us to re-announce our camera state. Reply with the
                // ground truth derived from our LIVE local video track (a live,
                // enabled, non-ended track) rather than a possibly-stale state, so
                // a dropped/late original `video-state` self-heals on the peer.
                const tgt = fromUserId ?? (isIncoming ? callerId : (acceptedBy || reconnectTo));
                if (tgt) {
                    const localStr = localStreamRef.current;
                    const liveLocalVideo =
                        callType === "video" &&
                        !!localStr &&
                        localStr.getVideoTracks().some(t => t.readyState !== "ended" && t.enabled);
                    try {
                        wsSend("call_signal", {
                            callId: callIdRef.current, conversationId, targetUserId: tgt,
                            signal: { type: "video-state", videoOff: !liveLocalVideo }
                        });
                    } catch (err: any) {
                        console.warn("[call-webrtc] reply request-video-state failed:", err?.message || err);
                    }
                }
            } else if (signal.type === "audio-state") {
                setRemoteMuted(!!signal.muted);
            } else if (signal.type === "screen-share-state") {
                setRemoteScreenSharing(!!signal.sharing);
            } else if (signal.type === "quality-state") {
                // Peer reported THEIR measured connection quality so we can
                // surface a "<name>'s connection is unstable" banner — exactly
                // how Teams/Meet attribute a freeze to the right side. Mobile
                // already emits this; the server now whitelists it.
                const q = signal.quality;
                if (q === "good" || q === "fair" || q === "poor" || q === "unknown") {
                    setRemotePeerQuality(q);
                }
            }
        } catch (err) {
            forgetInboundSignal(signal, seenSignalIdsRef.current);
            console.error("[call-webrtc] Signal handling error:", err);
        }
    }, [conversationId, wsSend, flushPendingIceCandidates, addIceCandidateSafe, callType, isIncoming, callerId, acceptedBy, reconnectTo]);

    const handleSignal = useCallback((signal: any, fromUserId: any) => {
        // Detect a "fresh session" offer that requires us to tear down our
        // current PC and start over.
        if (signal.type === "offer" && pcRef.current) {
            const cs = pcRef.current.connectionState;
            const ics = pcRef.current.iceConnectionState;
            const needsRebuild = cs === "failed" || cs === "closed" ||
                ics === "failed" || ics === "closed";
            if (needsRebuild) {
                console.warn("[call-webrtc] received offer while PC is", cs, "/", ics, "— rebuilding (peer is doing relay-only escalation)");
                relayOnlyRef.current = true;
                try { pcRef.current.close(); } catch { /* ignore */ }
                pcRef.current = null;
                // P1.4: DO NOT clear pendingIceCandidatesRef here. Remote ICE
                // candidates buffered before the new remote description still
                // describe the peer's relay-only transport and remain valid for
                // the rebuilt PC. flushPendingIceCandidates() drains them after
                // setRemoteDescription on the new offer/answer. Polite/impolite +
                // makingOffer glare guards stay active across the rebuild.
            }
        }
        if (!pcRef.current && signal.type === "offer" && localStreamRef.current) {
            // Answerer-side fast path: create PC WITHOUT tracks; tracks will be
            // attached after setRemoteDescription inside handleSignalInternal.
            createPeerConnection(localStreamRef.current, fromUserId, false);
            flushPendingSignals();
        }
        if (!pcRef.current) {
            pendingSignalsRef.current.push({ signal, fromUserId });
            return;
        }
        handleSignalInternal(signal, fromUserId);
    }, [handleSignalInternal, createPeerConnection, flushPendingSignals]);

    // ─── End call ───
    const handleEnd = useCallback(() => {
        stopRingtone();
        if (disconnectTimerRef.current) clearTimeout(disconnectTimerRef.current);
        wsSend("call_end", { callId, conversationId });
        cleanup();
        onEnd();
    }, [callId, conversationId, wsSend, onEnd, stopRingtone, cleanup]);

    // Keep handleEndRef always pointing to the latest handleEnd (avoids stale closure in PC handlers)
    handleEndRef.current = handleEnd;

    const handleReject = useCallback(() => {
        stopRingtone();
        preWarmAbortRef.current = true;
        if (preWarmStreamRef.current?.stream) {
            preWarmStreamRef.current.stream.getTracks().forEach((t: MediaStreamTrack) => t.stop());
        }
        preWarmStreamRef.current = null;
        wsSend("call_reject", { callId, conversationId });
        cleanup();
        onEnd();
    }, [callId, conversationId, wsSend, onEnd, stopRingtone, cleanup]);

    // ─── Accept incoming call ───
    const handleAccept = useCallback(async () => {
        onStatusChange("connecting");
        stopRingtone();
        wsSend("call_accept", { callId, conversationId });

        let stream: MediaStream | null = null;
        if (preWarmStreamRef.current) {
            const warmup = preWarmStreamRef.current;
            preWarmStreamRef.current = null;
            if (warmup.stream) {
                stream = warmup.stream;
                localStreamRef.current = stream;
                if (localVideoRef.current && callType === "video" && stream!.getVideoTracks().length) {
                    localVideoRef.current.srcObject = stream;
                }
            } else if (warmup.promise) {
                stream = await warmup.promise;
                if (stream) {
                    localStreamRef.current = stream;
                    if (localVideoRef.current && callType === "video" && stream.getVideoTracks().length) {
                        localVideoRef.current.srcObject = stream;
                    }
                }
            }
        }
        if (!stream) {
            stream = await startMedia();
        }
        if (!stream) { handleEnd(); return; }

        // P0.6 — now that our media is ready, tell the server we're ready so the
        // caller (re)offers immediately. This is the web parity of the mobile
        // `acceptIncoming()` `call_ready` emit and is idempotent via Perfect
        // Negotiation. It rescues the push / cold-start / lock-screen-answer
        // path where the caller's original offer was dropped because we hadn't
        // subscribed yet.
        wsSend("call_ready", { callId: callIdRef.current, conversationId });

        await waitForIceConfig(2000);
        createPeerConnection(stream, callerId, false);
        flushPendingSignals();
    }, [callId, conversationId, wsSend, startMedia, createPeerConnection, callerId, stopRingtone, flushPendingSignals, onStatusChange, handleEnd, callType, waitForIceConfig]);

    // ─── Auto-accept when call was accepted from global PiP notification ───
    const preAcceptedRef = useRef(preAccepted);
    useEffect(() => {
        if (preAcceptedRef.current && isIncoming && !pcRef.current) {
            preAcceptedRef.current = false;
            handleAccept();
        }
    }, []);  // eslint-disable-line react-hooks/exhaustive-deps

    // ─── P0.6: callee subscribes to the per-call signal buffer ───
    // Web parity of the mobile P0.4 `call_subscribe` emit. Once we (the callee)
    // know the callId, tell the server so it can (a) replay any buffered
    // offer/early-ICE the caller sent before we were connected and (b) emit
    // `call_peer_ready` to the caller so they (re)offer. Guarded so we only
    // send once per call. Reconnect callees benefit too.
    const subscribedRef = useRef(false);
    useEffect(() => {
        if (!isIncoming && !isReconnect) return;
        if (subscribedRef.current) return;
        const cid = callIdRef.current;
        if (!cid) return;
        subscribedRef.current = true;
        try {
            wsSend("call_subscribe", { callId: cid, conversationId });
        } catch (err: any) {
            console.warn("[call-webrtc] call_subscribe failed:", err?.message || err);
        }
    }, [callId, isIncoming, isReconnect, conversationId, wsSend]);

    // ─── P0.6: caller re-offers on `call_peer_ready` ───
    // Web parity of the mobile P0.4 inbound `call_peer_ready` handler. The
    // server fires `call_peer_ready` (surfaced here via a bumped
    // `peerReadyNonce` on callState) to tell the OTHER party to (re)send their
    // offer once the callee has subscribed/become ready. Only the CALLER acts,
    // and only when it has a live PC whose localDescription is an offer. Sending
    // the same offer again is idempotent via Perfect Negotiation.
    const peerReadyHandledRef = useRef(0);
    useEffect(() => {
        const nonce = Number(peerReadyNonce) || 0;
        if (!nonce || nonce === peerReadyHandledRef.current) return;
        peerReadyHandledRef.current = nonce;
        if (isIncoming) return; // only the caller re-offers
        const pc = pcRef.current;
        if (!pc || !pc.localDescription || pc.localDescription.type !== "offer") return;
        const target = acceptedBy || reconnectTo;
        if (!target) return;
        console.log("[call-webrtc] call_peer_ready → re-sending offer to:", target);
        try {
            wsSend("call_signal", {
                callId: callIdRef.current, conversationId, targetUserId: target,
                signal: { type: "offer", sdp: pc.localDescription.sdp }
            });
        } catch (err: any) {
            console.warn("[call-webrtc] call_peer_ready re-offer failed:", err?.message || err);
        }
    }, [peerReadyNonce, isIncoming, acceptedBy, reconnectTo, conversationId, wsSend]);

    // ─── Pre-warm media during incoming ringing ───
    useEffect(() => {
        if (!isIncoming || preAccepted || isReconnect) return;
        preWarmAbortRef.current = false;
        const warmup: any = { promise: null, stream: null, error: null };
        warmup.promise = (async () => {
            try {
                const profiles = buildMediaConstraintProfiles(callType === "video", isMobile);
                let stream: MediaStream | null = null;
                for (let i = 0; i < profiles.length; i++) {
                    try {
                        stream = await navigator.mediaDevices.getUserMedia(profiles[i]);
                        break;
                    } catch (err: any) {
                        if (err?.name === "NotAllowedError" || err?.name === "SecurityError") break;
                    }
                }
                if (preWarmAbortRef.current) {
                    stream?.getTracks().forEach(t => t.stop());
                    return null;
                }
                if (stream) {
                    warmup.stream = stream;
                    if (localVideoRef.current && callType === "video" && stream.getVideoTracks().length) {
                        localVideoRef.current.srcObject = stream;
                    }
                }
                return stream;
            } catch (err) {
                warmup.error = err;
                return null;
            }
        })();
        preWarmStreamRef.current = warmup;

        return () => {
            preWarmAbortRef.current = true;
            if (preWarmStreamRef.current?.stream) {
                preWarmStreamRef.current.stream.getTracks().forEach((t: MediaStreamTrack) => t.stop());
            }
            preWarmStreamRef.current = null;
        };
    }, []);  // eslint-disable-line react-hooks/exhaustive-deps

    // ─── Register signal handler ───
    useEffect(() => {
        if (!onSignal) return;
        onSignal.current = handleSignal;
        const pendingSignals = onSignal.pendingSignalsRef?.current?.splice(0) || [];
        for (const { signal, fromUserId } of pendingSignals) {
            handleSignal(signal, fromUserId);
        }
    }, [handleSignal, onSignal]);

    // ─── Outgoing call: use pre-acquired stream ───
    useEffect(() => {
        if (!isIncoming && !isReconnect && localStream && !localStreamRef.current) {
            localStreamRef.current = localStream;
            if (localVideoRef.current && callType === "video") {
                localVideoRef.current.srcObject = localStream;
            }
            if (deferredOfferRef.current) {
                const targetUserId = deferredOfferRef.current;
                deferredOfferRef.current = null;
                (async () => {
                    const pc = createPeerConnection(localStream, targetUserId);
                    flushPendingSignals();
                    const offer = await pc.createOffer();
                    await pc.setLocalDescription(offer);
                    console.log("[call-webrtc] deferred offer sent to:", targetUserId);
                    wsSend("call_signal", {
                        callId: callIdRef.current, conversationId, targetUserId,
                        signal: { type: "offer", sdp: offer.sdp }
                    });
                })();
            }
        }
    }, [localStream]); // eslint-disable-line react-hooks/exhaustive-deps

    // ─── Reconnect: acquire media and wait for peer to re-offer ───
    useEffect(() => {
        if (!isReconnect) return;
        (async () => {
            const stream = await startMedia();
            if (!stream) { handleEnd(); return; }
            onStatusChange("reconnecting");
        })();
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    // ─── Handle reconnectTo: other peer refreshed, we need to re-offer ───
    useEffect(() => {
        if (!reconnectTo) return;
        const targetUserId = reconnectTo;
        (async () => {
            if (pcRef.current) { pcRef.current.close(); pcRef.current = null; }
            const stream = localStreamRef.current;
            if (!stream) return;
            const pc = createPeerConnection(stream, targetUserId);
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            wsSend("call_signal", {
                callId: callIdRef.current, conversationId, targetUserId,
                signal: { type: "offer", sdp: offer.sdp }
            });
        })().catch(console.error);
    }, [reconnectTo]); // eslint-disable-line react-hooks/exhaustive-deps

    // ─── Caller side: create offer once accepted ───
    useEffect(() => {
        if (accepted && !isIncoming) {
            (async () => {
                console.log("[call-webrtc] call accepted, creating offer. acceptedBy:", acceptedBy, "hasStream:", !!localStreamRef.current);
                onStatusChange("connecting");
                stopRingtone();
                await waitForIceConfig(2000);
                const stream = localStreamRef.current;
                if (!stream) {
                    console.log("[call-webrtc] stream not ready yet, deferring offer creation");
                    deferredOfferRef.current = acceptedBy;
                    return;
                }
                const pc = createPeerConnection(stream, acceptedBy);
                flushPendingSignals();
                const offer = await pc.createOffer();
                await pc.setLocalDescription(offer);
                console.log("[call-webrtc] sending offer to:", acceptedBy);
                wsSend("call_signal", {
                    callId: callIdRef.current, conversationId, targetUserId: acceptedBy,
                    signal: { type: "offer", sdp: offer.sdp }
                });
            })();
        }
    }, [accepted, acceptedBy]); // eslint-disable-line react-hooks/exhaustive-deps

    // ─── External end handler ───
    useEffect(() => {
        if (onEndExternal) onEndExternal.current = () => {
            stopRingtone();
            cleanup();
            onEnd();
        };
    }, [onEnd, stopRingtone, cleanup, onEndExternal]);

    // ─── Network change handling ───
    useEffect(() => {
        const triggerIceRestart = (reason: string) => {
            if (!pcRef.current) return;
            if (pcRef.current.connectionState !== "connected" && pcRef.current.connectionState !== "disconnected") return;
            console.log("[call-webrtc] network change detected (", reason, ") — issuing ICE restart");
            iceRestartAttemptedRef.current = false; // allow another restart
            const pc = pcRef.current;
            pc.createOffer({ iceRestart: true })
                .then(o => pc.setLocalDescription(o))
                .then(() => {
                    const target = isIncoming ? callerId : (acceptedBy || reconnectTo);
                    if (!target) return;
                    wsSend("call_signal", {
                        callId: callIdRef.current, conversationId, targetUserId: target,
                        signal: { type: "offer", sdp: pc.localDescription!.sdp }
                    });
                })
                .catch(err => console.warn("[call-webrtc] network-change ICE restart failed:", err));
        };

        const onOnline = () => {
            networkOnlineRef.current = true;
            triggerIceRestart("navigator.online");
        };
        const onOffline = () => { networkOnlineRef.current = false; };
        const onConnChange = () => triggerIceRestart("connection.change");
        const onVisibility = () => {
            if (document.visibilityState === "visible" && pcRef.current?.iceConnectionState === "disconnected") {
                triggerIceRestart("visibility");
            }
        };

        window.addEventListener("online", onOnline);
        window.addEventListener("offline", onOffline);
        document.addEventListener("visibilitychange", onVisibility);
        const conn = (navigator as any).connection || (navigator as any).mozConnection || (navigator as any).webkitConnection;
        conn?.addEventListener?.("change", onConnChange);

        return () => {
            window.removeEventListener("online", onOnline);
            window.removeEventListener("offline", onOffline);
            document.removeEventListener("visibilitychange", onVisibility);
            conn?.removeEventListener?.("change", onConnChange);
        };
    }, [conversationId, wsSend, callerId, acceptedBy, reconnectTo, isIncoming]);

    // ─── Cleanup on unmount ───
    useEffect(() => cleanup, [cleanup]);

    // ─── Sync remote stream to video element when it mounts (audio call screen share) ───
    useEffect(() => {
        if (remoteHasVideo && remoteVideoRef.current && remoteStreamRef.current) {
            if (!remoteVideoRef.current.srcObject) {
                remoteVideoRef.current.srcObject = remoteStreamRef.current;
            }
            remoteVideoRef.current.play().catch(() => { });
        }
    }, [remoteHasVideo]);

    // ─── Connection timeout ───
    useEffect(() => {
        return () => { if (connectionTimeoutRef.current) clearTimeout(connectionTimeoutRef.current); };
    }, []);

    // ─── Send our local camera on/off state to the peer ───
    const sendLocalVideoState = useCallback((isVideoOff: boolean) => {
        setLocalVideoOff(isVideoOff);
        const target = isIncoming ? callerId : (acceptedBy || reconnectTo);
        if (!target) return;
        try {
            wsSend("call_signal", {
                callId: callIdRef.current, conversationId, targetUserId: target,
                signal: { type: "video-state", videoOff: !!isVideoOff }
            });
        } catch (err: any) {
            console.warn("[call-webrtc] sendLocalVideoState failed:", err?.message || err);
        }
    }, [conversationId, wsSend, isIncoming, callerId, acceptedBy, reconnectTo]);

    const sendLocalMuteState = useCallback((isMuted: boolean) => {
        const target = isIncoming ? callerId : (acceptedBy || reconnectTo);
        if (!target) return;
        try {
            wsSend("call_signal", {
                callId: callIdRef.current, conversationId, targetUserId: target,
                signal: { type: "audio-state", muted: !!isMuted }
            });
        } catch (err: any) {
            console.warn("[call-webrtc] sendLocalMuteState failed:", err?.message || err);
        }
    }, [conversationId, wsSend, isIncoming, callerId, acceptedBy, reconnectTo]);

    const sendLocalScreenShareState = useCallback((isSharing: boolean) => {
        const target = isIncoming ? callerId : (acceptedBy || reconnectTo);
        if (!target) return;
        try {
            wsSend("call_signal", {
                callId: callIdRef.current, conversationId, targetUserId: target,
                signal: { type: "screen-share-state", sharing: !!isSharing }
            });
        } catch (err: any) {
            console.warn("[call-webrtc] sendLocalScreenShareState failed:", err?.message || err);
        }
    }, [conversationId, wsSend, isIncoming, callerId, acceptedBy, reconnectTo]);

    // ─── Emit OUR measured connection quality to the peer ───
    // The peer renders a "<name>'s connection is unstable" banner from this
    // (Teams/Meet parity). Only emit on a real change (not every sample) so we
    // don't spam the relay. Mirrors the mobile client's quality-state emitter.
    const sendQualityState = useCallback((quality: "good" | "fair" | "poor" | "unknown") => {
        if (lastSentQualityRef.current === quality) return;
        lastSentQualityRef.current = quality;
        const target = isIncoming ? callerId : (acceptedBy || reconnectTo);
        if (!target) return;
        try {
            wsSend("call_signal", {
                callId: callIdRef.current, conversationId, targetUserId: target,
                signal: { type: "quality-state", quality }
            });
        } catch (err: any) {
            console.warn("[call-webrtc] sendQualityState failed:", err?.message || err);
        }
    }, [conversationId, wsSend, isIncoming, callerId, acceptedBy, reconnectTo]);

    return {
        pcRef, localStreamRef, screenStreamRef, remoteStreamRef,
        localVideoRef, remoteVideoRef, remoteAudioRef,
        screenSenderRef, connectionTimeoutRef, ringtoneRef,
        handleAccept, handleReject, handleEnd,
        stopRingtone, startMedia, createPeerConnection,
        isMobile, remoteVideoOff, remoteHasVideo, remoteMuted, remoteScreenSharing,
        sendLocalVideoState, sendLocalMuteState, sendLocalScreenShareState,
        sendQualityState, remotePeerQuality,
        localVideoOff
    };
}

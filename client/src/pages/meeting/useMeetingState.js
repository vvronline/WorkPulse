import { useEffect, useRef, useState, useCallback } from 'react';
import { useAuth } from '../../AuthContext';
import { getIceConfig } from '../../api';
import {
    BackgroundProcessor, isBackgroundEffectsSupported, loadStoredEffect, storeEffect,
} from '../../utils/backgroundEffects';

// Default ICE servers used until the /chat/ice-config request resolves.
// Includes the public Open Relay TURN service so meetings still work for peers
// behind restrictive NATs / corporate proxies even before the server config arrives.
const DEFAULT_ICE_SERVERS = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
];

const ICE_CONFIG = {
    iceServers: DEFAULT_ICE_SERVERS,
    bundlePolicy: 'max-bundle',
    rtcpMuxPolicy: 'require',
    iceCandidatePoolSize: 4,
};

/**
 * Progressive constraint profiles — see useWebRTC.js for the same pattern.
 * Order: HD desktop → SD mobile → Low → bare → audio-only fallback.
 */
function buildMeetingMediaProfiles(wantVideo) {
    const audio = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
    if (!wantVideo) return [{ audio, video: false }];
    return [
        { audio, video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 } } },
        { audio, video: { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 24, max: 30 } } },
        { audio, video: { width: { ideal: 320 }, height: { ideal: 240 }, frameRate: { ideal: 15, max: 24 } } },
        { audio, video: true },
        { audio, video: false }, // audio-only fallback
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
        } catch (err) {
            lastError = err;
            if (err?.name === 'NotAllowedError' || err?.name === 'SecurityError') break;
        }
    }
    throw lastError;
}

/**
 * useMeetingState — WebRTC mesh hook for multi-participant meetings.
 *
 * Fixed WS format: server expects { type, data: { ... } } and sends { type, data: { ... } }.
 *
 * keepAliveOnUnmount: when true, don't send meeting_leave or stop streams on unmount (PiP mode).
 * existingStream: re-use a previous MediaStream when returning from PiP.
 */
export function useMeetingState({ meetingId, ws, initialMuted = false, initialVideoOff = false, keepAliveOnUnmount = false, existingStream = null }) {
    const { user } = useAuth();

    // Local media
    const [localStream, setLocalStream] = useState(null);
    const [screenStream, setScreenStream] = useState(null);
    const [muted, setMuted] = useState(initialMuted);
    const [videoOff, setVideoOff] = useState(initialVideoOff);
    const [screenSharing, setScreenSharing] = useState(false);

    // Participants: Map userId -> { userId, name, stream, muted, videoOff, raisedHand, role, screenSharing }
    const [participants, setParticipants] = useState(new Map());

    // Presenter: userId of whoever is screen-sharing (null = nobody)
    const [presenterId, setPresenterId] = useState(null);

    // UI
    const [activePanel, setActivePanel] = useState(null); // 'chat' | 'participants' | null
    const [messages, setMessages] = useState([]);
    const [status, setStatus] = useState('joining'); // joining | connecting | connected | ended | left
    const [raisedHand, setRaisedHand] = useState(false);
    const [connectionQualities, setConnectionQualities] = useState(new Map());
    const [mediaReady, setMediaReady] = useState(!!existingStream);

    // Refs
    const localStreamRef = useRef(null);
    const screenStreamRef = useRef(null);
    const pcsRef = useRef(new Map()); // userId -> RTCPeerConnection
    // Background effects (blur / virtual background) — see utils/backgroundEffects.js
    const processorRef = useRef(null);
    const rawCameraTrackRef = useRef(null); // unprocessed camera track when an effect is active
    const [bgEffect, setBgEffectState] = useState(() => loadStoredEffect());
    const [bgEffectError, setBgEffectError] = useState(null);
    const bgEffectRef = useRef(bgEffect);
    bgEffectRef.current = bgEffect;
    const pendingSignals = useRef(new Map()); // userId -> []
    const qualityTimerRef = useRef(null);
    const wsRef = useRef(ws);
    wsRef.current = ws;
    // Dynamic ICE config — populated from /api/chat/ice-config (coturn ephemeral creds)
    const iceServersRef = useRef(DEFAULT_ICE_SERVERS);
    const iceExpiresAtRef = useRef(0);
    const relayOnlyPeersRef = useRef(new Set()); // peer IDs we should rebuild as relay-only
    const iceRestartCountsRef = useRef(new Map()); // peer -> # ICE restarts attempted

    // Keep refs in sync with state to avoid stale closures in toggleMute/toggleVideo/toggleScreenShare
    const mutedRef = useRef(muted);
    mutedRef.current = muted;
    const videoOffRef = useRef(videoOff);
    videoOffRef.current = videoOff;
    const screenSharingRef = useRef(screenSharing);
    screenSharingRef.current = screenSharing;

    // ── Background effects helpers ──────────────────────────────────────────
    // Tear down the active processor and free the raw camera track. Safe to
    // call when nothing is active.
    const teardownProcessor = useCallback(() => {
        if (processorRef.current) {
            try { processorRef.current.stop(); } catch { /* ignore */ }
            processorRef.current = null;
        }
        if (rawCameraTrackRef.current) {
            try { rawCameraTrackRef.current.stop(); } catch { /* ignore */ }
            rawCameraTrackRef.current = null;
        }
    }, []);

    // Replace the active video track on every peer connection sender. Used by
    // setBackgroundEffect, switchVideoDevice, and toggleVideo's re-enable path
    // so we never have to renegotiate just because we swapped which track the
    // sender carries.
    const replaceVideoTrackOnPeers = useCallback(async (newTrack) => {
        const tasks = [];
        for (const [, pc] of pcsRef.current) {
            const sender = pc.getSenders().find(s => s.track?.kind === 'video');
            if (sender) {
                tasks.push(sender.replaceTrack(newTrack || null).catch(() => { }));
            }
        }
        await Promise.all(tasks);
    }, []);

    // Run a raw camera track through the background processor and return the
    // resulting MediaStreamTrack. Returns the raw track when the effect is
    // 'none' or when MediaPipe fails to initialise.
    //
    // Behaviour:
    //   • First call (no processor yet) → builds processor, returns processed track.
    //   • Subsequent call with same rawTrack → reuses existing processor via
    //     `setEffect()` and returns the SAME processed track (cheap, no WebGL
    //     context churn, and — critically — fixes the "blur/background doesn't
    //     change in an ongoing meeting" bug that the old "tear down + rebuild"
    //     path caused by accidentally stopping the live raw camera track).
    //   • Call with a different rawTrack → tears down old processor (without
    //     stopping the new rawTrack) and builds a fresh one.
    const buildProcessedTrack = useCallback(async (rawTrack, effect) => {
        if (!effect || effect.type === 'none') {
            teardownProcessor();
            rawCameraTrackRef.current = null;
            return rawTrack;
        }
        if (!isBackgroundEffectsSupported()) {
            return rawTrack;
        }

        // ── Fast path: processor already exists for this raw track ──────────
        // Just hot-swap the effect. This is the path taken when the user
        // changes from blur → image, image → image, or moves the blur
        // strength slider mid-meeting. No new WebGL context, no captureStream
        // rebuild, no chance of the new processor getting fed a stopped track.
        if (
            processorRef.current
            && rawCameraTrackRef.current === rawTrack
            && rawTrack.readyState === 'live'
        ) {
            try {
                processorRef.current.setEffect(effect);
                setBgEffectError(null);
                const existingOut = processorRef.current._outStream;
                const existingTrack = existingOut?.getVideoTracks?.()[0];
                if (existingTrack && existingTrack.readyState === 'live') {
                    return existingTrack;
                }
                // captureStream track unexpectedly ended — fall through and
                // rebuild from scratch.
            } catch (err) {
                console.warn('[meeting] setEffect on existing processor failed, rebuilding:', err);
            }
        }

        // ── Slow path: build a fresh processor ──────────────────────────────
        // IMPORTANT: Do NOT call `teardownProcessor()` here unconditionally:
        // it also stops `rawCameraTrackRef.current`, and that's usually the
        // very same track we're about to feed into the new processor. Stopping
        // it would leave the new processor with a dead <video> source —
        // exactly the "background effect doesn't change mid-meeting" bug.
        // Stop the previous processor, and only stop the previous raw track
        // if it's actually a different track than the one we're now using.
        if (processorRef.current) {
            try { processorRef.current.stop(); } catch { /* ignore */ }
            processorRef.current = null;
        }
        if (rawCameraTrackRef.current && rawCameraTrackRef.current !== rawTrack) {
            try { rawCameraTrackRef.current.stop(); } catch { /* ignore */ }
        }
        rawCameraTrackRef.current = null;

        try {
            const proc = new BackgroundProcessor({ inputTrack: rawTrack, effect });
            const stream = await proc.start();
            processorRef.current = proc;
            rawCameraTrackRef.current = rawTrack;
            setBgEffectError(null);
            return stream.getVideoTracks()[0];
        } catch (err) {
            const msg = err?.message || String(err);
            console.warn('[meeting] background processor failed, falling back to raw track:', msg);
            if (/wasm|CompileError|unsafe-eval|CSP|Content Security/i.test(msg)) {
                setBgEffectError("Couldn't load background effects engine. Your browser blocked WebAssembly — make sure you're on HTTPS and the latest Chrome/Edge/Firefox.");
            } else if (/load failed|network|fetch/i.test(msg)) {
                setBgEffectError("Couldn't download the background effects model. Check your network and try again.");
            } else {
                setBgEffectError(`Background effect failed: ${msg}`);
            }
            teardownProcessor();
            return rawTrack;
        }
    }, [teardownProcessor]);

    // Helper: send WS message in { type, data } format
    const wsSend = useCallback((type, data) => {
        if (wsRef.current && wsRef.current.readyState === 1) {
            wsRef.current.send(JSON.stringify({ type, data }));
        }
    }, []);

    // Acquire local media on mount (skip if existingStream is provided).
    // Uses the progressive-constraints helper so weaker mobile devices /
    // congested networks still produce a usable stream instead of failing.
    useEffect(() => {
        if (existingStream) {
            localStreamRef.current = existingStream;
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
                console.error('[meeting] all media profiles failed:', err);
                setMuted(true);
                setVideoOff(true);
                setMediaReady(true);
                if (err?.name === 'NotAllowedError') {
                    alert('Camera/microphone access is blocked.\n\n1. Click the lock/tune icon in the address bar → allow camera & microphone\n2. If the setting is locked, your organization may be blocking it — contact your IT admin to whitelist this site');
                } else if (err?.name === 'NotReadableError' || err?.name === 'TrackStartError') {
                    alert('Your camera/microphone is in use by another application. Please close that app and rejoin the meeting.');
                } else if (err?.name === 'NotFoundError') {
                    alert('No camera/microphone was found. You will join muted with video off.');
                }
            }
        })();
        return () => {
            cancelled = true;
            // Only stop tracks if not keeping alive for PiP
            if (!keepAliveOnUnmount && stream) stream.getTracks().forEach(t => t.stop());
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Fetch ICE config (coturn ephemeral creds) and refresh before expiry.
    // Done in parallel with media acquisition so we don't add startup latency.
    useEffect(() => {
        const refresh = async () => {
            try {
                const { data } = await getIceConfig();
                if (data?.iceServers?.length) {
                    iceServersRef.current = data.iceServers;
                    iceExpiresAtRef.current = data.expiresAt || 0;
                    console.log('[meeting] ICE config loaded (mode:', data.mode || 'unknown', ')');
                }
            } catch (err) {
                console.warn('[meeting] ICE config fetch failed, using defaults:', err?.message || err);
            }
        };
        refresh();
        const t = setInterval(() => {
            const expiresAt = iceExpiresAtRef.current;
            if (expiresAt && expiresAt - Math.floor(Date.now() / 1000) < 300) refresh();
        }, 60_000);
        return () => clearInterval(t);
    }, []);

    // Device change detection — re-enumerate when devices are added/removed
    useEffect(() => {
        const handleChange = () => {
            navigator.mediaDevices.enumerateDevices().catch(() => { });
        };
        navigator.mediaDevices?.addEventListener('devicechange', handleChange);
        return () => navigator.mediaDevices?.removeEventListener('devicechange', handleChange);
    }, []);

    // Safety net: when localStream becomes available, add tracks to any peer connections that lack senders
    useEffect(() => {
        if (!localStreamRef.current) return;
        const stream = localStreamRef.current;
        for (const [peerId, pc] of pcsRef.current) {
            const senders = pc.getSenders().filter(s => s.track);
            if (senders.length === 0 && stream.getTracks().length > 0) {
                stream.getTracks().forEach(track => pc.addTrack(track, stream));
                // Renegotiate so remote peer receives the new tracks
                if (pc.signalingState === 'stable') {
                    pc.createOffer()
                        .then(offer => pc.setLocalDescription(offer))
                        .then(() => {
                            wsSend('meeting_signal', {
                                meetingId,
                                targetUserId: peerId,
                                signal: { type: 'offer', sdp: pc.localDescription },
                            });
                        })
                        .catch(console.error);
                }
            }
        }
    }, [localStream, meetingId, wsSend]);

    // Quality monitoring
    useEffect(() => {
        qualityTimerRef.current = setInterval(async () => {
            const qMap = new Map();
            for (const [userId, pc] of pcsRef.current) {
                try {
                    const stats = await pc.getStats();
                    let totalPacketLoss = 0, roundTripTime = 0, count = 0;
                    stats.forEach(s => {
                        if (s.type === 'inbound-rtp') {
                            const total = (s.packetsReceived || 0) + (s.packetsLost || 0);
                            const loss = total > 0 ? s.packetsLost / total : 0;
                            totalPacketLoss += loss;
                            count++;
                        }
                        if (s.type === 'candidate-pair' && s.state === 'succeeded') {
                            roundTripTime = (s.currentRoundTripTime || 0) * 1000;
                        }
                    });
                    const avgLoss = count > 0 ? totalPacketLoss / count : 0;
                    const quality = roundTripTime < 100 && avgLoss < 0.02 ? 'good'
                        : roundTripTime < 250 && avgLoss < 0.08 ? 'medium' : 'poor';
                    qMap.set(userId, quality);
                } catch { /* ignore */ }
            }
            setConnectionQualities(new Map(qMap));
        }, 5000);
        // Always clean up the interval (including in PiP mode)
        return () => clearInterval(qualityTimerRef.current);
    }, []);

    // Create a peer connection to a remote user.
    // Uses the freshly-fetched coturn ICE config and applies iceTransportPolicy=relay
    // for peers we previously failed to reach over UDP/STUN (corporate proxy escape).
    const createPeerConnection = useCallback((remoteUserId, isInitiator) => {
        const existing = pcsRef.current.get(remoteUserId);
        if (existing && existing.connectionState !== 'closed' && existing.connectionState !== 'failed') {
            return existing;
        }
        if (existing) { try { existing.close(); } catch { } }

        const pcConfig = {
            iceServers: iceServersRef.current,
            bundlePolicy: 'max-bundle',
            rtcpMuxPolicy: 'require',
            iceCandidatePoolSize: 4,
        };
        if (relayOnlyPeersRef.current.has(remoteUserId)) {
            pcConfig.iceTransportPolicy = 'relay';
            console.log('[meeting] peer', remoteUserId, '→ relay-only mode (corporate proxy fallback)');
        }

        let pc;
        try {
            pc = new RTCPeerConnection(pcConfig);
        } catch (err) {
            console.error('Failed to create RTCPeerConnection:', err);
            return null;
        }
        pcsRef.current.set(remoteUserId, pc);

        // Add local tracks
        if (localStreamRef.current) {
            localStreamRef.current.getTracks().forEach(track => pc.addTrack(track, localStreamRef.current));
        }

        // Apply encoding parameters to reduce lag (cap bitrate, prefer smooth framerate)
        setTimeout(() => {
            for (const sender of pc.getSenders()) {
                if (!sender.track) continue;
                try {
                    const params = sender.getParameters();
                    if (!params.encodings || params.encodings.length === 0) {
                        params.encodings = [{}];
                    }
                    if (sender.track.kind === 'video') {
                        params.encodings[0].maxBitrate = 1_200_000; // 1.2 Mbps
                        params.degradationPreference = 'maintain-framerate';
                    } else if (sender.track.kind === 'audio') {
                        params.encodings[0].maxBitrate = 64_000; // 64 kbps
                    }
                    sender.setParameters(params).catch(() => { });
                } catch { /* ignore unsupported browsers */ }
            }
        }, 0);

        // Handle remote tracks
        const remoteStream = new MediaStream();
        pc.ontrack = (e) => {
            remoteStream.addTrack(e.track);
            // Create new MediaStream ref so React components detect the change and re-render
            setParticipants(prev => {
                const next = new Map(prev);
                const existing = next.get(remoteUserId) || { userId: remoteUserId };
                next.set(remoteUserId, { ...existing, stream: new MediaStream(remoteStream.getTracks()) });
                return next;
            });
        };

        // ICE candidates
        pc.onicecandidate = (e) => {
            if (e.candidate) {
                wsSend('meeting_signal', {
                    meetingId,
                    targetUserId: remoteUserId,
                    signal: { type: 'candidate', candidate: e.candidate },
                });
            }
        };

        pc.oniceconnectionstatechange = () => {
            // Fast ICE restart on transient mobile / VPN drops
            if (pc.iceConnectionState === 'disconnected') {
                setTimeout(() => {
                    if (pc.iceConnectionState === 'disconnected' && pc.signalingState === 'stable') {
                        const cnt = (iceRestartCountsRef.current.get(remoteUserId) || 0);
                        if (cnt < 3) {
                            iceRestartCountsRef.current.set(remoteUserId, cnt + 1);
                            console.log('[meeting] ICE restart for peer', remoteUserId, '(attempt', cnt + 1, ')');
                            pc.createOffer({ iceRestart: true })
                                .then(o => pc.setLocalDescription(o))
                                .then(() => wsSend('meeting_signal', {
                                    meetingId, targetUserId: remoteUserId,
                                    signal: { type: 'offer', sdp: pc.localDescription },
                                }))
                                .catch(err => console.warn('[meeting] ICE restart failed:', err));
                        }
                    }
                }, 2000);
            }
        };

        pc.onconnectionstatechange = () => {
            if (pc.connectionState === 'connected') {
                setStatus('connected');
                iceRestartCountsRef.current.delete(remoteUserId);
                // Clear any pending disconnect timer
                if (pc._disconnectTimer) {
                    clearTimeout(pc._disconnectTimer);
                    pc._disconnectTimer = null;
                }
                setParticipants(prev => {
                    const next = new Map(prev);
                    const p = next.get(remoteUserId);
                    if (p && !p.stream) next.set(remoteUserId, { ...p });
                    return next;
                });
            } else if (pc.connectionState === 'failed') {
                setParticipants(prev => {
                    const next = new Map(prev);
                    const p = next.get(remoteUserId);
                    if (p) next.set(remoteUserId, { ...p, stream: null });
                    return next;
                });
                // Escalate to relay-only and rebuild — the corporate-proxy lifeline.
                if (!relayOnlyPeersRef.current.has(remoteUserId)) {
                    console.warn('[meeting] peer', remoteUserId, 'failed — rebuilding in relay-only mode');
                    relayOnlyPeersRef.current.add(remoteUserId);
                    try { pc.close(); } catch { }
                    pcsRef.current.delete(remoteUserId);
                    iceRestartCountsRef.current.delete(remoteUserId);
                    setTimeout(() => createPeerConnection(remoteUserId, true), 500);
                }
            } else if (pc.connectionState === 'disconnected') {
                // Don't null out the stream immediately — 'disconnected' is
                // a transient state that often recovers on its own (network
                // blip, mobile sleep, WiFi roam). Only clear after a timeout
                // if the connection doesn't recover.
                const disconnectTimer = setTimeout(() => {
                    if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
                        setParticipants(prev => {
                            const next = new Map(prev);
                            const p = next.get(remoteUserId);
                            if (p) next.set(remoteUserId, { ...p, stream: null });
                            return next;
                        });
                    }
                }, 5000);
                // Store the timer so we can clear it if connection recovers
                pc._disconnectTimer = disconnectTimer;
            }
        };

        // If initiator, create offer
        if (isInitiator) {
            pc.createOffer()
                .then(offer => pc.setLocalDescription(offer))
                .then(() => {
                    wsSend('meeting_signal', {
                        meetingId,
                        targetUserId: remoteUserId,
                        signal: { type: 'offer', sdp: pc.localDescription },
                    });
                })
                .catch(console.error);
        }

        return pc;
    }, [meetingId, wsSend]);

    // Network change handling — mobile WiFi↔cellular, VPN connect/disconnect.
    // Issue ICE restart on every connected peer so the meeting survives.
    useEffect(() => {
        const restartAll = (reason) => {
            console.log('[meeting] network change (', reason, ') — issuing ICE restart on', pcsRef.current.size, 'peers');
            for (const [peerId, pc] of pcsRef.current) {
                if (pc.signalingState !== 'stable') continue;
                pc.createOffer({ iceRestart: true })
                    .then(o => pc.setLocalDescription(o))
                    .then(() => wsSend('meeting_signal', {
                        meetingId, targetUserId: peerId,
                        signal: { type: 'offer', sdp: pc.localDescription },
                    }))
                    .catch(err => console.warn('[meeting] network-change ICE restart failed for', peerId, err));
            }
        };
        const onOnline = () => restartAll('online');
        const onConn = () => restartAll('connection.change');
        window.addEventListener('online', onOnline);
        const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
        conn?.addEventListener?.('change', onConn);
        return () => {
            window.removeEventListener('online', onOnline);
            conn?.removeEventListener?.('change', onConn);
        };
    }, [meetingId, wsSend]);

    // Flush any buffered signals for a peer
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
            wsSend('meeting_signal', {
                meetingId,
                targetUserId: fromUserId,
                signal: { type: 'answer', sdp: pc.localDescription },
            });
            await flushPendingSignals(fromUserId, pc);
        } else if (signal.type === 'answer') {
            if (pc.signalingState === 'have-local-offer') {
                await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
                await flushPendingSignals(fromUserId, pc);
            }
        } else if (signal.type === 'candidate') {
            if (pc.remoteDescription) {
                await pc.addIceCandidate(new RTCIceCandidate(signal.candidate));
            } else {
                const q = pendingSignals.current.get(fromUserId) || [];
                q.push(signal);
                pendingSignals.current.set(fromUserId, q);
            }
        }
    }, [meetingId, wsSend, flushPendingSignals]);

    // WebSocket message handler — handles { type, data } envelope from server
    const handleWsMessage = useCallback((msg) => {
        const { type, data } = msg;
        if (!data) return;

        switch (type) {
            case 'meeting_participant_joined': {
                // Server sends: { userId, fullName, avatar, username, existingPeers? }
                // existingPeers is an array of { userId, fullName, avatar, username } objects
                console.log('[meeting] participant_joined:', data.userId, 'existingPeers:', data.existingPeers?.length, 'hasLocalStream:', !!localStreamRef.current);
                if (data.existingPeers && Array.isArray(data.existingPeers)) {
                    // We are the new joiner — existingPeers is sent only to us
                    data.existingPeers.forEach(peer => {
                        if (!peer || !peer.userId) return;
                        const peerId = peer.userId;
                        const pc = createPeerConnection(peerId, false);
                        if (!pc) return;
                        pcsRef.current.set(peerId, pc);
                        // Add existing participants with their names
                        if (peerId !== user?.id) {
                            setParticipants(prev => {
                                const next = new Map(prev);
                                const existing = next.get(peerId) || {};
                                next.set(peerId, {
                                    userId: peerId,
                                    stream: null, muted: false, videoOff: false,
                                    raisedHand: false, role: 'participant',
                                    screenSharing: false,
                                    ...existing,
                                    name: peer.fullName || peer.username || existing.name || 'Participant',
                                });
                                return next;
                            });
                        }
                    });
                    setStatus(data.existingPeers.length > 0 ? 'connecting' : 'connected');
                }
                // Add participant to our list (could be us or a new peer)
                if (data.userId !== user?.id) {
                    setParticipants(prev => {
                        const next = new Map(prev);
                        const existing = next.get(data.userId) || {};
                        next.set(data.userId, {
                            userId: data.userId,
                            stream: null, muted: false, videoOff: false,
                            raisedHand: false, role: data.role || 'participant',
                            screenSharing: false,
                            ...existing,
                            name: data.fullName || data.username || existing.name || 'Participant',
                        });
                        return next;
                    });
                    // If we're an existing participant, initiate connection to the new joiner
                    if (!data.existingPeers) {
                        const pc = createPeerConnection(data.userId, true);
                        if (pc) pcsRef.current.set(data.userId, pc);
                        // Re-broadcast our track state so the new joiner knows our mute/camera status
                        wsSend('meeting_track_state', { meetingId, muted: mutedRef.current, videoOff: videoOffRef.current, screenSharing: screenSharingRef.current });
                    }
                }
                setStatus('connected');
                break;
            }
            case 'meeting_signal': {
                const { fromUserId, signal } = data;
                console.log('[meeting] received signal:', signal.type, 'from:', fromUserId);
                let pc = pcsRef.current.get(fromUserId);
                if (!pc) {
                    pc = createPeerConnection(fromUserId, false);
                    if (!pc) break;
                    pcsRef.current.set(fromUserId, pc);
                }
                handleSignal(fromUserId, pc, signal).catch(console.error);
                break;
            }
            case 'meeting_participant_left': {
                const { userId } = data;
                pcsRef.current.get(userId)?.close();
                pcsRef.current.delete(userId);
                setParticipants(prev => { const next = new Map(prev); next.delete(userId); return next; });
                if (presenterId === userId) setPresenterId(null);
                break;
            }
            case 'meeting_ended': {
                // Stop all media tracks and close peer connections
                teardownProcessor();
                if (screenStreamRef.current) {
                    screenStreamRef.current.getTracks().forEach(t => t.stop());
                    screenStreamRef.current = null;
                }
                if (localStreamRef.current) {
                    localStreamRef.current.getTracks().forEach(t => t.stop());
                    localStreamRef.current = null;
                }
                pcsRef.current.forEach(pc => { try { pc.close(); } catch { } });
                pcsRef.current.clear();
                if (qualityTimerRef.current) {
                    clearInterval(qualityTimerRef.current);
                    qualityTimerRef.current = null;
                }
                setStatus('ended');
                break;
            }
            case 'meeting_muted': {
                setMuted(true);
                if (localStreamRef.current) {
                    localStreamRef.current.getAudioTracks().forEach(t => { t.enabled = false; });
                }
                break;
            }
            case 'meeting_hand_raised': {
                const { userId, raised } = data;
                setParticipants(prev => {
                    const next = new Map(prev);
                    const p = next.get(userId);
                    if (p) next.set(userId, { ...p, raisedHand: raised });
                    return next;
                });
                break;
            }
            case 'meeting_track_state': {
                // Remote participant's track state changed
                const { userId, muted: isMuted, videoOff: isVideoOff, screenSharing: isScreenSharing } = data;
                setParticipants(prev => {
                    const next = new Map(prev);
                    const p = next.get(userId);
                    if (p) next.set(userId, { ...p, muted: isMuted, videoOff: isVideoOff, screenSharing: isScreenSharing });
                    return next;
                });
                if (isScreenSharing) setPresenterId(userId);
                else if (presenterId === userId) setPresenterId(null);
                break;
            }
            case 'meeting_message': {
                const incoming = data.message;
                if (!incoming) break;
                setMessages(prev => {
                    // If this echoes our own optimistic message, replace it
                    // instead of appending a duplicate.
                    if (incoming.sender_id === user?.id) {
                        const idx = prev.findIndex(m => m._optimistic
                            && m.sender_id === incoming.sender_id
                            && m.text === incoming.text);
                        if (idx >= 0) {
                            const next = prev.slice();
                            next[idx] = incoming;
                            return next;
                        }
                    }
                    return [...prev, incoming];
                });
                break;
            }
            case 'meeting_invite': {
                // Another user invited us to an ongoing meeting — ignore in room context
                break;
            }
            default: break;
        }
    }, [user, createPeerConnection, handleSignal, presenterId]);

    // Register WS message handler inside the hook (before join effect) to ensure
    // signals are captured from the moment we join
    useEffect(() => {
        if (!ws) return;
        const onMessage = (e) => {
            try {
                handleWsMessage(JSON.parse(e.data));
            } catch (err) {
                console.error('Meeting WS message error:', err);
            }
        };
        ws.addEventListener('message', onMessage);
        return () => ws.removeEventListener('message', onMessage);
    }, [ws, handleWsMessage]);

    // Send WS join on mount — wait for socket to be open AND media to be ready before sending
    useEffect(() => {
        if (!ws || !meetingId || !mediaReady) return;

        const sendJoin = () => {
            wsSend('meeting_join', { meetingId });
            // Broadcast our initial track state so existing participants know our mute/camera status
            setTimeout(() => {
                wsSend('meeting_track_state', { meetingId, muted: mutedRef.current, videoOff: videoOffRef.current, screenSharing: screenSharingRef.current });
            }, 500);
        };

        if (ws.readyState === WebSocket.OPEN) {
            sendJoin();
        } else if (ws.readyState === WebSocket.CONNECTING) {
            ws.addEventListener('open', sendJoin);
        }

        return () => {
            ws.removeEventListener('open', sendJoin);
            // If keepAliveOnUnmount (PiP mode), don't leave — the meeting stays active
            if (!keepAliveOnUnmount) {
                wsSend('meeting_leave', { meetingId });
                pcsRef.current.forEach(pc => pc.close());
                pcsRef.current.clear();
            }
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [ws, meetingId, mediaReady]);

    // Actions
    const toggleMute = useCallback(() => {
        setMuted(v => {
            const next = !v;
            if (localStreamRef.current) {
                localStreamRef.current.getAudioTracks().forEach(t => { t.enabled = !next; });
            }
            wsSend('meeting_track_state', { meetingId, muted: next, videoOff: videoOffRef.current, screenSharing: screenSharingRef.current });
            return next;
        });
    }, [meetingId, wsSend]);

    const toggleVideo = useCallback(async () => {
        const next = !videoOff;
        if (next) {
            // Turning video OFF — disable existing tracks
            if (localStreamRef.current) {
                localStreamRef.current.getVideoTracks().forEach(t => { t.enabled = false; });
            }
        } else {
            // Turning video ON
            if (localStreamRef.current) {
                const existingTracks = localStreamRef.current.getVideoTracks();
                const liveTracks = existingTracks.filter(t => t.readyState === 'live');
                if (liveTracks.length > 0) {
                    // Re-enable existing live track
                    liveTracks.forEach(t => { t.enabled = true; });
                    setLocalStream(new MediaStream(localStreamRef.current.getTracks()));
                } else {
                    // No live video track — remove any ended tracks and acquire new one
                    existingTracks.filter(t => t.readyState === 'ended').forEach(t => {
                        localStreamRef.current.removeTrack(t);
                    });
                    try {
                        const newStream = await navigator.mediaDevices.getUserMedia({ video: true });
                        const newTrack = newStream.getVideoTracks()[0];
                        if (newTrack) {
                            localStreamRef.current.addTrack(newTrack);
                            // Replace track on existing video senders, or add if no sender exists
                            for (const [peerId, pc] of pcsRef.current) {
                                const senders = pc.getSenders();
                                const videoSender = senders.find(s => s.track?.kind === 'video') ||
                                    senders.find(s => s.track === null && s !== senders.find(as => as.track?.kind === 'audio'));
                                if (videoSender) {
                                    try {
                                        await videoSender.replaceTrack(newTrack);
                                    } catch {
                                        // replaceTrack failed, try addTrack + renegotiate
                                        pc.addTrack(newTrack, localStreamRef.current);
                                        if (pc.signalingState === 'stable') {
                                            const offer = await pc.createOffer();
                                            await pc.setLocalDescription(offer);
                                            wsSend('meeting_signal', {
                                                meetingId,
                                                targetUserId: peerId,
                                                signal: { type: 'offer', sdp: pc.localDescription },
                                            });
                                        }
                                    }
                                } else {
                                    pc.addTrack(newTrack, localStreamRef.current);
                                    // Only renegotiate when adding a brand new sender
                                    if (pc.signalingState === 'stable') {
                                        try {
                                            const offer = await pc.createOffer();
                                            await pc.setLocalDescription(offer);
                                            wsSend('meeting_signal', {
                                                meetingId,
                                                targetUserId: peerId,
                                                signal: { type: 'offer', sdp: pc.localDescription },
                                            });
                                        } catch (err) { console.error('Renegotiation failed:', err); }
                                    }
                                }
                            }
                            setLocalStream(new MediaStream(localStreamRef.current.getTracks()));
                        }
                    } catch (err) {
                        console.error('Failed to start video:', err);
                        return; // Don't change state if camera unavailable
                    }
                }
            }
        }
        setVideoOff(next);
        wsSend('meeting_track_state', { meetingId, muted: mutedRef.current, videoOff: next, screenSharing: screenSharingRef.current });
    }, [meetingId, videoOff, wsSend]);

    const toggleScreenShare = useCallback(async () => {
        if (screenSharing) {
            if (screenStreamRef.current) {
                screenStreamRef.current.getTracks().forEach(t => t.stop());
                screenStreamRef.current = null;
            }
            setScreenSharing(false);
            setScreenStream(null);
            setPresenterId(null);
            wsSend('meeting_track_state', { meetingId, muted: mutedRef.current, videoOff: videoOffRef.current, screenSharing: false });
            // Revert to camera on all peers (or null if no camera track)
            for (const [peerId, pc] of pcsRef.current) {
                const videoSender = pc.getSenders().find(s => s.track?.kind === 'video');
                const videoTrack = localStreamRef.current?.getVideoTracks()[0];
                if (videoSender) {
                    videoSender.replaceTrack(videoTrack || null).catch(() => { });
                }
            }
        } else {
            try {
                const ss = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
                screenStreamRef.current = ss;
                setScreenStream(ss);
                setScreenSharing(true);
                setPresenterId(user?.id);
                const screenTrack = ss.getVideoTracks()[0];
                // Replace or add video track on all peers
                for (const [peerId, pc] of pcsRef.current) {
                    const videoSender = pc.getSenders().find(s => s.track?.kind === 'video');
                    if (videoSender) {
                        videoSender.replaceTrack(screenTrack).catch(() => { });
                    } else {
                        // No video sender (audio-only) — add screen track and renegotiate
                        pc.addTrack(screenTrack, ss);
                        if (pc.signalingState === 'stable') {
                            try {
                                const offer = await pc.createOffer();
                                await pc.setLocalDescription(offer);
                                wsSend('meeting_signal', {
                                    meetingId,
                                    targetUserId: peerId,
                                    signal: { type: 'offer', sdp: pc.localDescription },
                                });
                            } catch (err) { console.error('Screen share renegotiation failed:', err); }
                        }
                    }
                }
                screenTrack.onended = () => toggleScreenShare();
                wsSend('meeting_track_state', { meetingId, muted: mutedRef.current, videoOff: videoOffRef.current, screenSharing: true });
            } catch { /* user cancelled */ }
        }
    }, [screenSharing, meetingId, wsSend, user?.id]);

    const raiseHand = useCallback(() => {
        const next = !raisedHand;
        setRaisedHand(next);
        wsSend('meeting_raise_hand', { meetingId, raised: next });
    }, [raisedHand, meetingId, wsSend]);

    const sendChatMessage = useCallback((text) => {
        if (!text.trim()) return;
        const trimmed = text.trim();
        // Optimistic local insertion so the sender always sees their own
        // message immediately — even if the server echo is delayed, dropped
        // by rate limiting, or arrives during a brief listener-rebind window.
        // The echo handler dedupes against the _optimistic flag.
        const optimistic = {
            sender_id: user?.id,
            sender_name: user?.full_name || user?.username || 'You',
            text: trimmed,
            created_at: new Date().toISOString(),
            _optimistic: true,
        };
        setMessages(prev => [...prev, optimistic]);
        wsSend('meeting_chat', { meetingId, text: trimmed });
    }, [meetingId, wsSend, user]);

    // Full media/peer cleanup — called by both endMeeting and leaveMeeting.
    const cleanupMedia = useCallback(() => {
        // Stop background processor + raw camera track
        teardownProcessor();
        // Stop screen share
        if (screenStreamRef.current) {
            screenStreamRef.current.getTracks().forEach(t => t.stop());
            screenStreamRef.current = null;
            setScreenStream(null);
        }
        // Stop all local media tracks (camera + microphone)
        if (localStreamRef.current) {
            localStreamRef.current.getTracks().forEach(t => t.stop());
            localStreamRef.current = null;
            setLocalStream(null);
        }
        // Close all peer connections
        pcsRef.current.forEach(pc => { try { pc.close(); } catch { } });
        pcsRef.current.clear();
        // Stop quality monitoring
        if (qualityTimerRef.current) {
            clearInterval(qualityTimerRef.current);
            qualityTimerRef.current = null;
        }
    }, [teardownProcessor]);

    const endMeeting = useCallback(() => {
        wsSend('meeting_end', { meetingId });
        cleanupMedia();
        setStatus('ended');
    }, [meetingId, wsSend, cleanupMedia]);

    const leaveMeeting = useCallback(() => {
        wsSend('meeting_leave', { meetingId });
        cleanupMedia();
        setStatus('left');
    }, [meetingId, wsSend, cleanupMedia]);

    const muteParticipant = useCallback((userId) => {
        wsSend('meeting_mute_participant', { meetingId, targetUserId: userId });
    }, [meetingId, wsSend]);

    const addParticipant = useCallback((userId) => {
        wsSend('meeting_add_participant', { meetingId, targetUserId: userId });
    }, [meetingId, wsSend]);

    // Switch input device mid-call
    const switchAudioDevice = useCallback(async (deviceId) => {
        try {
            const newStream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: deviceId } } });
            const newTrack = newStream.getAudioTracks()[0];
            if (!newTrack) return;
            // Replace in peer connections
            pcsRef.current.forEach(pc => {
                const sender = pc.getSenders().find(s => s.track?.kind === 'audio');
                if (sender) sender.replaceTrack(newTrack).catch(() => { });
            });
            // Replace in local stream
            if (localStreamRef.current) {
                localStreamRef.current.getAudioTracks().forEach(t => t.stop());
                localStreamRef.current.removeTrack(localStreamRef.current.getAudioTracks()[0]);
                localStreamRef.current.addTrack(newTrack);
            }
            newTrack.enabled = !muted;
        } catch (err) { console.error('switchAudioDevice:', err); }
    }, [muted]);

    const switchVideoDevice = useCallback(async (deviceId) => {
        try {
            const newStream = await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: deviceId } } });
            const newTrack = newStream.getVideoTracks()[0];
            if (!newTrack) return;
            pcsRef.current.forEach(pc => {
                const sender = pc.getSenders().find(s => s.track?.kind === 'video');
                if (sender) sender.replaceTrack(newTrack).catch(() => { });
            });
            if (localStreamRef.current) {
                localStreamRef.current.getVideoTracks().forEach(t => t.stop());
                const oldTrack = localStreamRef.current.getVideoTracks()[0];
                if (oldTrack) localStreamRef.current.removeTrack(oldTrack);
                localStreamRef.current.addTrack(newTrack);
                setLocalStream(new MediaStream(localStreamRef.current.getTracks()));
            }
            newTrack.enabled = !videoOff;
        } catch (err) { console.error('switchVideoDevice:', err); }
    }, [videoOff]);

    // ── Public: change background effect ─────────────────────────────────────
    // Applies (or removes) a blur / virtual-background effect on the local
    // camera. Updates senders via replaceTrack so no SDP renegotiation is
    // needed. Safe to call regardless of whether the camera is currently on,
    // sharing screen, or off — the effect will take hold the next time the
    // camera produces frames.
    const setBackgroundEffect = useCallback(async (effect) => {
        const next = effect && ['none', 'blur', 'image'].includes(effect.type) ? effect : { type: 'none' };
        setBgEffectState(next);
        bgEffectRef.current = next;
        storeEffect(next);

        if (!localStreamRef.current) return;

        // Don't touch peer senders while screen sharing (the sender holds the
        // screen track). Just update the processor so the user sees the effect
        // in the local preview path. When screen share ends, toggleScreenShare
        // restores the camera track from localStreamRef which already carries
        // the processed track.
        const currentVideoTrack = localStreamRef.current.getVideoTracks()[0];
        // currentVideoTrack is the *raw camera* only when no effect was
        // active before. If `rawCameraTrackRef.current` is set, then
        // currentVideoTrack is the processed canvas track and must NOT be
        // fed back into the processor (which would create a feedback loop
        // and short-circuit the change).
        const isLiveCameraTrack = !!currentVideoTrack
            && currentVideoTrack.readyState === 'live'
            && !rawCameraTrackRef.current;

        if (next.type === 'none') {
            // Restore the raw camera track on senders + local stream.
            if (rawCameraTrackRef.current && rawCameraTrackRef.current.readyState === 'live') {
                const raw = rawCameraTrackRef.current;
                if (currentVideoTrack && currentVideoTrack !== raw) {
                    try { currentVideoTrack.stop(); } catch { /* ignore */ }
                    localStreamRef.current.removeTrack(currentVideoTrack);
                }
                if (!localStreamRef.current.getVideoTracks().includes(raw)) {
                    localStreamRef.current.addTrack(raw);
                }
                rawCameraTrackRef.current = null;
                if (processorRef.current) {
                    try { processorRef.current.stop(); } catch { /* ignore */ }
                    processorRef.current = null;
                }
                if (!screenSharingRef.current) await replaceVideoTrackOnPeers(raw);
                setLocalStream(new MediaStream(localStreamRef.current.getTracks()));
            } else {
                // No raw track to restore — just stop the processor.
                teardownProcessor();
            }
            return;
        }

        // Effect on. We need a raw camera track to feed the processor. If
        // localStream's current video track *is* the raw camera (i.e. no
        // effect was active before), use that. Otherwise we need to acquire a
        // new camera track.
        let raw;
        if (isLiveCameraTrack) {
            raw = currentVideoTrack;
        } else if (rawCameraTrackRef.current && rawCameraTrackRef.current.readyState === 'live') {
            raw = rawCameraTrackRef.current;
        } else {
            try {
                const ms = await navigator.mediaDevices.getUserMedia({ video: true });
                raw = ms.getVideoTracks()[0];
            } catch (err) {
                console.warn('[meeting] could not acquire camera for effect:', err);
                return;
            }
        }

        const processed = await buildProcessedTrack(raw, next);
        if (processed === raw) {
            // Effect failed to initialise — leave everything as-is.
            return;
        }

        // Swap the processed track into the local stream + on peer senders.
        const oldTrack = localStreamRef.current.getVideoTracks()[0];
        if (oldTrack && oldTrack !== processed && oldTrack !== raw) {
            try { oldTrack.stop(); } catch { /* ignore */ }
            localStreamRef.current.removeTrack(oldTrack);
        } else if (oldTrack === raw) {
            // Detach the raw track from the local stream — the processor owns it now.
            localStreamRef.current.removeTrack(raw);
        }
        if (!localStreamRef.current.getVideoTracks().includes(processed)) {
            localStreamRef.current.addTrack(processed);
        }
        processed.enabled = !videoOffRef.current;
        if (!screenSharingRef.current) await replaceVideoTrackOnPeers(processed);
        setLocalStream(new MediaStream(localStreamRef.current.getTracks()));
    }, [buildProcessedTrack, replaceVideoTrackOnPeers, teardownProcessor]);

    // Re-apply the user's preferred effect once the local stream is ready
    // (e.g. on first join). Runs once per session.
    const initialEffectAppliedRef = useRef(false);
    useEffect(() => {
        if (initialEffectAppliedRef.current) return;
        if (!localStream) return;
        if (bgEffectRef.current?.type === 'none') { initialEffectAppliedRef.current = true; return; }
        initialEffectAppliedRef.current = true;
        setBackgroundEffect(bgEffectRef.current).catch(() => { });
    }, [localStream, setBackgroundEffect]);

    // Free the processor when leaving the meeting (or unmounting in non-PiP mode).
    useEffect(() => {
        return () => {
            if (!keepAliveOnUnmount) teardownProcessor();
        };
    }, [keepAliveOnUnmount, teardownProcessor]);

    return {
        // State
        localStream, screenStream, muted, videoOff, screenSharing,
        participants, status, raisedHand, messages,
        activePanel, setActivePanel,
        connectionQualities, presenterId,
        bgEffect,
        bgEffectError,
        // Actions
        toggleMute, toggleVideo, toggleScreenShare, raiseHand,
        sendChatMessage, endMeeting, leaveMeeting, muteParticipant, addParticipant,
        switchAudioDevice, switchVideoDevice,
        setBackgroundEffect,
        // WS message handler (MeetingRoom passes incoming WS msgs here)
        handleWsMessage,
    };
}

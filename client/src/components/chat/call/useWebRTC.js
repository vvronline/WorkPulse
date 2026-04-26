import { useState, useEffect, useRef, useCallback } from 'react';
import { getIceConfig } from '../../../api';

// Default ICE servers used when the server's /ice-config request fails.
// Includes the free Metered Open Relay TURN service so calls still work for
// peers behind restrictive NATs (same-NAT-no-hairpinning, symmetric NAT, etc.)
// even if the backend hasn't exposed a TURN configuration.
const FALLBACK_ICE_SERVERS = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' }
];

/**
 * Progressively-relaxed audio/video constraints. Each step is attempted in
 * order until getUserMedia succeeds. This is essential on mobile networks /
 * older devices where ideal constraints (1280x720@30fps) often fail.
 */
function buildMediaConstraintProfiles(isVideoCall) {
    const audio = {
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
    return [
        // 1. HD ideal — works on desktops with good cameras
        { audio, video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 }, facingMode: 'user' } },
        // 2. SD — typical mobile / weaker cameras
        { audio, video: { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 24, max: 30 }, facingMode: 'user' } },
        // 3. Low — congested networks, older webcams
        { audio, video: { width: { ideal: 320 }, height: { ideal: 240 }, frameRate: { ideal: 15, max: 24 }, facingMode: 'user' } },
        // 4. Bare video flag — let the browser pick anything that works
        { audio, video: true },
        // 5. Audio-only fallback — better than dropping the call entirely
        { audio, video: false },
    ];
}

export default function useWebRTC({ callState, callType, wsSend, onEnd, onStatusChange }) {
    const {
        callId, conversationId, isIncoming, callerId, acceptedBy,
        accepted, onSignal, onEndExternal, localStream, isReconnect, reconnectTo
    } = callState;

    const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
    const [remoteVideoOff, setRemoteVideoOff] = useState(false);
    const [remoteHasVideo, setRemoteHasVideo] = useState(false);

    // Track whether the *local* user has their camera explicitly off, so the
    // peer can be told and render an avatar instead of a frozen black frame.
    const [localVideoOff, setLocalVideoOff] = useState(false);

    const pcRef = useRef(null);
    const localStreamRef = useRef(null);
    const screenStreamRef = useRef(null);
    const remoteStreamRef = useRef(null);
    const localVideoRef = useRef(null);
    const remoteVideoRef = useRef(null);
    const remoteAudioRef = useRef(null);
    const pendingSignalsRef = useRef([]);
    const screenSenderRef = useRef(null);
    const connectionTimeoutRef = useRef(null);
    const ringtoneRef = useRef(null);
    const handleEndRef = useRef(null);
    const iceRestartAttemptedRef = useRef(false);
    const disconnectTimerRef = useRef(null);
    const pendingIceCandidatesRef = useRef([]);
    const iceServersRef = useRef(FALLBACK_ICE_SERVERS);
    const iceExpiresAtRef = useRef(0);
    const relayOnlyRef = useRef(false); // set true after a UDP-relay failure to force TURN/TCP/TLS only
    const networkOnlineRef = useRef(navigator.onLine);
    const initialIceConfigLoadedRef = useRef(false);

    // Fetch ICE config (STUN + optional TURN). Re-fetch when credentials are
    // about to expire (coturn ephemeral REST API issues short-lived creds).
    const refreshIceConfig = useCallback(async () => {
        try {
            const { data } = await getIceConfig();
            if (data?.iceServers?.length) {
                iceServersRef.current = data.iceServers;
                iceExpiresAtRef.current = data.expiresAt || 0;
                initialIceConfigLoadedRef.current = true;
                console.log('[call-webrtc] ICE config refreshed (mode:', data.mode || 'unknown', ', expiresAt:', data.expiresAt || 'never', ')');
            }
        } catch (err) {
            console.warn('[call-webrtc] ICE config fetch failed, using fallback:', err?.message || err);
        }
    }, []);

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
            try { ringtoneRef.current.osc.stop(); ringtoneRef.current.ctx.close(); } catch { }
            ringtoneRef.current = null;
        }
    }, []);

    // ─── Media helpers ───
    // Tries progressively-relaxed constraint profiles so the call still
    // succeeds on weak mobile networks, low-end webcams, or when the user has
    // an audio device but no working camera. Bubbles up a single useful error
    // message rather than silently dropping the call.
    const startMedia = useCallback(async () => {
        if (!navigator.mediaDevices?.getUserMedia) {
            alert('Your browser does not support audio/video calls. Please use Chrome, Edge, Firefox or Safari over HTTPS.');
            return null;
        }
        const profiles = buildMediaConstraintProfiles(callType === 'video');
        let lastError = null;

        for (let i = 0; i < profiles.length; i++) {
            const constraints = profiles[i];
            try {
                const stream = await navigator.mediaDevices.getUserMedia(constraints);
                if (i > 0) {
                    console.warn('[call-webrtc] media acquired with reduced profile #' + i, constraints);
                }
                localStreamRef.current = stream;
                if (localVideoRef.current && callType === 'video' && stream.getVideoTracks().length) {
                    localVideoRef.current.srcObject = stream;
                }
                return stream;
            } catch (err) {
                lastError = err;
                console.warn('[call-webrtc] getUserMedia profile', i, 'failed:', err?.name, err?.message);
                // Permission denial / device unavailable are unrecoverable — stop early.
                if (err?.name === 'NotAllowedError' || err?.name === 'SecurityError') break;
            }
        }

        console.error('[call-webrtc] getUserMedia exhausted all profiles:', lastError);
        const device = callType === 'video' ? 'camera/microphone' : 'microphone';
        if (lastError?.name === 'NotAllowedError') {
            alert(`${device} access is blocked.\n\n1. Click the lock/tune icon in the address bar → allow ${device}\n2. If the setting is locked, your organization may be blocking it — contact your IT admin to whitelist this site`);
        } else if (lastError?.name === 'NotFoundError' || lastError?.name === 'OverconstrainedError') {
            alert(`No usable ${device} found on this device.\n\nCheck:\n• Camera/mic is plugged in and not used by another app\n• Browser tab has permission (lock icon → Site Settings)\n• On Windows: Settings → Privacy → Camera/Microphone → Allow desktop apps`);
        } else if (lastError?.name === 'NotReadableError' || lastError?.name === 'TrackStartError') {
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
        clearTimeout(connectionTimeoutRef.current);
        clearTimeout(disconnectTimerRef.current);
        iceRestartAttemptedRef.current = false;
    }, []);

    const addIceCandidateSafe = useCallback(async (candidate) => {
        if (!pcRef.current) return;
        try {
            if (candidate === null) {
                // End-of-candidates marker. Some browsers (Firefox) reject null;
                // pass an empty candidate string as a portable fallback. Failure
                // here is non-fatal — the browser will time out trickle on its own.
                try {
                    await pcRef.current.addIceCandidate(null);
                } catch {
                    try { await pcRef.current.addIceCandidate({ candidate: '' }); } catch { /* ignore */ }
                }
            } else {
                await pcRef.current.addIceCandidate(new RTCIceCandidate(candidate));
            }
        } catch (err) {
            // Don't let one bad candidate kill the whole ICE exchange.
            console.warn('[call-webrtc] addIceCandidate failed (ignored):', err?.message || err);
        }
    }, []);

    const flushPendingIceCandidates = useCallback(async () => {
        if (!pcRef.current?.remoteDescription) return;
        const pendingCandidates = pendingIceCandidatesRef.current.splice(0);
        console.log('[call-webrtc] flushing', pendingCandidates.length, 'buffered ICE candidate(s)');
        for (const candidate of pendingCandidates) {
            await addIceCandidateSafe(candidate);
        }
    }, [addIceCandidateSafe]);

    const attachLocalTracks = useCallback(async (stream) => {
        if (!pcRef.current || !stream) return;
        const transceivers = pcRef.current.getTransceivers();
        const usedTransceivers = new Set();

        for (const track of stream.getTracks()) {
            // Skip if this exact track is already on some sender
            const alreadyAttached = transceivers.some(t => t.sender.track && t.sender.track.id === track.id);
            if (alreadyAttached) continue;

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
                    try { matchingTr.direction = 'sendrecv'; } catch { /* not always settable */ }
                    if (track.kind === 'video') screenSenderRef.current = matchingTr.sender;
                } catch (err) {
                    console.warn('[call-webrtc] replaceTrack failed, falling back to addTrack:', err?.message || err);
                    const sender = pcRef.current.addTrack(track, stream);
                    if (track.kind === 'video') screenSenderRef.current = sender;
                }
            } else {
                // No matching transceiver from the remote offer (e.g. caller
                // sent voice-only but we somehow have a video track) — addTrack
                // will create a new m-line and trigger renegotiation.
                const sender = pcRef.current.addTrack(track, stream);
                if (track.kind === 'video') screenSenderRef.current = sender;
            }
        }
    }, []);

    const createPeerConnection = useCallback((stream, targetUserId, addTracksNow = true) => {
        // When relayOnlyRef is true (after a previous host/srflx ICE failure), force
        // RTCPeerConnection to ignore host candidates and use TURN exclusively. This
        // is the lifeline for restrictive corporate networks that block UDP/STUN.
        const pcConfig = {
            iceServers: iceServersRef.current,
            iceCandidatePoolSize: 10,
            // bundlePolicy=max-bundle reduces port usage — better with corporate firewalls
            bundlePolicy: 'max-bundle',
            rtcpMuxPolicy: 'require',
        };
        if (relayOnlyRef.current) {
            pcConfig.iceTransportPolicy = 'relay';
            console.log('[call-webrtc] creating PC in RELAY-ONLY mode (TURN-only) — corporate proxy fallback');
        }
        const pc = new RTCPeerConnection(pcConfig);
        pcRef.current = pc;

        // Track whether initial negotiation is done to avoid duplicate offers
        let initialNegotiationDone = false;

        // Surface TURN configuration so missing TURN doesn't silently break NAT traversal
        const hasTurn = (iceServersRef.current || []).some(s => {
            const urls = Array.isArray(s.urls) ? s.urls : [s.urls];
            return urls.some(u => typeof u === 'string' && u.startsWith('turn'));
        });
        if (!hasTurn) {
            console.warn('[call-webrtc] No TURN server configured — calls may fail on restrictive networks. Configure TURN_HOST + TURN_STATIC_AUTH_SECRET (coturn) on the server.');
        }

        // For the OFFERER we need tracks before createOffer. For the ANSWERER,
        // tracks must be attached AFTER setRemoteDescription(offer) so they
        // bind to the existing transceivers instead of creating new m-lines.
        if (stream && addTracksNow) {
            stream.getTracks().forEach(track => {
                const sender = pc.addTrack(track, stream);
                if (track.kind === 'video') screenSenderRef.current = sender;
            });
        }

        // Auto-renegotiate when tracks are added/removed mid-call (e.g. screen share)
        pc.onnegotiationneeded = async () => {
            if (!initialNegotiationDone) return;
            try {
                const offer = await pc.createOffer();
                await pc.setLocalDescription(offer);
                wsSend('call_signal', {
                    conversationId, targetUserId,
                    signal: { type: 'offer', sdp: offer.sdp }
                });
            } catch (err) {
                console.error('Renegotiation failed:', err);
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

            console.log('[call-webrtc] ontrack:', e.track?.kind, 'muted=', e.track?.muted, 'streamTracks=', remoteStream.getTracks().map(t => t.kind).join(','));

            // Attach to audio sink (always — covers both video and audio calls).
            if (remoteAudioRef.current && remoteAudioRef.current.srcObject !== remoteStream) {
                remoteAudioRef.current.srcObject = remoteStream;
                remoteAudioRef.current.volume = 1.0;
                remoteAudioRef.current.play().catch(err => console.warn('[call-webrtc] remote audio autoplay blocked:', err?.message || err));
            }

            // Attach to video sink. We re-assign srcObject on EVERY ontrack
            // even if it's the same stream object — some browsers (Safari,
            // older Chromium) only render the new track after a fresh
            // assignment, otherwise the <video> stays black.
            if (remoteVideoRef.current) {
                remoteVideoRef.current.srcObject = null; // force a teardown
                remoteVideoRef.current.srcObject = remoteStream;
                if (isMobile) remoteVideoRef.current.muted = true; // mobile autoplay needs muted
                remoteVideoRef.current.play().catch(err => console.warn('[call-webrtc] remote video autoplay blocked:', err?.message || err));
            }

            if (e.track.kind === 'video') {
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
                    console.log('[call-webrtc] remote video track muted');
                    setRemoteVideoOff(true);
                };
                e.track.onunmute = () => {
                    console.log('[call-webrtc] remote video track unmuted');
                    setRemoteVideoOff(false);
                    // Re-attach srcObject — some browsers need this to actually
                    // start rendering frames after the first unmute.
                    if (remoteVideoRef.current && remoteStreamRef.current) {
                        remoteVideoRef.current.srcObject = null;
                        remoteVideoRef.current.srcObject = remoteStreamRef.current;
                        remoteVideoRef.current.play().catch(() => { });
                    }
                };
                e.track.onended = () => {
                    console.log('[call-webrtc] remote video track ended');
                    setRemoteHasVideo(false);
                };
            }
        };

        pc.onicecandidate = (e) => {
            if (e.candidate) {
                const c = e.candidate;
                console.log('[call-webrtc] local ICE candidate →', c.type || '?', c.protocol || '?', c.address || c.candidate?.split(' ')[4] || '?');
                wsSend('call_signal', {
                    conversationId, targetUserId,
                    signal: { type: 'ice-candidate', candidate: c.toJSON() }
                });
            }
            // We intentionally do NOT forward the null end-of-candidates marker:
            // it is unreliable across browsers (Firefox throws on addIceCandidate(null))
            // and the peer will infer end-of-trickle from the ICE gathering timeout.
        };

        pc.onicecandidateerror = (e) => {
            console.warn('[call-webrtc] ICE candidate error:', e.errorCode, e.errorText, e.url);
        };

        pc.oniceconnectionstatechange = () => {
            console.log('[call-webrtc] ICE connection state:', pc.iceConnectionState);
            if (pc.iceConnectionState === 'failed') {
                console.warn('[call-webrtc] ICE failed — will attempt restart. Persistent failures usually mean a TURN server is required (corporate proxy / symmetric NAT).');
                // Dump candidate-pair stats for diagnosis
                try {
                    pc.getStats().then(stats => {
                        const pairs = [];
                        stats.forEach(r => {
                            if (r.type === 'candidate-pair') pairs.push({ state: r.state, nominated: r.nominated, local: r.localCandidateId, remote: r.remoteCandidateId });
                        });
                        console.warn('[call-webrtc] candidate pairs:', pairs);
                    }).catch(() => { });
                } catch { /* ignore */ }
            } else if (pc.iceConnectionState === 'disconnected') {
                // Brief network blip on mobile / VPN — try a fast ICE restart proactively
                // before the connectionState=failed handler tears the call down.
                if (initialNegotiationDone && !iceRestartAttemptedRef.current) {
                    setTimeout(() => {
                        if (pc.iceConnectionState === 'disconnected' || pc.iceConnectionState === 'failed') {
                            console.log('[call-webrtc] still disconnected after 2s — issuing ICE restart');
                            iceRestartAttemptedRef.current = true;
                            pc.createOffer({ iceRestart: true })
                                .then(o => pc.setLocalDescription(o))
                                .then(() => wsSend('call_signal', {
                                    conversationId, targetUserId,
                                    signal: { type: 'offer', sdp: pc.localDescription.sdp }
                                }))
                                .catch(err => console.warn('[call-webrtc] ICE restart failed:', err));
                        }
                    }, 2000);
                }
            }
        };

        pc.onicegatheringstatechange = () => {
            console.log('[call-webrtc] ICE gathering state:', pc.iceGatheringState);
        };

        pc.onconnectionstatechange = () => {
            console.log('[call-webrtc] connection state:', pc.connectionState);
            if (pc.connectionState === 'connected') {
                initialNegotiationDone = true;
                onStatusChange('connected');
                stopRingtone();
                clearTimeout(disconnectTimerRef.current);
                iceRestartAttemptedRef.current = false;
            } else if (pc.connectionState === 'disconnected') {
                // Grace period: temporary network hiccup — wait 5s before ending
                clearTimeout(disconnectTimerRef.current);
                disconnectTimerRef.current = setTimeout(() => {
                    if (handleEndRef.current) handleEndRef.current();
                }, 5000);
            } else if (pc.connectionState === 'failed') {
                clearTimeout(disconnectTimerRef.current);
                // Strategy: ICE restart → relay-only rebuild → give up.
                if (!iceRestartAttemptedRef.current && initialNegotiationDone) {
                    iceRestartAttemptedRef.current = true;
                    pc.createOffer({ iceRestart: true }).then(offer => {
                        return pc.setLocalDescription(offer);
                    }).then(() => {
                        wsSend('call_signal', {
                            conversationId, targetUserId,
                            signal: { type: 'offer', sdp: pc.localDescription.sdp }
                        });
                    }).catch(() => {
                        if (handleEndRef.current) handleEndRef.current();
                    });
                } else if (!relayOnlyRef.current && hasTurn) {
                    // ICE restart failed too — escalate to relay-only and rebuild
                    // the connection. This is the corporate-proxy escape hatch:
                    // every byte goes through TURN over TCP/TLS so even networks
                    // that block UDP/STUN entirely can complete the call.
                    console.warn('[call-webrtc] escalating to RELAY-ONLY mode after ICE restart failed');
                    relayOnlyRef.current = true;
                    onStatusChange('reconnecting');
                    refreshIceConfig().finally(() => {
                        if (pcRef.current) { try { pcRef.current.close(); } catch { } pcRef.current = null; }
                        const newPc = createPeerConnection(localStreamRef.current, targetUserId, true);
                        newPc.createOffer().then(o => newPc.setLocalDescription(o)).then(() => {
                            wsSend('call_signal', {
                                conversationId, targetUserId,
                                signal: { type: 'offer', sdp: newPc.localDescription.sdp }
                            });
                        }).catch(err => {
                            console.error('[call-webrtc] relay-only rebuild failed:', err);
                            if (handleEndRef.current) handleEndRef.current();
                        });
                    });
                } else {
                    if (handleEndRef.current) handleEndRef.current();
                }
            }
        };

        return pc;
    }, [conversationId, wsSend, stopRingtone, isMobile, onStatusChange, refreshIceConfig]);

    // ─── Signal handling with buffering ───
    const flushPendingSignals = useCallback(() => {
        if (!pcRef.current) return;
        const pending = pendingSignalsRef.current.splice(0);
        for (const { signal, fromUserId } of pending) {
            handleSignalInternal(signal, fromUserId);
        }
    }, []);

    const handleSignalInternal = useCallback(async (signal, fromUserId) => {
        if (!pcRef.current) return;
        try {
            console.log('[call-webrtc] handleSignal:', signal.type, 'from:', fromUserId, 'pcState:', pcRef.current.signalingState);
            if (signal.type === 'offer') {
                await pcRef.current.setRemoteDescription(new RTCSessionDescription(signal));
                // CRITICAL: attach local tracks AFTER setRemoteDescription so they
                // bind to the transceivers created by the offer, instead of producing
                // extra unmatched m-sections that prevent ICE from establishing.
                await attachLocalTracks(localStreamRef.current);
                const answer = await pcRef.current.createAnswer();
                await pcRef.current.setLocalDescription(answer);
                console.log('[call-webrtc] sending answer to:', fromUserId);
                wsSend('call_signal', {
                    conversationId, targetUserId: fromUserId,
                    signal: { type: 'answer', sdp: answer.sdp }
                });
                await flushPendingIceCandidates();
            } else if (signal.type === 'answer') {
                // Ignore stray answers when we are not expecting one (avoids
                // "Failed to set remote answer sdp: Called in wrong state").
                if (pcRef.current.signalingState !== 'have-local-offer') {
                    console.warn('[call-webrtc] ignoring answer in state:', pcRef.current.signalingState);
                } else {
                    await pcRef.current.setRemoteDescription(new RTCSessionDescription(signal));
                    await flushPendingIceCandidates();
                }
            } else if (signal.type === 'ice-candidate') {
                // null/empty candidate is the end-of-candidates marker. We don't
                // need to forward it to addIceCandidate — drop it silently.
                if (signal.candidate == null || signal.candidate.candidate === '') {
                    return;
                }
                if (pcRef.current.remoteDescription) {
                    await addIceCandidateSafe(signal.candidate);
                } else {
                    pendingIceCandidatesRef.current.push(signal.candidate);
                }
            } else if (signal.type === 'video-state') {
                // Peer told us they toggled their camera. Browsers' track.onmute
                // is unreliable (Chrome lags 5–10s, Firefox often never fires),
                // so we use this explicit signal to flip the avatar overlay
                // immediately on both sides.
                setRemoteVideoOff(!!signal.videoOff);
            }
        } catch (err) {
            console.error('[call-webrtc] Signal handling error:', err);
        }
    }, [conversationId, wsSend, flushPendingIceCandidates, addIceCandidateSafe]);

    const handleSignal = useCallback((signal, fromUserId) => {
        // Detect a "fresh session" offer that requires us to tear down our
        // current PC and start over. Cases:
        //   • Our PC is in `failed` / `closed` (peer is rebuilding after ICE failure)
        //   • Our PC is in `stable` but stuck disconnected for >2s (peer doing relay rebuild)
        //   • The incoming offer's o= line shows a new session-id (peer recreated PC)
        if (signal.type === 'offer' && pcRef.current) {
            const cs = pcRef.current.connectionState;
            const ics = pcRef.current.iceConnectionState;
            const needsRebuild = cs === 'failed' || cs === 'closed' ||
                ics === 'failed' || ics === 'closed';
            if (needsRebuild) {
                console.warn('[call-webrtc] received offer while PC is', cs, '/', ics, '— rebuilding (peer is doing relay-only escalation)');
                // Mirror the peer: if they had to escalate, our network is
                // probably the one with the problem. Force relay-only too so
                // both sides converge on a TURN-over-TLS path.
                relayOnlyRef.current = true;
                try { pcRef.current.close(); } catch { /* ignore */ }
                pcRef.current = null;
                pendingIceCandidatesRef.current = []; // candidates from the dead PC are useless
            }
        }
        if (!pcRef.current && signal.type === 'offer' && localStreamRef.current) {
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
        clearTimeout(disconnectTimerRef.current);
        wsSend('call_end', { callId, conversationId });
        cleanup();
        onEnd();
    }, [callId, conversationId, wsSend, onEnd, stopRingtone, cleanup]);

    // Keep handleEndRef always pointing to the latest handleEnd (avoids stale closure in PC handlers)
    handleEndRef.current = handleEnd;

    const handleReject = useCallback(() => {
        stopRingtone();
        wsSend('call_reject', { callId, conversationId });
        cleanup();
        onEnd();
    }, [callId, conversationId, wsSend, onEnd, stopRingtone, cleanup]);

    // ─── Accept incoming call ───
    const handleAccept = useCallback(async () => {
        onStatusChange('connecting');
        stopRingtone();
        const stream = await startMedia();
        if (!stream) { handleEnd(); return; }
        // Answerer side: create PC WITHOUT adding tracks yet. Tracks are
        // attached to the offer's transceivers later in handleSignalInternal,
        // which avoids the m-line mismatch that prevents ICE from completing.
        createPeerConnection(stream, callerId, false);
        flushPendingSignals();
        wsSend('call_accept', { callId, conversationId });
    }, [callId, conversationId, wsSend, startMedia, createPeerConnection, callerId, stopRingtone, flushPendingSignals, onStatusChange, handleEnd]);

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
            if (localVideoRef.current && callType === 'video') {
                localVideoRef.current.srcObject = localStream;
            }
        }
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    // ─── Reconnect: acquire media and wait for peer to re-offer ───
    useEffect(() => {
        if (!isReconnect) return;
        (async () => {
            const stream = await startMedia();
            if (!stream) { handleEnd(); return; }
            onStatusChange('reconnecting');
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
            wsSend('call_signal', {
                conversationId, targetUserId,
                signal: { type: 'offer', sdp: offer.sdp }
            });
        })().catch(console.error);
    }, [reconnectTo]); // eslint-disable-line react-hooks/exhaustive-deps

    // ─── Caller side: create offer once accepted ───
    useEffect(() => {
        if (accepted && !isIncoming) {
            (async () => {
                console.log('[call-webrtc] call accepted, creating offer. acceptedBy:', acceptedBy, 'hasStream:', !!localStreamRef.current);
                onStatusChange('connecting');
                stopRingtone();
                const stream = localStreamRef.current;
                if (!stream) { console.warn('[call-webrtc] no local stream, ending call'); handleEnd(); return; }
                const pc = createPeerConnection(stream, acceptedBy);
                flushPendingSignals();
                const offer = await pc.createOffer();
                await pc.setLocalDescription(offer);
                console.log('[call-webrtc] sending offer to:', acceptedBy);
                wsSend('call_signal', {
                    conversationId, targetUserId: acceptedBy,
                    signal: { type: 'offer', sdp: offer.sdp }
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

    // ─── Network change handling (mobile: WiFi ↔ cellular handoff, VPN connect/disconnect) ───
    // The browser's `online`/`offline` events fire on network adapter changes.
    // Connection.onchange (when available) catches more (e.g. WiFi→4G on Android).
    // On any of these we issue a fast ICE restart so the call survives.
    useEffect(() => {
        const triggerIceRestart = (reason) => {
            if (!pcRef.current) return;
            if (pcRef.current.connectionState !== 'connected' && pcRef.current.connectionState !== 'disconnected') return;
            console.log('[call-webrtc] network change detected (', reason, ') — issuing ICE restart');
            iceRestartAttemptedRef.current = false; // allow another restart
            const pc = pcRef.current;
            pc.createOffer({ iceRestart: true })
                .then(o => pc.setLocalDescription(o))
                .then(() => {
                    const target = isIncoming ? callerId : (acceptedBy || reconnectTo);
                    if (!target) return;
                    wsSend('call_signal', {
                        conversationId, targetUserId: target,
                        signal: { type: 'offer', sdp: pc.localDescription.sdp }
                    });
                })
                .catch(err => console.warn('[call-webrtc] network-change ICE restart failed:', err));
        };

        const onOnline = () => {
            networkOnlineRef.current = true;
            triggerIceRestart('navigator.online');
        };
        const onOffline = () => { networkOnlineRef.current = false; };
        const onConnChange = () => triggerIceRestart('connection.change');
        const onVisibility = () => {
            if (document.visibilityState === 'visible' && pcRef.current?.iceConnectionState === 'disconnected') {
                triggerIceRestart('visibility');
            }
        };

        window.addEventListener('online', onOnline);
        window.addEventListener('offline', onOffline);
        document.addEventListener('visibilitychange', onVisibility);
        const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
        conn?.addEventListener?.('change', onConnChange);

        return () => {
            window.removeEventListener('online', onOnline);
            window.removeEventListener('offline', onOffline);
            document.removeEventListener('visibilitychange', onVisibility);
            conn?.removeEventListener?.('change', onConnChange);
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
        }
    }, [remoteHasVideo]);

    // ─── Connection timeout ───
    useEffect(() => {
        return () => clearTimeout(connectionTimeoutRef.current);
    }, []);

    // ─── Send our local camera on/off state to the peer ───
    const sendLocalVideoState = useCallback((isVideoOff) => {
        setLocalVideoOff(isVideoOff);
        const target = isIncoming ? callerId : (acceptedBy || reconnectTo);
        if (!target) return;
        wsSend('call_signal', {
            conversationId, targetUserId: target,
            signal: { type: 'video-state', videoOff: !!isVideoOff }
        });
    }, [conversationId, wsSend, isIncoming, callerId, acceptedBy, reconnectTo]);

    // When the peer (re)connects, re-announce our current camera state so they
    // render the right thing immediately (avoids stale "video on" after reconnect).
    useEffect(() => {
        if (!pcRef.current) return;
        const pc = pcRef.current;
        const handler = () => {
            if (pc.connectionState === 'connected') {
                sendLocalVideoState(localVideoOff);
            }
        };
        pc.addEventListener('connectionstatechange', handler);
        return () => pc.removeEventListener('connectionstatechange', handler);
    }, [sendLocalVideoState, localVideoOff]);

    return {
        pcRef, localStreamRef, screenStreamRef, remoteStreamRef,
        localVideoRef, remoteVideoRef, remoteAudioRef,
        screenSenderRef, connectionTimeoutRef, ringtoneRef,
        handleAccept, handleReject, handleEnd,
        stopRingtone, startMedia, createPeerConnection,
        isMobile, remoteVideoOff, remoteHasVideo,
        sendLocalVideoState
    };
}

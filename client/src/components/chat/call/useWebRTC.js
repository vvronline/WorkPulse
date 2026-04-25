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

export default function useWebRTC({ callState, callType, wsSend, onEnd, onStatusChange }) {
    const {
        callId, conversationId, isIncoming, callerId, acceptedBy,
        accepted, onSignal, onEndExternal, localStream, isReconnect, reconnectTo
    } = callState;

    const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
    const [remoteVideoOff, setRemoteVideoOff] = useState(false);
    const [remoteHasVideo, setRemoteHasVideo] = useState(false);

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

    // Fetch ICE config (STUN + optional TURN) once on mount
    useEffect(() => {
        getIceConfig()
            .then(({ data }) => { if (data?.iceServers?.length) iceServersRef.current = data.iceServers; })
            .catch(() => { /* fallback already set */ });
    }, []);

    const stopRingtone = useCallback(() => {
        if (ringtoneRef.current) {
            try { ringtoneRef.current.osc.stop(); ringtoneRef.current.ctx.close(); } catch { }
            ringtoneRef.current = null;
        }
    }, []);

    // ─── Media helpers ───
    const startMedia = useCallback(async () => {
        try {
            const constraints = {
                audio: {
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true
                },
                video: callType === 'video' ? { width: 1280, height: 720, facingMode: 'user' } : false
            };
            const stream = await navigator.mediaDevices.getUserMedia(constraints);
            localStreamRef.current = stream;
            if (localVideoRef.current && callType === 'video') {
                localVideoRef.current.srcObject = stream;
            }
            return stream;
        } catch (err) {
            console.error('Failed to get media:', err);
            const device = callType === 'video' ? 'camera/microphone' : 'microphone';
            if (err?.name === 'NotAllowedError') {
                alert(`${device} access is blocked.\n\n1. Click the lock/tune icon in the address bar → allow ${device}\n2. If the setting is locked, your organization may be blocking it — contact your IT admin to whitelist this site`);
            }
            return null;
        }
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
        const pc = new RTCPeerConnection({
            iceServers: iceServersRef.current,
            iceCandidatePoolSize: 10
        });
        pcRef.current = pc;

        // Track whether initial negotiation is done to avoid duplicate offers
        let initialNegotiationDone = false;

        // Surface TURN configuration so missing TURN doesn't silently break NAT traversal
        const hasTurn = (iceServersRef.current || []).some(s => {
            const urls = Array.isArray(s.urls) ? s.urls : [s.urls];
            return urls.some(u => typeof u === 'string' && u.startsWith('turn'));
        });
        if (!hasTurn) {
            console.warn('[call-webrtc] No TURN server configured — calls may fail on restrictive networks. Configure TURN_SERVER_URL/USERNAME/CREDENTIAL on the server.');
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
            const remoteStream = e.streams[0];
            remoteStreamRef.current = remoteStream;
            if (remoteAudioRef.current) {
                remoteAudioRef.current.srcObject = remoteStream;
                remoteAudioRef.current.volume = 1.0;
                remoteAudioRef.current.play().catch(() => { });
            }
            if (remoteVideoRef.current) {
                remoteVideoRef.current.srcObject = remoteStream;
                if (isMobile) remoteVideoRef.current.muted = true;
            }
            if (e.track.kind === 'video') {
                setRemoteHasVideo(true);
                setRemoteVideoOff(e.track.muted);
                e.track.onmute = () => setRemoteVideoOff(true);
                e.track.onunmute = () => setRemoteVideoOff(false);
                e.track.onended = () => setRemoteHasVideo(false);
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
                console.warn('[call-webrtc] ICE failed — will attempt ICE restart. If this persists, a TURN server is likely required for your network.');
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
                // Attempt ICE restart once before giving up
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
                } else {
                    if (handleEndRef.current) handleEndRef.current();
                }
            }
        };

        return pc;
    }, [conversationId, wsSend, stopRingtone, isMobile, onStatusChange]);

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
            }
        } catch (err) {
            console.error('[call-webrtc] Signal handling error:', err);
        }
    }, [conversationId, wsSend, flushPendingIceCandidates, addIceCandidateSafe]);

    const handleSignal = useCallback((signal, fromUserId) => {
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

    return {
        pcRef, localStreamRef, screenStreamRef, remoteStreamRef,
        localVideoRef, remoteVideoRef, remoteAudioRef,
        screenSenderRef, connectionTimeoutRef, ringtoneRef,
        handleAccept, handleReject, handleEnd,
        stopRingtone, startMedia, createPeerConnection,
        isMobile, remoteVideoOff, remoteHasVideo
    };
}

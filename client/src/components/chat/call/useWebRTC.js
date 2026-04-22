import { useState, useEffect, useRef, useCallback } from 'react';

const ICE_SERVERS = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun3.l.google.com:19302' },
    { urls: 'stun:stun4.l.google.com:19302' }
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
        clearTimeout(connectionTimeoutRef.current);
        clearTimeout(disconnectTimerRef.current);
        iceRestartAttemptedRef.current = false;
    }, []);

    const createPeerConnection = useCallback((stream, targetUserId) => {
        const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
        pcRef.current = pc;

        // Track whether initial negotiation is done to avoid duplicate offers
        let initialNegotiationDone = false;

        if (stream) {
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
                wsSend('call_signal', {
                    conversationId, targetUserId,
                    signal: { type: 'ice-candidate', candidate: e.candidate }
                });
            }
        };

        pc.onconnectionstatechange = () => {
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
            if (signal.type === 'offer') {
                await pcRef.current.setRemoteDescription(new RTCSessionDescription(signal));
                const answer = await pcRef.current.createAnswer();
                await pcRef.current.setLocalDescription(answer);
                wsSend('call_signal', {
                    conversationId, targetUserId: fromUserId,
                    signal: { type: 'answer', sdp: answer.sdp }
                });
            } else if (signal.type === 'answer') {
                await pcRef.current.setRemoteDescription(new RTCSessionDescription(signal));
            } else if (signal.type === 'ice-candidate' && signal.candidate) {
                await pcRef.current.addIceCandidate(new RTCIceCandidate(signal.candidate));
            }
        } catch (err) {
            console.error('Signal handling error:', err);
        }
    }, [conversationId, wsSend]);

    const handleSignal = useCallback((signal, fromUserId) => {
        if (!pcRef.current && signal.type === 'offer' && localStreamRef.current) {
            createPeerConnection(localStreamRef.current, fromUserId);
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
        createPeerConnection(stream, callerId);
        flushPendingSignals();
        wsSend('call_accept', { callId, conversationId });
    }, [callId, conversationId, wsSend, startMedia, createPeerConnection, callerId, stopRingtone, flushPendingSignals, onStatusChange, handleEnd]);

    // ─── Register signal handler ───
    useEffect(() => {
        if (onSignal) onSignal.current = handleSignal;
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
                onStatusChange('connecting');
                stopRingtone();
                const stream = localStreamRef.current;
                if (!stream) { handleEnd(); return; }
                const pc = createPeerConnection(stream, acceptedBy);
                flushPendingSignals();
                const offer = await pc.createOffer();
                await pc.setLocalDescription(offer);
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

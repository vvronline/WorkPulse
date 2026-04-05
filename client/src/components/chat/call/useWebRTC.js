import { useState, useEffect, useRef, useCallback } from 'react';

const ICE_SERVERS = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
];

export default function useWebRTC({ callState, callType, wsSend, onEnd, onStatusChange }) {
    const {
        callId, conversationId, isIncoming, callerId, acceptedBy,
        accepted, onSignal, onEndExternal, localStream, isReconnect, reconnectTo
    } = callState;

    const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

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
    }, []);

    const createPeerConnection = useCallback((stream, targetUserId) => {
        const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
        pcRef.current = pc;

        if (stream) {
            stream.getTracks().forEach(track => {
                const sender = pc.addTrack(track, stream);
                if (track.kind === 'video') screenSenderRef.current = sender;
            });
        }

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
                onStatusChange('connected');
                stopRingtone();
            } else if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
                handleEnd();
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
            try { await pcRef.current.addIceCandidate(new RTCIceCandidate(signal.candidate)); } catch { }
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
        wsSend('call_end', { callId, conversationId });
        cleanup();
        onEnd();
    }, [callId, conversationId, wsSend, onEnd, stopRingtone, cleanup]);

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
        isMobile
    };
}

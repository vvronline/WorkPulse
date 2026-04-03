import { useState, useEffect, useRef, useCallback } from 'react';
import { ChatAvatar } from './';
import s from './CallOverlay.module.css';

const ICE_SERVERS = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
];

export default function CallOverlay({ callState, user, wsSend, onEnd }) {
    const {
        callId, conversationId, callType, isIncoming,
        remoteName, remoteAvatar, isGroup
    } = callState;

    const [status, setStatus] = useState(isIncoming ? 'incoming' : 'ringing');
    const [duration, setDuration] = useState(0);
    const [muted, setMuted] = useState(false);
    const [videoOff, setVideoOff] = useState(false);
    const [speakerOn, setSpeakerOn] = useState(false);

    const pcRef = useRef(null);
    const localStreamRef = useRef(null);
    const remoteStreamRef = useRef(null);
    const localVideoRef = useRef(null);
    const remoteVideoRef = useRef(null);
    const timerRef = useRef(null);
    const ringtoneRef = useRef(null);

    // Duration timer
    useEffect(() => {
        if (status === 'connected') {
            timerRef.current = setInterval(() => setDuration(d => d + 1), 1000);
        }
        return () => clearInterval(timerRef.current);
    }, [status]);

    // Play ringtone
    useEffect(() => {
        if (status === 'ringing' || status === 'incoming') {
            try {
                const ctx = new (window.AudioContext || window.webkitAudioContext)();
                const osc = ctx.createOscillator();
                const gain = ctx.createGain();
                osc.connect(gain);
                gain.connect(ctx.destination);
                osc.frequency.value = status === 'incoming' ? 440 : 480;
                gain.gain.value = 0.1;
                osc.start();
                ringtoneRef.current = { ctx, osc, gain };

                // Pulse effect
                const pulse = () => {
                    if (!ringtoneRef.current) return;
                    gain.gain.setValueAtTime(0.1, ctx.currentTime);
                    gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.5);
                    setTimeout(pulse, 1000);
                };
                pulse();
            } catch { /* audio not available */ }
        }
        return () => {
            if (ringtoneRef.current) {
                try {
                    ringtoneRef.current.osc.stop();
                    ringtoneRef.current.ctx.close();
                } catch { /* ignore */ }
                ringtoneRef.current = null;
            }
        };
    }, [status]);

    const stopRingtone = useCallback(() => {
        if (ringtoneRef.current) {
            try {
                ringtoneRef.current.osc.stop();
                ringtoneRef.current.ctx.close();
            } catch { /* ignore */ }
            ringtoneRef.current = null;
        }
    }, []);

    // Initialize media and WebRTC
    const startMedia = useCallback(async () => {
        try {
            const constraints = {
                audio: true,
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
            return null;
        }
    }, [callType]);

    const createPeerConnection = useCallback((stream, targetUserId) => {
        const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
        pcRef.current = pc;

        // Add local tracks
        if (stream) {
            stream.getTracks().forEach(track => pc.addTrack(track, stream));
        }

        // Handle remote tracks
        pc.ontrack = (e) => {
            remoteStreamRef.current = e.streams[0];
            if (remoteVideoRef.current) {
                remoteVideoRef.current.srcObject = e.streams[0];
            }
        };

        // Send ICE candidates
        pc.onicecandidate = (e) => {
            if (e.candidate) {
                wsSend('call_signal', {
                    conversationId,
                    targetUserId,
                    signal: { type: 'ice-candidate', candidate: e.candidate }
                });
            }
        };

        pc.onconnectionstatechange = () => {
            if (pc.connectionState === 'connected') {
                setStatus('connected');
                stopRingtone();
            } else if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
                handleEnd();
            }
        };

        return pc;
    }, [conversationId, wsSend, stopRingtone]);

    // Handle incoming WebRTC signals
    const handleSignal = useCallback(async (signal, fromUserId) => {
        if (!pcRef.current) return;

        if (signal.type === 'offer') {
            await pcRef.current.setRemoteDescription(new RTCSessionDescription(signal));
            const answer = await pcRef.current.createAnswer();
            await pcRef.current.setLocalDescription(answer);
            wsSend('call_signal', {
                conversationId,
                targetUserId: fromUserId,
                signal: { type: 'answer', sdp: answer.sdp }
            });
        } else if (signal.type === 'answer') {
            await pcRef.current.setRemoteDescription(new RTCSessionDescription(signal));
        } else if (signal.type === 'ice-candidate' && signal.candidate) {
            try {
                await pcRef.current.addIceCandidate(new RTCIceCandidate(signal.candidate));
            } catch { /* ignore */ }
        }
    }, [conversationId, wsSend]);

    // Expose signal handler
    useEffect(() => {
        if (callState.onSignal) callState.onSignal.current = handleSignal;
    }, [handleSignal, callState.onSignal]);

    // For OUTGOING calls: acquire media immediately on mount (still within user gesture chain)
    useEffect(() => {
        if (!isIncoming && !localStreamRef.current) {
            startMedia().then(stream => {
                if (!stream) {
                    // Permission denied or no device — abort the call
                    wsSend('call_end', { callId, conversationId });
                    cleanup();
                    onEnd();
                }
            });
        }
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    // Accept incoming call
    const handleAccept = useCallback(async () => {
        setStatus('connecting');
        stopRingtone();
        wsSend('call_accept', { callId, conversationId });

        const stream = await startMedia();
        if (!stream) { handleEnd(); return; }

        // The caller will send an offer after receiving acceptance
        const targetUserId = callState.callerId;
        createPeerConnection(stream, targetUserId);
    }, [callId, conversationId, wsSend, startMedia, createPeerConnection, callState.callerId, stopRingtone]);

    // Handle call accepted (caller side) → create offer using already-acquired media
    useEffect(() => {
        if (callState.accepted && !isIncoming) {
            (async () => {
                setStatus('connecting');
                stopRingtone();
                const stream = localStreamRef.current;
                if (!stream) { handleEnd(); return; }

                const pc = createPeerConnection(stream, callState.acceptedBy);
                const offer = await pc.createOffer();
                await pc.setLocalDescription(offer);
                wsSend('call_signal', {
                    conversationId,
                    targetUserId: callState.acceptedBy,
                    signal: { type: 'offer', sdp: offer.sdp }
                });
            })();
        }
    }, [callState.accepted, callState.acceptedBy]);

    // Reject incoming call
    const handleReject = useCallback(() => {
        stopRingtone();
        wsSend('call_reject', { callId, conversationId });
        cleanup();
        onEnd();
    }, [callId, conversationId, wsSend, onEnd, stopRingtone]);

    // End call
    const handleEnd = useCallback(() => {
        stopRingtone();
        wsSend('call_end', { callId, conversationId });
        cleanup();
        onEnd();
    }, [callId, conversationId, wsSend, onEnd, stopRingtone]);

    // Expose end handler for external call_ended events
    useEffect(() => {
        if (callState.onEndExternal) callState.onEndExternal.current = () => {
            stopRingtone();
            cleanup();
            onEnd();
        };
    }, [onEnd, stopRingtone]);

    const cleanup = () => {
        if (localStreamRef.current) {
            localStreamRef.current.getTracks().forEach(t => t.stop());
            localStreamRef.current = null;
        }
        if (pcRef.current) {
            pcRef.current.close();
            pcRef.current = null;
        }
        clearInterval(timerRef.current);
    };

    // Cleanup on unmount
    useEffect(() => cleanup, []);

    // Toggle mute
    const toggleMute = () => {
        if (localStreamRef.current) {
            localStreamRef.current.getAudioTracks().forEach(t => { t.enabled = !t.enabled; });
            setMuted(!muted);
        }
    };

    // Toggle video
    const toggleVideo = () => {
        if (localStreamRef.current) {
            localStreamRef.current.getVideoTracks().forEach(t => { t.enabled = !t.enabled; });
            setVideoOff(!videoOff);
        }
    };

    const formatDuration = (secs) => {
        const m = Math.floor(secs / 60);
        const s = secs % 60;
        return `${m}:${String(s).padStart(2, '0')}`;
    };

    return (
        <div className={`${s.overlay} ${callType === 'video' && status === 'connected' ? s.videoMode : ''}`}>
            {/* Video elements */}
            {callType === 'video' && (
                <>
                    <video ref={remoteVideoRef} className={s.remoteVideo} autoPlay playsInline />
                    <video ref={localVideoRef} className={s.localVideo} autoPlay playsInline muted />
                </>
            )}

            {/* Avatar / info display when not in video mode */}
            {(callType === 'voice' || status !== 'connected') && (
                <div className={s.callInfo}>
                    <div className={`${s.avatarContainer} ${status === 'incoming' || status === 'ringing' ? s.pulsing : ''}`}>
                        <ChatAvatar
                            name={remoteName || 'User'}
                            avatar={remoteAvatar}
                            size="xl"
                        />
                    </div>
                    <h2 className={s.callerName}>{remoteName || 'Unknown'}</h2>
                    <p className={s.callStatus}>
                        {status === 'incoming' && `Incoming ${callType} call...`}
                        {status === 'ringing' && 'Ringing...'}
                        {status === 'connecting' && 'Connecting...'}
                        {status === 'connected' && formatDuration(duration)}
                    </p>
                </div>
            )}

            {/* Connected video overlay info */}
            {callType === 'video' && status === 'connected' && (
                <div className={s.videoOverlayInfo}>
                    <span className={s.videoCallerName}>{remoteName}</span>
                    <span className={s.videoDuration}>{formatDuration(duration)}</span>
                </div>
            )}

            {/* Controls */}
            <div className={s.controls}>
                {status === 'incoming' ? (
                    <>
                        <button className={`${s.controlBtn} ${s.rejectBtn}`} onClick={handleReject} title="Decline">
                            <svg width="24" height="24" viewBox="0 0 24 24" fill="none"><path d="M3.51 5.47a2.5 2.5 0 0 1 3.53 0l1.06 1.06a2.5 2.5 0 0 1 0 3.54l-.53.53a9 9 0 0 0 5.83 5.83l.53-.53a2.5 2.5 0 0 1 3.54 0l1.06 1.06a2.5 2.5 0 0 1 0 3.53l-.87.87a3 3 0 0 1-3.15.73C9.42 20.45 3.55 14.58 1.91 9.49a3 3 0 0 1 .73-3.15l.87-.87z" stroke="currentColor" strokeWidth="2" fill="none" transform="rotate(135 12 12)"/></svg>
                        </button>
                        <button className={`${s.controlBtn} ${s.acceptBtn}`} onClick={handleAccept} title="Accept">
                            <svg width="24" height="24" viewBox="0 0 24 24" fill="none"><path d="M3.51 5.47a2.5 2.5 0 0 1 3.53 0l1.06 1.06a2.5 2.5 0 0 1 0 3.54l-.53.53a9 9 0 0 0 5.83 5.83l.53-.53a2.5 2.5 0 0 1 3.54 0l1.06 1.06a2.5 2.5 0 0 1 0 3.53l-.87.87a3 3 0 0 1-3.15.73C9.42 20.45 3.55 14.58 1.91 9.49a3 3 0 0 1 .73-3.15l.87-.87z" stroke="currentColor" strokeWidth="2" fill="none"/></svg>
                        </button>
                    </>
                ) : (
                    <>
                        <button
                            className={`${s.controlBtn} ${muted ? s.active : ''}`}
                            onClick={toggleMute}
                            title={muted ? 'Unmute' : 'Mute'}
                        >
                            {muted ? (
                                <svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M1 1l22 22M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/><path d="M17 16.95A7 7 0 0 1 5 12m14-1a7 7 0 0 1-.11 1.23M12 19v4m-4 0h8" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
                            ) : (
                                <svg width="20" height="20" viewBox="0 0 24 24" fill="none"><rect x="9" y="1" width="6" height="11" rx="3" stroke="currentColor" strokeWidth="2"/><path d="M5 12a7 7 0 0 0 14 0M12 19v4m-4 0h8" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
                            )}
                        </button>

                        {callType === 'video' && (
                            <button
                                className={`${s.controlBtn} ${videoOff ? s.active : ''}`}
                                onClick={toggleVideo}
                                title={videoOff ? 'Turn on camera' : 'Turn off camera'}
                            >
                                {videoOff ? (
                                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M1 1l22 22M10.66 5H14a2 2 0 0 1 2 2v3.34l1 1L23 7v10" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/><path d="M7 7H4a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h10a2 2 0 0 0 1.73-1" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
                                ) : (
                                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none"><rect x="2" y="7" width="14" height="10" rx="2" stroke="currentColor" strokeWidth="2"/><path d="M16 11l6-4v10l-6-4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
                                )}
                            </button>
                        )}

                        <button className={`${s.controlBtn} ${s.endBtn}`} onClick={handleEnd} title="End call">
                            <svg width="24" height="24" viewBox="0 0 24 24" fill="none"><path d="M3.51 5.47a2.5 2.5 0 0 1 3.53 0l1.06 1.06a2.5 2.5 0 0 1 0 3.54l-.53.53a9 9 0 0 0 5.83 5.83l.53-.53a2.5 2.5 0 0 1 3.54 0l1.06 1.06a2.5 2.5 0 0 1 0 3.53l-.87.87a3 3 0 0 1-3.15.73C9.42 20.45 3.55 14.58 1.91 9.49a3 3 0 0 1 .73-3.15l.87-.87z" stroke="currentColor" strokeWidth="2" fill="none" transform="rotate(135 12 12)"/></svg>
                        </button>
                    </>
                )}
            </div>
        </div>
    );
}

import { useState, useEffect, useRef, useCallback } from 'react';
import { ChatAvatar } from './';
import { searchChatUsers } from '../../api';
import s from './CallOverlay.module.css';

const isElectron = !!window.electronAPI?.isElectron;
const isWinElectron = isElectron && window.electronAPI?.platform !== 'darwin';

const ICE_SERVERS = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
];

/* ── SVG Icon components ── */
const MicIcon = () => <svg width="20" height="20" viewBox="0 0 24 24" fill="none"><rect x="9" y="1" width="6" height="11" rx="3" stroke="currentColor" strokeWidth="2"/><path d="M5 12a7 7 0 0 0 14 0M12 19v4m-4 0h8" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>;
const MicOffIcon = () => <svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M1 1l22 22M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/><path d="M17 16.95A7 7 0 0 1 5 12m14-1a7 7 0 0 1-.11 1.23M12 19v4m-4 0h8" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>;
const CamIcon = () => <svg width="20" height="20" viewBox="0 0 24 24" fill="none"><rect x="2" y="7" width="14" height="10" rx="2" stroke="currentColor" strokeWidth="2"/><path d="M16 11l6-4v10l-6-4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>;
const CamOffIcon = () => <svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M1 1l22 22M10.66 5H14a2 2 0 0 1 2 2v3.34l1 1L23 7v10" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/><path d="M7 7H4a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h10a2 2 0 0 0 1.73-1" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>;
const PhoneIcon = ({ rotate }) => <svg width="24" height="24" viewBox="0 0 24 24" fill="none" style={rotate ? { transform: 'rotate(135deg)' } : undefined}><path d="M3.51 5.47a2.5 2.5 0 0 1 3.53 0l1.06 1.06a2.5 2.5 0 0 1 0 3.54l-.53.53a9 9 0 0 0 5.83 5.83l.53-.53a2.5 2.5 0 0 1 3.54 0l1.06 1.06a2.5 2.5 0 0 1 0 3.53l-.87.87a3 3 0 0 1-3.15.73C9.42 20.45 3.55 14.58 1.91 9.49a3 3 0 0 1 .73-3.15l.87-.87z" stroke="currentColor" strokeWidth="2" fill="none"/></svg>;
const ScreenShareIcon = () => <svg width="20" height="20" viewBox="0 0 24 24" fill="none"><rect x="2" y="3" width="20" height="14" rx="2" stroke="currentColor" strokeWidth="2"/><path d="M8 21h8M12 17v4" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/><path d="M12 7v4m0 0l-2-2m2 2l2-2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>;
const ScreenShareOffIcon = () => <svg width="20" height="20" viewBox="0 0 24 24" fill="none"><rect x="2" y="3" width="20" height="14" rx="2" stroke="currentColor" strokeWidth="2"/><path d="M8 21h8M12 17v4" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/><path d="M2 2l20 20" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>;
const FullscreenIcon = () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>;
const ExitFullscreenIcon = () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M4 14h4v4M20 10h-4V6M14 10h4V6M4 14h4v4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/><path d="M14 10l7-7M3 21l7-7" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>;
const HoldIcon = () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><rect x="6" y="4" width="4" height="16" rx="1" stroke="currentColor" strokeWidth="2"/><rect x="14" y="4" width="4" height="16" rx="1" stroke="currentColor" strokeWidth="2"/></svg>;
const ResumeIcon = () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><polygon points="5,3 19,12 5,21" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" fill="currentColor"/></svg>;
const SwitchCamIcon = () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M16 3h5v5M8 21H3v-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/><path d="M21 3l-7 7M3 21l7-7" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>;
const PipIcon = () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><rect x="2" y="3" width="20" height="14" rx="2" stroke="currentColor" strokeWidth="2"/><rect x="12" y="9" width="8" height="6" rx="1" fill="currentColor" opacity="0.5" stroke="currentColor" strokeWidth="1.5"/><path d="M8 21h8" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>;
/* ── Quality badge (colored dot) ── */
function QualityBadge({ quality }) {
    const color = quality === 'good' ? '#4caf50' : quality === 'fair' ? '#ff9800' : quality === 'poor' ? '#f44336' : '#666';
    const label = quality === 'good' ? 'Good' : quality === 'fair' ? 'Fair' : quality === 'poor' ? 'Poor' : '...';
    return (
        <div className={s.qualityBadge}>
            <span className={s.qualityDot} style={{ background: color }} />
            <span className={s.qualityLabel}>{label}</span>
        </div>
    );
}

/* ── Device selector dropdown ── */
function DeviceSelector({ devices, activeId, onSelect, onClose, label }) {
    return (
        <div className={s.deviceSelector}>
            <div className={s.deviceSelectorHeader}>
                <span>{label}</span>
                <button onClick={onClose} className={s.deviceSelectorClose}>&times;</button>
            </div>
            {devices.map(d => (
                <button
                    key={d.deviceId}
                    className={`${s.deviceOption} ${d.deviceId === activeId ? s.deviceOptionActive : ''}`}
                    onClick={() => { onSelect(d.deviceId); onClose(); }}
                >
                    {d.label || `Device ${d.deviceId.slice(0, 8)}`}
                </button>
            ))}
        </div>
    );
}

export default function CallOverlay({ callState, user, wsSend, onEnd }) {
    const {
        callId, conversationId, callType, isIncoming,
        remoteName, remoteAvatar, isGroup
    } = callState;

    const isReconnect = !!callState.isReconnect;
    const [status, setStatus] = useState(isReconnect ? 'reconnecting' : (isIncoming ? 'incoming' : 'ringing'));
    const [duration, setDuration] = useState(0);

    // Controls state
    const [muted, setMuted] = useState(false);
    const [videoOff, setVideoOff] = useState(false);
    const [screenSharing, setScreenSharing] = useState(false);
    const [onHold, setOnHold] = useState(false);
    const [isFullscreen, setIsFullscreen] = useState(false);
    const [connectionQuality, setConnectionQuality] = useState('unknown');
    const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
    const canScreenShare = typeof navigator.mediaDevices?.getDisplayMedia === 'function';

    // Device switching
    const [audioDevices, setAudioDevices] = useState([]);
    const [videoDevices, setVideoDevices] = useState([]);
    const [activeAudioDevice, setActiveAudioDevice] = useState('');
    const [activeVideoDevice, setActiveVideoDevice] = useState('');
    const [showAudioDevices, setShowAudioDevices] = useState(false);
    const [showVideoDevices, setShowVideoDevices] = useState(false);

    // Add participant
    const [showAddParticipant, setShowAddParticipant] = useState(false);
    const [addPartQuery, setAddPartQuery] = useState('');
    const [addPartResults, setAddPartResults] = useState([]);
    const [addPartSearching, setAddPartSearching] = useState(false);
    const addPartTimerRef = useRef(null);

    // Refs
    const pcRef = useRef(null);
    const localStreamRef = useRef(null);
    const screenStreamRef = useRef(null);
    const remoteStreamRef = useRef(null);
    const localVideoRef = useRef(null);
    const remoteVideoRef = useRef(null);
    const remoteAudioRef = useRef(null);

    const overlayRef = useRef(null);
    const timerRef = useRef(null);
    const ringtoneRef = useRef(null);
    const pendingSignalsRef = useRef([]);
    const statsIntervalRef = useRef(null);
    const screenSenderRef = useRef(null);
    const connectionTimeoutRef = useRef(null);
    const handleEndRef = useRef(null);

    // ─── Connection timeout: auto-end if stuck in ringing/connecting/reconnecting ───
    useEffect(() => {
        if (status === 'ringing' || status === 'connecting' || status === 'reconnecting') {
            connectionTimeoutRef.current = setTimeout(() => {
                if (handleEndRef.current) handleEndRef.current();
            }, status === 'ringing' ? 60000 : 30000); // 60s for ringing, 30s for connecting/reconnecting
        }
        return () => clearTimeout(connectionTimeoutRef.current);
    }, [status]);

    // ─── Duration timer ───
    useEffect(() => {
        if (status === 'connected') {
            timerRef.current = setInterval(() => setDuration(d => d + 1), 1000);
        }
        return () => clearInterval(timerRef.current);
    }, [status]);

    // ─── Connection quality monitor (like VideoSDK's NetworkStats) ───
    useEffect(() => {
        if (status === 'connected' && pcRef.current) {
            statsIntervalRef.current = setInterval(async () => {
                try {
                    const stats = await pcRef.current.getStats();
                    let rtt = null, packetsLost = 0, packetsReceived = 0;
                    stats.forEach(report => {
                        if (report.type === 'candidate-pair' && report.state === 'succeeded') {
                            rtt = report.currentRoundTripTime;
                        }
                        if (report.type === 'inbound-rtp' && report.kind === 'audio') {
                            packetsLost = report.packetsLost || 0;
                            packetsReceived = report.packetsReceived || 0;
                        }
                    });
                    const lossRate = packetsReceived > 0 ? packetsLost / (packetsLost + packetsReceived) : 0;
                    if (rtt !== null && rtt < 0.15 && lossRate < 0.02) setConnectionQuality('good');
                    else if (rtt !== null && rtt < 0.4 && lossRate < 0.05) setConnectionQuality('fair');
                    else if (rtt !== null) setConnectionQuality('poor');
                } catch { /* stats unavailable */ }
            }, 3000);
        }
        return () => clearInterval(statsIntervalRef.current);
    }, [status]);

    // ─── Enumerate devices ───
    useEffect(() => {
        async function loadDevices() {
            try {
                const devices = await navigator.mediaDevices.enumerateDevices();
                setAudioDevices(devices.filter(d => d.kind === 'audioinput'));
                setVideoDevices(devices.filter(d => d.kind === 'videoinput'));
            } catch { /* ignore */ }
        }
        loadDevices();
        navigator.mediaDevices?.addEventListener?.('devicechange', loadDevices);
        return () => navigator.mediaDevices?.removeEventListener?.('devicechange', loadDevices);
    }, []);

    // ─── Track active device IDs ───
    useEffect(() => {
        if (localStreamRef.current) {
            const at = localStreamRef.current.getAudioTracks()[0];
            const vt = localStreamRef.current.getVideoTracks()[0];
            if (at) setActiveAudioDevice(at.getSettings().deviceId || '');
            if (vt) setActiveVideoDevice(vt.getSettings().deviceId || '');
        }
    }, [status]);

    // ─── Fullscreen listener ───
    useEffect(() => {
        const handler = () => setIsFullscreen(!!document.fullscreenElement);
        document.addEventListener('fullscreenchange', handler);
        return () => document.removeEventListener('fullscreenchange', handler);
    }, []);

    // ─── Ringtone ───
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
                try { ringtoneRef.current.osc.stop(); ringtoneRef.current.ctx.close(); } catch {}
                ringtoneRef.current = null;
            }
        };
    }, [status]);

    const stopRingtone = useCallback(() => {
        if (ringtoneRef.current) {
            try { ringtoneRef.current.osc.stop(); ringtoneRef.current.ctx.close(); } catch {}
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
                remoteAudioRef.current.play().catch(() => {});
            }
            if (remoteVideoRef.current) {
                remoteVideoRef.current.srcObject = remoteStream;
                // On mobile, mute video element audio to prevent loudspeaker bypass;
                // audio routes through the <audio> element for earpiece control
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
                initialNegotiationDone = true;
                setStatus('connected');
                stopRingtone();
            } else if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
                handleEnd();
            }
        };

        return pc;
    }, [conversationId, wsSend, stopRingtone]);

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
            try { await pcRef.current.addIceCandidate(new RTCIceCandidate(signal.candidate)); } catch {}
        }
    }, [conversationId, wsSend]);

    const handleSignal = useCallback((signal, fromUserId) => {
        // During reconnect, create PC on first offer received
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

    useEffect(() => {
        if (callState.onSignal) callState.onSignal.current = handleSignal;
    }, [handleSignal, callState.onSignal]);

    // ─── Outgoing call: use pre-acquired stream ───
    useEffect(() => {
        if (!isIncoming && !isReconnect && callState.localStream && !localStreamRef.current) {
            localStreamRef.current = callState.localStream;
            if (localVideoRef.current && callType === 'video') {
                localVideoRef.current.srcObject = callState.localStream;
            }
        }
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    // ─── Reconnect: acquire media and wait for peer to re-offer ───
    useEffect(() => {
        if (!isReconnect) return;
        (async () => {
            const stream = await startMedia();
            if (!stream) { handleEnd(); return; }
            // PC will be created when we receive a signal (offer) from the other peer
            setStatus('reconnecting');
        })();
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    // ─── Handle reconnectTo: other peer refreshed, we need to re-offer ───
    useEffect(() => {
        if (!callState.reconnectTo) return;
        const targetUserId = callState.reconnectTo;
        (async () => {
            // Close old PC if exists
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
    }, [callState.reconnectTo]); // eslint-disable-line react-hooks/exhaustive-deps

    // ─── Accept incoming call ───
    const handleAccept = useCallback(async () => {
        setStatus('connecting');
        stopRingtone();
        const stream = await startMedia();
        if (!stream) { handleEnd(); return; }
        createPeerConnection(stream, callState.callerId);
        flushPendingSignals();
        wsSend('call_accept', { callId, conversationId });
    }, [callId, conversationId, wsSend, startMedia, createPeerConnection, callState.callerId, stopRingtone, flushPendingSignals]);

    // ─── Caller side: create offer once accepted ───
    useEffect(() => {
        if (callState.accepted && !isIncoming) {
            (async () => {
                setStatus('connecting');
                stopRingtone();
                const stream = localStreamRef.current;
                if (!stream) { handleEnd(); return; }
                const pc = createPeerConnection(stream, callState.acceptedBy);
                flushPendingSignals();
                const offer = await pc.createOffer();
                await pc.setLocalDescription(offer);
                wsSend('call_signal', {
                    conversationId, targetUserId: callState.acceptedBy,
                    signal: { type: 'offer', sdp: offer.sdp }
                });
            })();
        }
    }, [callState.accepted, callState.acceptedBy]);

    const handleReject = useCallback(() => {
        stopRingtone();
        wsSend('call_reject', { callId, conversationId });
        cleanup();
        onEnd();
    }, [callId, conversationId, wsSend, onEnd, stopRingtone]);

    const handleEnd = useCallback(() => {
        stopRingtone();
        wsSend('call_end', { callId, conversationId });
        cleanup();
        onEnd();
    }, [callId, conversationId, wsSend, onEnd, stopRingtone]);

    handleEndRef.current = handleEnd;

    useEffect(() => {
        if (callState.onEndExternal) callState.onEndExternal.current = () => {
            stopRingtone();
            cleanup();
            onEnd();
        };
    }, [onEnd, stopRingtone]);

    const cleanup = () => {
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
        clearInterval(timerRef.current);
        clearInterval(statsIntervalRef.current);
        clearTimeout(addPartTimerRef.current);
        clearTimeout(connectionTimeoutRef.current);
        if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    };

    useEffect(() => cleanup, []);

    // ═══════════════════════════════════
    //  FEATURE: Toggle Mute
    // ═══════════════════════════════════
    const toggleMute = () => {
        if (localStreamRef.current) {
            localStreamRef.current.getAudioTracks().forEach(t => { t.enabled = !t.enabled; });
            setMuted(!muted);
        }
    };

    // ═══════════════════════════════════
    //  FEATURE: Toggle Video
    // ═══════════════════════════════════
    const toggleVideo = () => {
        if (localStreamRef.current) {
            localStreamRef.current.getVideoTracks().forEach(t => { t.enabled = !t.enabled; });
            setVideoOff(!videoOff);
        }
    };

    // ═══════════════════════════════════
    //  FEATURE: Screen Share
    // ═══════════════════════════════════
    const toggleScreenShare = async () => {
        if (!pcRef.current) return;

        if (screenSharing) {
            // Stop screen share → revert to camera (or remove video track for audio calls)
            if (screenStreamRef.current) {
                screenStreamRef.current.getTracks().forEach(t => t.stop());
                screenStreamRef.current = null;
            }
            const camTrack = localStreamRef.current?.getVideoTracks()[0];
            if (camTrack && screenSenderRef.current) {
                await screenSenderRef.current.replaceTrack(camTrack);
            } else if (screenSenderRef.current && !camTrack) {
                // Audio-only call: remove the screen share track we added
                pcRef.current.removeTrack(screenSenderRef.current);
                screenSenderRef.current = null;
            }
            if (localVideoRef.current && localStreamRef.current) {
                localVideoRef.current.srcObject = localStreamRef.current;
            }
            setScreenSharing(false);
        } else {
            try {
                const screenStream = await navigator.mediaDevices.getDisplayMedia({
                    video: { cursor: 'always' }, audio: false
                });
                screenStreamRef.current = screenStream;
                const screenTrack = screenStream.getVideoTracks()[0];

                if (screenSenderRef.current) {
                    // Video call: replace camera track with screen track
                    await screenSenderRef.current.replaceTrack(screenTrack);
                } else {
                    // Audio-only call: add screen track as a new video sender
                    const sender = pcRef.current.addTrack(screenTrack, screenStream);
                    screenSenderRef.current = sender;
                }

                // Show screen share in local preview
                if (localVideoRef.current) {
                    localVideoRef.current.srcObject = screenStream;
                }

                // Handle user clicking "Stop sharing" in browser UI
                screenTrack.onended = () => {
                    toggleScreenShare();
                };

                setScreenSharing(true);
            } catch (err) {
                console.error('Screen share failed:', err);
            }
        }
    };

    // ═══════════════════════════════════
    //  FEATURE: Hold / Resume
    // ═══════════════════════════════════
    const toggleHold = () => {
        if (!localStreamRef.current) return;
        const hold = !onHold;
        localStreamRef.current.getTracks().forEach(t => { t.enabled = !hold; });
        setOnHold(hold);
        if (hold) { setMuted(true); setVideoOff(true); }
        else { setMuted(false); setVideoOff(false); }
    };

    // ═══════════════════════════════════
    //  FEATURE: Fullscreen
    // ═══════════════════════════════════
    const toggleFullscreen = async () => {
        try {
            if (!document.fullscreenElement) {
                await overlayRef.current?.requestFullscreen();
            } else {
                await document.exitFullscreen();
            }
        } catch { /* fullscreen not supported */ }
    };

    // ═══════════════════════════════════
    //  FEATURE: Picture-in-Picture (remote video)
    // ═══════════════════════════════════
    const togglePiP = async () => {
        try {
            if (document.pictureInPictureElement) {
                await document.exitPictureInPicture();
            } else if (remoteVideoRef.current) {
                await remoteVideoRef.current.requestPictureInPicture();
            }
        } catch { /* PiP not supported */ }
    };

    // ═══════════════════════════════════
    //  FEATURE: Switch Mic / Camera
    // ═══════════════════════════════════
    const switchAudioDevice = async (deviceId) => {
        try {
            const newStream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: deviceId } } });
            const newTrack = newStream.getAudioTracks()[0];
            const oldTrack = localStreamRef.current?.getAudioTracks()[0];

            // Replace in peer connection
            const sender = pcRef.current?.getSenders().find(s => s.track?.kind === 'audio');
            if (sender) await sender.replaceTrack(newTrack);

            // Replace in local stream
            if (oldTrack) { localStreamRef.current.removeTrack(oldTrack); oldTrack.stop(); }
            localStreamRef.current?.addTrack(newTrack);
            setActiveAudioDevice(deviceId);
        } catch (err) { console.error('Switch mic failed:', err); }
    };

    const switchVideoDevice = async (deviceId) => {
        try {
            const newStream = await navigator.mediaDevices.getUserMedia({
                video: { deviceId: { exact: deviceId }, width: 1280, height: 720 }
            });
            const newTrack = newStream.getVideoTracks()[0];
            const oldTrack = localStreamRef.current?.getVideoTracks()[0];

            if (screenSenderRef.current && !screenSharing) {
                await screenSenderRef.current.replaceTrack(newTrack);
            }

            if (oldTrack) { localStreamRef.current.removeTrack(oldTrack); oldTrack.stop(); }
            localStreamRef.current?.addTrack(newTrack);
            if (localVideoRef.current) localVideoRef.current.srcObject = localStreamRef.current;
            setActiveVideoDevice(deviceId);
        } catch (err) { console.error('Switch camera failed:', err); }
    };

    // ─── Helpers ───
    const formatDuration = (secs) => {
        const m = Math.floor(secs / 60);
        const sec = secs % 60;
        return `${m}:${String(sec).padStart(2, '0')}`;
    };

    const isConnected = status === 'connected';
    const isVideoCall = callType === 'video';

    // ─── Add Participant search handler ───
    const handleAddPartSearch = (val) => {
        setAddPartQuery(val);
        clearTimeout(addPartTimerRef.current);
        if (val.trim().length < 2) { setAddPartResults([]); return; }
        addPartTimerRef.current = setTimeout(async () => {
            setAddPartSearching(true);
            try {
                const r = await searchChatUsers(val.trim());
                setAddPartResults(r.data || []);
            } catch { setAddPartResults([]); }
            finally { setAddPartSearching(false); }
        }, 300);
    };

    const handleAddPartInvite = (targetUserId) => {
        wsSend('call_add_participant', { callId, conversationId, targetUserId });
        setShowAddParticipant(false);
        setAddPartQuery('');
        setAddPartResults([]);
    };
    return (
        <div
            ref={overlayRef}
            className={`${s.overlay} ${(isVideoCall || screenSharing) && isConnected ? s.videoMode : ''} ${onHold ? s.holdMode : ''}`}
        >
            {/* Window controls for frameless Electron window */}
            {isWinElectron && (
                <div className={s.windowControls}>
                    <button className={s.winBtn} onClick={() => window.electronAPI.minimize()} title="Minimize">
                        <svg width="12" height="12" viewBox="0 0 12 12"><rect x="1" y="5.5" width="10" height="1" fill="currentColor"/></svg>
                    </button>
                    <button className={s.winBtn} onClick={() => window.electronAPI.maximize()} title="Maximize">
                        <svg width="12" height="12" viewBox="0 0 12 12"><rect x="0.5" y="0.5" width="11" height="11" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1"/></svg>
                    </button>
                    <button className={`${s.winBtn} ${s.winCloseBtn}`} onClick={() => window.electronAPI.close()} title="Close">
                        <svg width="12" height="12" viewBox="0 0 12 12"><path d="M1 1l10 10M11 1L1 11" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/></svg>
                    </button>
                </div>
            )}

            {/* Audio element for remote stream */}
            <audio ref={remoteAudioRef} autoPlay />

            {/* Video elements */}
            {(isVideoCall || screenSharing) && (
                <>
                    <video ref={remoteVideoRef} className={s.remoteVideo} autoPlay playsInline />
                    <video ref={localVideoRef} className={s.localVideo} autoPlay playsInline muted />
                </>
            )}

            {/* Connection quality badge (top-right) */}
            {isConnected && (
                <div className={s.topBar}>
                    <QualityBadge quality={connectionQuality} />
                    {screenSharing && <span className={s.sharingBadge}>Screen Sharing</span>}
                    {onHold && <span className={s.holdBadge}>On Hold</span>}
                </div>
            )}

            {/* Avatar / info */}
            {(!isVideoCall || !isConnected || onHold || status === 'reconnecting') && (
                <div className={s.callInfo}>
                    <div className={`${s.avatarContainer} ${status === 'incoming' || status === 'ringing' ? s.pulsing : ''}`}>
                        <ChatAvatar name={remoteName || 'User'} avatar={remoteAvatar} size="xl" />
                    </div>
                    <h2 className={s.callerName}>{remoteName || 'Unknown'}</h2>
                    <p className={s.callStatus}>
                        {status === 'incoming' && `Incoming ${callType} call...`}
                        {status === 'ringing' && 'Ringing...'}
                        {status === 'connecting' && 'Connecting...'}
                        {status === 'reconnecting' && 'Reconnecting...'}
                        {isConnected && !onHold && formatDuration(duration)}
                        {isConnected && onHold && `On Hold · ${formatDuration(duration)}`}
                    </p>
                </div>
            )}

            {/* Video overlay info */}
            {isVideoCall && isConnected && !onHold && (
                <div className={s.videoOverlayInfo}>
                    <span className={s.videoCallerName}>{remoteName}</span>
                    <span className={s.videoDuration}>{formatDuration(duration)}</span>
                </div>
            )}

            {/* Device selectors */}
            {showAudioDevices && audioDevices.length > 0 && (
                <DeviceSelector
                    devices={audioDevices}
                    activeId={activeAudioDevice}
                    onSelect={switchAudioDevice}
                    onClose={() => setShowAudioDevices(false)}
                    label="Select Microphone"
                />
            )}
            {showVideoDevices && videoDevices.length > 0 && (
                <DeviceSelector
                    devices={videoDevices}
                    activeId={activeVideoDevice}
                    onSelect={switchVideoDevice}
                    onClose={() => setShowVideoDevices(false)}
                    label="Select Camera"
                />
            )}

            {/* ─── Add Participant popup ─── */}
            {showAddParticipant && (
                <div className={s.addPartPopup}>
                    <div className={s.addPartHeader}>
                        <span>Add to call</span>
                        <button className={s.addPartClose} onClick={() => { setShowAddParticipant(false); setAddPartQuery(''); setAddPartResults([]); }}>×</button>
                    </div>
                    <input
                        className={s.addPartInput}
                        value={addPartQuery}
                        onChange={e => handleAddPartSearch(e.target.value)}
                        placeholder="Search people…"
                        autoFocus
                    />
                    {addPartSearching && <div className={s.addPartLoading}>Searching…</div>}
                    {addPartResults.length > 0 && (
                        <ul className={s.addPartResults}>
                            {addPartResults.map(u => (
                                <li key={u.id} className={s.addPartResult} onClick={() => handleAddPartInvite(u.id)}>
                                    {u.name || u.full_name || u.username}
                                    {u.email && <span className={s.addPartEmail}>{u.email}</span>}
                                </li>
                            ))}
                        </ul>
                    )}
                    {addPartQuery.trim().length >= 2 && !addPartSearching && addPartResults.length === 0 && (
                        <div className={s.addPartLoading}>No results found</div>
                    )}
                </div>
            )}

            {/* ─── Controls ─── */}
            <div className={s.controls}>
                {status === 'incoming' ? (
                    <>
                        <button className={`${s.controlBtn} ${s.rejectBtn}`} onClick={handleReject} title="Decline">
                            <PhoneIcon rotate />
                        </button>
                        <button className={`${s.controlBtn} ${s.acceptBtn}`} onClick={handleAccept} title="Accept">
                            <PhoneIcon />
                        </button>
                    </>
                ) : (
                    <>
                        {/* Mute with long-press for device picker */}
                        <div className={s.controlGroup}>
                            <button
                                className={`${s.controlBtn} ${muted ? s.active : ''}`}
                                onClick={toggleMute}
                                title={muted ? 'Unmute' : 'Mute'}
                            >
                                {muted ? <MicOffIcon /> : <MicIcon />}
                            </button>
                            {isConnected && audioDevices.length > 1 && (
                                <button
                                    className={s.deviceToggle}
                                    onClick={() => { setShowAudioDevices(!showAudioDevices); setShowVideoDevices(false); }}
                                    title="Switch microphone"
                                >▴</button>
                            )}
                        </div>

                        {/* Camera toggle with device picker */}
                        {isVideoCall && (
                            <div className={s.controlGroup}>
                                <button
                                    className={`${s.controlBtn} ${videoOff ? s.active : ''}`}
                                    onClick={toggleVideo}
                                    title={videoOff ? 'Turn on camera' : 'Turn off camera'}
                                >
                                    {videoOff ? <CamOffIcon /> : <CamIcon />}
                                </button>
                                {isConnected && videoDevices.length > 1 && (
                                    <button
                                        className={s.deviceToggle}
                                        onClick={() => { setShowVideoDevices(!showVideoDevices); setShowAudioDevices(false); }}
                                        title="Switch camera"
                                    >▴</button>
                                )}
                            </div>
                        )}

                        {/* Screen share (available for all call types when connected) */}
                        {isConnected && canScreenShare && (
                            <button
                                className={`${s.controlBtn} ${screenSharing ? s.active : ''}`}
                                onClick={toggleScreenShare}
                                title={screenSharing ? 'Stop sharing' : 'Share screen'}
                            >
                                {screenSharing ? <ScreenShareOffIcon /> : <ScreenShareIcon />}
                            </button>
                        )}

                        {/* Hold / Resume */}
                        {isConnected && (
                            <button
                                className={`${s.controlBtn} ${onHold ? s.holdActive : ''}`}
                                onClick={toggleHold}
                                title={onHold ? 'Resume' : 'Hold'}
                            >
                                {onHold ? <ResumeIcon /> : <HoldIcon />}
                            </button>
                        )}

                        {/* Fullscreen */}
                        {isConnected && (
                            <button
                                className={s.controlBtn}
                                onClick={toggleFullscreen}
                                title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
                            >
                                {isFullscreen ? <ExitFullscreenIcon /> : <FullscreenIcon />}
                            </button>
                        )}

                        {/* PiP (video calls only) */}
                        {isVideoCall && isConnected && document.pictureInPictureEnabled && (
                            <button
                                className={s.controlBtn}
                                onClick={togglePiP}
                                title="Picture-in-Picture"
                            >
                                <PipIcon />
                            </button>
                        )}

                        {/* Add Participant */}
                        {isConnected && (
                            <button
                                className={`${s.controlBtn} ${showAddParticipant ? s.active : ''}`}
                                onClick={() => setShowAddParticipant(v => !v)}
                                title="Add participant"
                            >
                                <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M16 11c1.66 0 3-1.34 3-3s-1.34-3-3-3M20 20c0-2.21-1.79-4-4-4M12 12c2.21 0 4-1.79 4-4S14.21 4 12 4 8 5.79 8 8s1.79 4 4 4M4 20c0-2.21 1.79-4 4-4h8c2.21 0 4 1.79 4 4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/><path d="M19 8h4M21 6v4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/></svg>
                            </button>
                        )}

                        {/* End call */}
                        <button className={`${s.controlBtn} ${s.endBtn}`} onClick={handleEnd} title="End call">
                            <PhoneIcon rotate />
                        </button>
                    </>
                )}
            </div>
        </div>
    );
}

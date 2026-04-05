import { useState, useEffect, useRef, useCallback } from 'react';
import { ChatAvatar } from '../';
import useWebRTC from './useWebRTC';
import useCallControls from './useCallControls';
import { QualityBadge, DeviceSelector } from './CallWidgets';
import { AddParticipantPopup } from './AddParticipantPopup';
import {
    MicIcon, MicOffIcon, CamIcon, CamOffIcon, PhoneIcon,
    ScreenShareIcon, ScreenShareOffIcon, FullscreenIcon, ExitFullscreenIcon,
    HoldIcon, ResumeIcon, PipIcon, AddParticipantIcon
} from './CallIcons';
import s from '../CallOverlay.module.css';

export default function CallOverlay({ callState, user, wsSend, onEnd }) {
    const { callId, conversationId, callType, isIncoming, remoteName, remoteAvatar } = callState;

    const isReconnect = !!callState.isReconnect;
    const [status, setStatus] = useState(isReconnect ? 'reconnecting' : (isIncoming ? 'incoming' : 'ringing'));
    const [duration, setDuration] = useState(0);
    const [showAddParticipant, setShowAddParticipant] = useState(false);

    const overlayRef = useRef(null);
    const timerRef = useRef(null);
    const handleEndRef = useRef(null);

    const webrtc = useWebRTC({
        callState, callType, wsSend, onEnd,
        onStatusChange: setStatus
    });

    const controls = useCallControls({
        localStreamRef: webrtc.localStreamRef,
        pcRef: webrtc.pcRef,
        screenStreamRef: webrtc.screenStreamRef,
        screenSenderRef: webrtc.screenSenderRef,
        localVideoRef: webrtc.localVideoRef,
        remoteVideoRef: webrtc.remoteVideoRef,
        overlayRef
    });

    // ─── Connection timeout ───
    useEffect(() => {
        if (status === 'ringing' || status === 'connecting' || status === 'reconnecting') {
            webrtc.connectionTimeoutRef.current = setTimeout(() => {
                if (handleEndRef.current) handleEndRef.current();
            }, status === 'ringing' ? 60000 : 30000);
        }
        return () => clearTimeout(webrtc.connectionTimeoutRef.current);
    }, [status]);

    handleEndRef.current = webrtc.handleEnd;

    // ─── Duration timer ───
    useEffect(() => {
        if (status === 'connected') {
            timerRef.current = setInterval(() => setDuration(d => d + 1), 1000);
        }
        return () => clearInterval(timerRef.current);
    }, [status]);

    // ─── Connection quality monitor ───
    useEffect(() => {
        if (status === 'connected' && webrtc.pcRef.current) {
            const interval = controls.startQualityMonitor(webrtc.pcRef.current);
            return () => clearInterval(interval);
        }
    }, [status]);

    // ─── Track active device IDs ───
    useEffect(() => {
        if (webrtc.localStreamRef.current) {
            const at = webrtc.localStreamRef.current.getAudioTracks()[0];
            const vt = webrtc.localStreamRef.current.getVideoTracks()[0];
            if (at) controls.switchAudioDevice && void 0;
            if (vt) controls.switchVideoDevice && void 0;
        }
    }, [status]);

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
                webrtc.ringtoneRef.current = { ctx, osc, gain };
                const pulse = () => {
                    if (!webrtc.ringtoneRef.current) return;
                    gain.gain.setValueAtTime(0.1, ctx.currentTime);
                    gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.5);
                    setTimeout(pulse, 1000);
                };
                pulse();
            } catch { /* audio not available */ }
        }
        return () => webrtc.stopRingtone();
    }, [status]);

    // ─── Cleanup timer on unmount ───
    useEffect(() => () => clearInterval(timerRef.current), []);

    const formatDuration = (secs) => {
        const m = Math.floor(secs / 60);
        const sec = secs % 60;
        return `${m}:${String(sec).padStart(2, '0')}`;
    };

    const isConnected = status === 'connected';
    const isVideoCall = callType === 'video';

    return (
        <div
            ref={overlayRef}
            className={`${s.overlay} ${isVideoCall && isConnected ? s.videoMode : ''} ${controls.onHold ? s.holdMode : ''}`}
        >
            <audio ref={webrtc.remoteAudioRef} autoPlay />

            {isVideoCall && (
                <>
                    <video ref={webrtc.remoteVideoRef} className={s.remoteVideo} autoPlay playsInline />
                    <video ref={webrtc.localVideoRef} className={s.localVideo} autoPlay playsInline muted />
                </>
            )}

            {isConnected && (
                <div className={s.topBar}>
                    <QualityBadge quality={controls.connectionQuality} />
                    {controls.screenSharing && <span className={s.sharingBadge}>Screen Sharing</span>}
                    {controls.onHold && <span className={s.holdBadge}>On Hold</span>}
                </div>
            )}

            {(!isVideoCall || !isConnected || controls.onHold || status === 'reconnecting') && (
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
                        {isConnected && !controls.onHold && formatDuration(duration)}
                        {isConnected && controls.onHold && `On Hold · ${formatDuration(duration)}`}
                    </p>
                </div>
            )}

            {isVideoCall && isConnected && !controls.onHold && (
                <div className={s.videoOverlayInfo}>
                    <span className={s.videoCallerName}>{remoteName}</span>
                    <span className={s.videoDuration}>{formatDuration(duration)}</span>
                </div>
            )}

            {controls.showAudioDevices && controls.audioDevices.length > 0 && (
                <DeviceSelector
                    devices={controls.audioDevices}
                    activeId={controls.activeAudioDevice}
                    onSelect={controls.switchAudioDevice}
                    onClose={() => controls.setShowAudioDevices(false)}
                    label="Select Microphone"
                />
            )}
            {controls.showVideoDevices && controls.videoDevices.length > 0 && (
                <DeviceSelector
                    devices={controls.videoDevices}
                    activeId={controls.activeVideoDevice}
                    onSelect={controls.switchVideoDevice}
                    onClose={() => controls.setShowVideoDevices(false)}
                    label="Select Camera"
                />
            )}

            {showAddParticipant && (
                <AddParticipantPopup
                    callId={callId}
                    conversationId={conversationId}
                    wsSend={wsSend}
                    onClose={() => setShowAddParticipant(false)}
                />
            )}

            <div className={s.controls}>
                {status === 'incoming' ? (
                    <>
                        <button className={`${s.controlBtn} ${s.rejectBtn}`} onClick={webrtc.handleReject} title="Decline">
                            <PhoneIcon rotate />
                        </button>
                        <button className={`${s.controlBtn} ${s.acceptBtn}`} onClick={webrtc.handleAccept} title="Accept">
                            <PhoneIcon />
                        </button>
                    </>
                ) : (
                    <>
                        <div className={s.controlGroup}>
                            <button
                                className={`${s.controlBtn} ${controls.muted ? s.active : ''}`}
                                onClick={controls.toggleMute}
                                title={controls.muted ? 'Unmute' : 'Mute'}
                            >
                                {controls.muted ? <MicOffIcon /> : <MicIcon />}
                            </button>
                            {isConnected && controls.audioDevices.length > 1 && (
                                <button
                                    className={s.deviceToggle}
                                    onClick={() => { controls.setShowAudioDevices(!controls.showAudioDevices); controls.setShowVideoDevices(false); }}
                                    title="Switch microphone"
                                >▴</button>
                            )}
                        </div>

                        {isVideoCall && (
                            <div className={s.controlGroup}>
                                <button
                                    className={`${s.controlBtn} ${controls.videoOff ? s.active : ''}`}
                                    onClick={controls.toggleVideo}
                                    title={controls.videoOff ? 'Turn on camera' : 'Turn off camera'}
                                >
                                    {controls.videoOff ? <CamOffIcon /> : <CamIcon />}
                                </button>
                                {isConnected && controls.videoDevices.length > 1 && (
                                    <button
                                        className={s.deviceToggle}
                                        onClick={() => { controls.setShowVideoDevices(!controls.showVideoDevices); controls.setShowAudioDevices(false); }}
                                        title="Switch camera"
                                    >▴</button>
                                )}
                            </div>
                        )}

                        {isConnected && (
                            <button
                                className={`${s.controlBtn} ${controls.screenSharing ? s.active : ''}`}
                                onClick={controls.toggleScreenShare}
                                title={controls.screenSharing ? 'Stop sharing' : 'Share screen'}
                            >
                                {controls.screenSharing ? <ScreenShareOffIcon /> : <ScreenShareIcon />}
                            </button>
                        )}

                        {isConnected && (
                            <button
                                className={`${s.controlBtn} ${controls.onHold ? s.holdActive : ''}`}
                                onClick={controls.toggleHold}
                                title={controls.onHold ? 'Resume' : 'Hold'}
                            >
                                {controls.onHold ? <ResumeIcon /> : <HoldIcon />}
                            </button>
                        )}

                        {isConnected && (
                            <button
                                className={s.controlBtn}
                                onClick={controls.toggleFullscreen}
                                title={controls.isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
                            >
                                {controls.isFullscreen ? <ExitFullscreenIcon /> : <FullscreenIcon />}
                            </button>
                        )}

                        {isVideoCall && isConnected && document.pictureInPictureEnabled && (
                            <button className={s.controlBtn} onClick={controls.togglePiP} title="Picture-in-Picture">
                                <PipIcon />
                            </button>
                        )}

                        {isConnected && (
                            <button
                                className={`${s.controlBtn} ${showAddParticipant ? s.active : ''}`}
                                onClick={() => setShowAddParticipant(v => !v)}
                                title="Add participant"
                            >
                                <AddParticipantIcon />
                            </button>
                        )}

                        <button className={`${s.controlBtn} ${s.endBtn}`} onClick={webrtc.handleEnd} title="End call">
                            <PhoneIcon rotate />
                        </button>
                    </>
                )}
            </div>
        </div>
    );
}

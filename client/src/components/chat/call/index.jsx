import { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { ChatAvatar } from '../';
import useWebRTC from './useWebRTC';
import useCallControls from './useCallControls';
import { QualityBadge, DeviceSelector } from './CallWidgets';
import { AddParticipantPopup } from './AddParticipantPopup';
import CallChatPanel from './CallChatPanel';
import { useNotificationPrefs } from '../../../NotificationPrefsContext';
import {
    MicIcon, MicOffIcon, CamIcon, CamOffIcon, PhoneIcon,
    ScreenShareIcon, ScreenShareOffIcon, FullscreenIcon, ExitFullscreenIcon,
    HoldIcon, ResumeIcon, PipIcon, AddParticipantIcon, ChatIcon
} from './CallIcons';
import s from '../CallOverlay.module.css';

const isElectron = !!window.electronAPI?.isElectron;
const isWinElectron = isElectron && window.electronAPI?.platform !== 'darwin';

// Minimize / Maximize icons (kept inline so we don't add new icon deps)
const MinimizeIcon = () => (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
        <path d="M5 14h6v6M19 10h-6V4M14 10l7-7M10 14l-7 7"
            stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
);
const MaximizeIcon = () => (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
        <path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"
            stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
);

export default function CallOverlay({
    callState, user, wsSend, onEnd,
    chatMessages = [], onSendChat, onSendChatFile,
}) {
    const { callId, conversationId, callType, isIncoming, remoteName, remoteAvatar, isGroup } = callState;

    // "Add participant" only works in group-call conversations. A 1:1 call is
    // a single WebRTC peer connection with no mesh/SFU support, so a 3rd
    // person can never actually join. Worse, the server's previous behaviour
    // permanently added the 3rd user to `conversation_participants`, turning
    // the chat into a 3-person group and auto-ringing them on the next call.
    // For n-way calls users should start a Meeting instead.
    const canAddParticipant = !!isGroup;

    const isReconnect = !!callState.isReconnect;
    const [status, setStatus] = useState(isReconnect ? 'reconnecting' : (isIncoming ? 'incoming' : 'ringing'));
    const [duration, setDuration] = useState(0);
    const [showAddParticipant, setShowAddParticipant] = useState(false);
    const [showChat, setShowChat] = useState(false);
    const [chatUnread, setChatUnread] = useState(0);
    const [swapped, setSwapped] = useState(false);
    // Minimized = small floating PiP-like widget so the user can keep working
    // (notes / chat / dashboard / tasks / calendar / attendance / settings).
    // The overlay JSX stays in the DOM (so the WebRTC peer connection, video
    // elements, mic capture, etc. all keep running) — we just shrink it via
    // a CSS class and hide most chrome.
    const [minimized, setMinimized] = useState(false);
    const canScreenShare = typeof navigator.mediaDevices?.getDisplayMedia === 'function';
    const lastSeenMsgCountRef = useRef(chatMessages.length);

    const { playRingtone, playOutgoing } = useNotificationPrefs();

    const overlayRef = useRef(null);
    const timerRef = useRef(null);
    const handleEndRef = useRef(null);
    const stopRingtoneRef = useRef(null);

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

    // ─── Ringtone / outgoing tone ───
    // Uses the user-selected preset / volume / mute toggle from
    // NotificationPrefsContext (Profile menu → Notification Sounds).
    //   • status === 'incoming' → incoming-call ringtone
    //   • status === 'ringing'  → outgoing dial ring-back tone
    useEffect(() => {
        let stop = null;
        if (status === 'incoming') {
            stop = playRingtone();
        } else if (status === 'ringing') {
            stop = playOutgoing();
        }
        stopRingtoneRef.current = stop;
        return () => {
            if (stopRingtoneRef.current) {
                try { stopRingtoneRef.current(); } catch { /* ignore */ }
                stopRingtoneRef.current = null;
            }
            // Also clear any legacy ringtone left on the webrtc ref so older
            // code paths that still call stopRingtone() are a no-op.
            try { webrtc.stopRingtone(); } catch { /* ignore */ }
        };
    }, [status, playRingtone, playOutgoing]);

    // ─── Cleanup timer on unmount ───
    useEffect(() => () => clearInterval(timerRef.current), []);

    const formatDuration = (secs) => {
        const m = Math.floor(secs / 60);
        const sec = secs % 60;
        return `${m}:${String(sec).padStart(2, '0')}`;
    };

    // Reset swap when call reconnects
    useEffect(() => {
        setSwapped(false);
    }, [status]);

    const isConnected = status === 'connected';
    const isVideoCall = callType === 'video';

    // ─── Track unread chat messages while the panel is closed ───
    useEffect(() => {
        if (showChat) {
            // Mark all current messages as seen when the panel is open
            lastSeenMsgCountRef.current = chatMessages.length;
            setChatUnread(0);
            return;
        }
        const delta = chatMessages.length - lastSeenMsgCountRef.current;
        if (delta <= 0) {
            // Either no new messages, or messages were removed/replaced.
            lastSeenMsgCountRef.current = chatMessages.length;
            return;
        }
        // Count only NEW messages from other users (skip our own echoes)
        const newMsgs = chatMessages.slice(-delta);
        const fromOthers = newMsgs.filter(m => m.sender_id !== user?.id).length;
        if (fromOthers > 0) {
            setChatUnread(c => c + fromOthers);
        }
        lastSeenMsgCountRef.current = chatMessages.length;
    }, [chatMessages, showChat, user?.id]);

    const handleToggleChat = useCallback(() => {
        setShowChat(prev => {
            const next = !prev;
            if (next) {
                lastSeenMsgCountRef.current = chatMessages.length;
                setChatUnread(0);
            }
            return next;
        });
    }, [chatMessages.length]);

    const handleSendChatMessage = useCallback((text) => {
        if (onSendChat) {
            onSendChat(text);
        }
    }, [onSendChat]);

    const handleSendChatFile = useCallback((file) => {
        if (onSendChatFile) {
            onSendChatFile(file);
        }
    }, [onSendChatFile]);

    // ─── Tell the peer whenever our camera turns on/off ───
    // Browsers' RTCRtpReceiver.track.onmute is unreliable (Chrome lags 5–10s,
    // Firefox sometimes never fires), so we send an explicit `video-state`
    // signal. While screen-sharing the outgoing video track is the screen,
    // not the cam, so the peer should NOT see our avatar in that case — only
    // when controls.videoOff is true and we are not screen-sharing.
    useEffect(() => {
        if (status !== 'connected') return;
        if (!isVideoCall) return;
        const peerSeesNoCamera = controls.videoOff && !controls.screenSharing;
        webrtc.sendLocalVideoState?.(peerSeesNoCamera);
    }, [status, isVideoCall, controls.videoOff, controls.screenSharing]);

    // Auto-restore when an incoming call arrives so the user can answer it
    useEffect(() => {
        if (status === 'incoming' && minimized) setMinimized(false);
    }, [status, minimized]);

    const handleMinimize = useCallback((e) => {
        e?.stopPropagation?.();
        setMinimized(true);
        // Close any open popovers so they don't sit on top of the mini widget
        setShowAddParticipant(false);
        setShowChat(false);
        controls.setShowAudioDevices?.(false);
        controls.setShowVideoDevices?.(false);
    }, [controls]);

    const handleRestore = useCallback((e) => {
        e?.stopPropagation?.();
        setMinimized(false);
    }, []);

    const overlayContent = (
        <div
            ref={overlayRef}
            className={`${s.overlay} ${(isVideoCall || controls.screenSharing || webrtc.remoteHasVideo) && isConnected ? s.videoMode : ''} ${controls.onHold ? s.holdMode : ''} ${minimized ? s.minimized : ''}`}
            onClick={minimized ? handleRestore : undefined}
            role={minimized ? 'button' : undefined}
            aria-label={minimized ? 'Restore call window' : undefined}
            tabIndex={minimized ? 0 : undefined}
        >
            {/* Window controls for frameless Electron window */}
            {isWinElectron && !minimized && (
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

            <audio ref={webrtc.remoteAudioRef} autoPlay />

            {(isVideoCall || controls.screenSharing || webrtc.remoteHasVideo) && (
                <>
                    <video
                        ref={webrtc.remoteVideoRef}
                        className={`${s.remoteVideo} ${swapped ? s.swapped : ''}`}
                        autoPlay playsInline
                        onClick={swapped ? () => setSwapped(false) : undefined}
                    />
                    <video
                        ref={webrtc.localVideoRef}
                        className={`${s.localVideo} ${controls.videoOff && !controls.screenSharing ? s.localVideoHidden : ''} ${swapped ? s.swapped : ''}`}
                        autoPlay playsInline muted
                        onClick={!swapped ? () => setSwapped(true) : undefined}
                    />
                    {controls.videoOff && !controls.screenSharing && (
                        <div
                            className={s.localVideoAvatar}
                            onClick={() => setSwapped(prev => !prev)}
                        >
                            <ChatAvatar name={user?.fullName || 'You'} avatar={user?.avatar} size="md" />
                        </div>
                    )}
                    {/* Mute indicator on the local self-view tile so YOU can
                        see at a glance that you are on mute (matches the way
                        Teams/Zoom/Meet flag mute state on the self-tile). */}
                    {controls.muted && (
                        <div
                            className={`${s.localVideoMuteBadge} ${controls.videoOff && !controls.screenSharing ? s.localVideoMuteBadgeAvatar : ''}`}
                            title="You are muted"
                            aria-label="You are muted"
                        >
                            <MicOffIcon />
                        </div>
                    )}
                </>
            )}

            {/* For audio-only calls (no local video tile) still flag mute
                state by overlaying a small badge on the caller-info card. */}
            {!isVideoCall && !controls.screenSharing && !webrtc.remoteHasVideo && controls.muted && isConnected && (
                <div
                    className={s.localVideoMuteBadge}
                    style={{ position: 'absolute', top: 16, left: 16, bottom: 'auto', right: 'auto' }}
                    title="You are muted"
                    aria-label="You are muted"
                >
                    <MicOffIcon />
                </div>
            )}

            {isConnected && (
                <div className={s.topBar}>
                    <QualityBadge quality={controls.connectionQuality} />
                    {controls.screenSharing && <span className={s.sharingBadge}>Screen Sharing</span>}
                    {controls.onHold && <span className={s.holdBadge}>On Hold</span>}
                </div>
            )}

            {(!isVideoCall || !isConnected || controls.onHold || status === 'reconnecting' || (isVideoCall && isConnected && webrtc.remoteVideoOff)) && (
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

            {/* ─── In-call personal chat panel ─── */}
            {showChat && onSendChat && (
                <CallChatPanel
                    messages={chatMessages}
                    currentUserId={user?.id}
                    onSend={handleSendChatMessage}
                    onSendFile={onSendChatFile ? handleSendChatFile : undefined}
                    onClose={() => setShowChat(false)}
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

                        {isConnected && canScreenShare && (
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

                        {/* Minimize — shrinks the call into a floating widget
                            so the user can navigate to Notes / Chat / Dashboard
                            / Tasks / Calendar / Attendance / Settings while the
                            call keeps running. */}
                        {isConnected && (
                            <button
                                className={s.controlBtn}
                                onClick={handleMinimize}
                                title="Minimize call"
                                aria-label="Minimize call"
                            >
                                <MinimizeIcon />
                            </button>
                        )}

                        {isVideoCall && isConnected && document.pictureInPictureEnabled && (
                            <button className={s.controlBtn} onClick={controls.togglePiP} title="Picture-in-Picture">
                                <PipIcon />
                            </button>
                        )}

                        {/* Personal chat — toggle the slide-out chat panel */}
                        {isConnected && onSendChat && (
                            <button
                                className={`${s.controlBtn} ${showChat ? s.active : ''} ${s.chatBtn}`}
                                onClick={handleToggleChat}
                                title="Chat"
                                aria-label="Toggle chat"
                            >
                                <ChatIcon />
                                {chatUnread > 0 && !showChat && (
                                    <span className={s.chatUnreadBadge}>
                                        {chatUnread > 99 ? '99+' : chatUnread}
                                    </span>
                                )}
                            </button>
                        )}

                        {isConnected && canAddParticipant && (
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

            {/* Mini-mode bottom strip (name + mute/end/restore). Only visible
                when the overlay has the .minimized class — see CSS. Clicks on
                buttons stop propagation so they don't trigger the overlay's
                "click to restore" handler. */}
            {minimized && (
                <div className={s.miniBar} onClick={(e) => e.stopPropagation()}>
                    <div className={s.miniBarInfo}>
                        <span className={s.miniBarName}>{remoteName || 'Call'}</span>
                        <span className={s.miniBarMeta}>
                            {isConnected ? formatDuration(duration) : (
                                status === 'incoming' ? 'Incoming…' :
                                status === 'ringing'  ? 'Ringing…' :
                                status === 'reconnecting' ? 'Reconnecting…' : 'Connecting…'
                            )}
                            {controls.muted && (
                                <span className={s.miniBarMuteIcon} title="Muted">
                                    <MicOffIcon />
                                </span>
                            )}
                        </span>
                    </div>
                    <div className={s.miniBarActions}>
                        <button
                            type="button"
                            className={s.miniBarBtn}
                            onClick={(e) => { e.stopPropagation(); controls.toggleMute(); }}
                            title={controls.muted ? 'Unmute' : 'Mute'}
                            aria-label={controls.muted ? 'Unmute' : 'Mute'}
                        >
                            {controls.muted ? <MicOffIcon /> : <MicIcon />}
                        </button>
                        <button
                            type="button"
                            className={s.miniBarBtn}
                            onClick={handleRestore}
                            title="Restore call window"
                            aria-label="Restore call window"
                        >
                            <MaximizeIcon />
                        </button>
                        <button
                            type="button"
                            className={`${s.miniBarBtn} ${s.miniBarEnd}`}
                            onClick={(e) => { e.stopPropagation(); webrtc.handleEnd(); }}
                            title="End call"
                            aria-label="End call"
                        >
                            <PhoneIcon rotate />
                        </button>
                    </div>
                </div>
            )}
        </div>
    );

    // Render via a portal attached to <body> so that even when the host page
    // (Chat) is hidden by the KeepAlive wrapper (display:none), the call
    // overlay stays visible across navigations. Without this the call window
    // would disappear the moment the user navigated to Notes / Dashboard /
    // Tasks etc., even though the underlying peer connection stayed alive.
    return createPortal(overlayContent, document.body);
}

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
    ScreenShareIcon, ScreenShareOffIcon,
    HoldIcon, ResumeIcon, PipIcon, AddParticipantIcon, ChatIcon
} from './CallIcons';
import s from '../CallOverlay.module.css';

const isElectron = !!window.electronAPI?.isElectron;
const isWinElectron = isElectron && window.electronAPI?.platform !== 'darwin';
const hasElectronCallPip = !!window.electronAPI?.callPip;
// Document Picture-in-Picture API (Chromium 116+) — lets us render arbitrary
// HTML in an OS-level always-on-top window. Used for audio calls in the web
// build where the standard <video> PiP can't help.
const hasDocumentPip = typeof window !== 'undefined'
    && typeof window.documentPictureInPicture?.requestWindow === 'function';

// Restore (maximize-out-of-pip) icon — used only by the in-app mini bar.
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
    //
    // On top of the in-app mini we ALSO try to open one of (in priority order):
    //   1. An Electron always-on-top BrowserWindow (desktop build → Teams-style
    //      floating window that survives switching to other apps).
    //   2. The browser's native <video>.requestPictureInPicture() for video
    //      calls in the web build.
    //   3. The Document Picture-in-Picture API for audio calls in Chromium 116+.
    // The user only sees one button labelled "Picture-in-picture"; we pick
    // whichever option is available at click time.
    const [minimized, setMinimized] = useState(false);
    const [nativePipActive, setNativePipActive] = useState(false);
    const [electronPipActive, setElectronPipActive] = useState(false);
    const docPipWindowRef = useRef(null);
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

    // ─── Picture-in-Picture helpers ───────────────────────────────────
    const closeAllFloatingLayers = useCallback(() => {
        // Native <video> PiP
        try {
            if (document.pictureInPictureElement) {
                document.exitPictureInPicture().catch(() => { /* ignore */ });
            }
        } catch { /* ignore */ }
        // Document PiP
        try { docPipWindowRef.current?.close?.(); } catch { /* ignore */ }
        docPipWindowRef.current = null;
        // Electron mini window
        if (hasElectronCallPip) {
            try { window.electronAPI.callPip.close(); } catch { /* ignore */ }
        }
        setNativePipActive(false);
        setElectronPipActive(false);
    }, []);

    // Auto-restore when an incoming call arrives so the user can answer it.
    // Also close any floating layer so the accept/decline buttons are
    // immediately reachable in the full overlay.
    useEffect(() => {
        if (status === 'incoming') {
            if (minimized) setMinimized(false);
            closeAllFloatingLayers();
        }
    }, [status, minimized, closeAllFloatingLayers]);

    // Listen for native PiP exit (user clicked the browser's ✕ on the
    // floating video) → restore the full overlay automatically.
    useEffect(() => {
        const v = webrtc.remoteVideoRef.current;
        if (!v) return;
        const onEnter = () => setNativePipActive(true);
        const onLeave = () => {
            setNativePipActive(false);
            setMinimized(false);
        };
        v.addEventListener('enterpictureinpicture', onEnter);
        v.addEventListener('leavepictureinpicture', onLeave);
        return () => {
            v.removeEventListener('enterpictureinpicture', onEnter);
            v.removeEventListener('leavepictureinpicture', onLeave);
        };
    }, [webrtc.remoteVideoRef]);

    // Electron mini-window IPC: user closed the floatie → restore overlay.
    // Listen for actions (mute/unmute/restore/end) coming from the floatie.
    useEffect(() => {
        if (!hasElectronCallPip) return;
        const offClosed = window.electronAPI.callPip.onWindowClosed(() => {
            setElectronPipActive(false);
            setMinimized(false);
        });
        const offAction = window.electronAPI.callPip.onAction(({ action }) => {
            if (action === 'mute' || action === 'unmute') {
                controls.toggleMute();
            } else if (action === 'restore') {
                setElectronPipActive(false);
                setMinimized(false);
                try { window.electronAPI.callPip.close(); } catch { /* ignore */ }
            } else if (action === 'end') {
                try { window.electronAPI.callPip.close(); } catch { /* ignore */ }
                webrtc.handleEnd();
            }
        });
        return () => {
            try { offClosed?.(); } catch { /* ignore */ }
            try { offAction?.(); } catch { /* ignore */ }
        };
    }, [controls, webrtc]);

    // Push live state into the Electron floatie whenever something the user
    // can see there changes (status, duration, mute, callType, name).
    useEffect(() => {
        if (!hasElectronCallPip || !electronPipActive) return;
        try {
            window.electronAPI.callPip.updateState({
                remoteName: remoteName || 'Call',
                remoteAvatar: remoteAvatar || null,
                status: controls.onHold ? 'on-hold' : status,
                durationSec: duration,
                muted: controls.muted,
                videoOff: controls.videoOff,
                callType,
            });
        } catch { /* ignore */ }
    }, [electronPipActive, status, duration, controls.muted, controls.videoOff,
        controls.onHold, remoteName, remoteAvatar, callType]);

    // Close any floating layer + mini state when the call ends/unmounts
    useEffect(() => () => { closeAllFloatingLayers(); }, [closeAllFloatingLayers]);

    const openElectronPip = useCallback(() => {
        if (!hasElectronCallPip) return false;
        try {
            window.electronAPI.callPip.open({
                remoteName: remoteName || 'Call',
                remoteAvatar: remoteAvatar || null,
                status: controls.onHold ? 'on-hold' : status,
                durationSec: duration,
                muted: controls.muted,
                videoOff: controls.videoOff,
                callType,
            });
            setElectronPipActive(true);
            return true;
        } catch {
            return false;
        }
    }, [remoteName, remoteAvatar, status, duration,
        controls.muted, controls.videoOff, controls.onHold, callType]);

    const openNativeVideoPip = useCallback(async () => {
        const v = webrtc.remoteVideoRef.current;
        if (!v || !document.pictureInPictureEnabled) return false;
        try {
            await v.requestPictureInPicture();
            return true;
        } catch {
            return false;
        }
    }, [webrtc.remoteVideoRef]);

    const openDocumentPip = useCallback(async () => {
        if (!hasDocumentPip) return false;
        try {
            const pipWin = await window.documentPictureInPicture.requestWindow({
                width: 320, height: 220,
            });
            docPipWindowRef.current = pipWin;
            pipWin.document.title = 'WorkPulse Call';
            pipWin.document.body.style.margin = '0';
            pipWin.document.body.style.background = '#111827';
            pipWin.document.body.style.color = '#f9fafb';
            pipWin.document.body.style.fontFamily =
                '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
            pipWin.document.body.innerHTML = `
                <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;gap:8px;padding:12px;box-sizing:border-box;">
                    <div id="wp-pip-avatar" style="width:64px;height:64px;border-radius:50%;background:#374151;display:flex;align-items:center;justify-content:center;font-size:26px;font-weight:600;overflow:hidden;"></div>
                    <div id="wp-pip-name" style="font-size:15px;font-weight:600;text-align:center;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%;"></div>
                    <div id="wp-pip-status" style="font-size:12px;opacity:0.75;"></div>
                </div>
            `;
            const setAvatar = () => {
                const el = pipWin.document.getElementById('wp-pip-avatar');
                if (!el) return;
                if (remoteAvatar) {
                    const url = remoteAvatar.startsWith('http')
                        ? remoteAvatar
                        : `${window.location.origin}${remoteAvatar.startsWith('/') ? '' : '/'}${remoteAvatar}`;
                    el.innerHTML = `<img src="${url}" alt="" style="width:100%;height:100%;object-fit:cover;" />`;
                } else {
                    el.textContent = (remoteName || '?').charAt(0).toUpperCase();
                }
            };
            setAvatar();
            const nameEl = pipWin.document.getElementById('wp-pip-name');
            if (nameEl) nameEl.textContent = remoteName || 'Call';
            pipWin.addEventListener('pagehide', () => {
                docPipWindowRef.current = null;
                setMinimized(false);
            });
            return true;
        } catch {
            return false;
        }
    }, [remoteName, remoteAvatar]);

    // Keep the Document PiP window's status/duration text fresh.
    useEffect(() => {
        const pipWin = docPipWindowRef.current;
        if (!pipWin) return;
        try {
            const el = pipWin.document.getElementById('wp-pip-status');
            if (!el) return;
            if (status === 'incoming') el.textContent = 'Incoming call…';
            else if (status === 'ringing') el.textContent = 'Ringing…';
            else if (status === 'connecting') el.textContent = 'Connecting…';
            else if (status === 'reconnecting') el.textContent = 'Reconnecting…';
            else if (controls.onHold) el.textContent = 'On Hold';
            else el.textContent = formatDuration(duration);
        } catch { /* ignore */ }
    }, [status, duration, controls.onHold]);

    const handleMinimize = useCallback(async (e) => {
        e?.stopPropagation?.();
        // Close any open popovers so they don't sit on top of the mini widget
        setShowAddParticipant(false);
        setShowChat(false);
        controls.setShowAudioDevices?.(false);
        controls.setShowVideoDevices?.(false);
        setMinimized(true);

        // Try floating layers in priority order. The in-app .minimized
        // overlay is always shown as the WorkPulse-internal fallback.
        if (openElectronPip()) return;
        if (isVideoCall) {
            const ok = await openNativeVideoPip();
            if (ok) return;
        }
        // Audio call (or video PiP unavailable) on the web → try Document PiP.
        await openDocumentPip();
    }, [controls, isVideoCall, openElectronPip, openNativeVideoPip, openDocumentPip]);

    const handleRestore = useCallback((e) => {
        e?.stopPropagation?.();
        setMinimized(false);
        closeAllFloatingLayers();
    }, [closeAllFloatingLayers]);

    // When an external floating layer (Electron window, native PiP, or
    // Document PiP) is showing the call, we hide the in-app mini overlay
    // entirely so the user only sees the OS-level floating widget — no
    // duplicate UI inside the WorkPulse window.
    const externalFloaterActive = electronPipActive || nativePipActive || !!docPipWindowRef.current;
    const hiddenForExternal = minimized && externalFloaterActive;

    const overlayContent = (
        <div
            ref={overlayRef}
            className={`${s.overlay} ${(isVideoCall || controls.screenSharing || webrtc.remoteHasVideo) && isConnected ? s.videoMode : ''} ${controls.onHold ? s.holdMode : ''} ${minimized ? s.minimized : ''}`}
            onClick={minimized && !hiddenForExternal ? handleRestore : undefined}
            role={minimized && !hiddenForExternal ? 'button' : undefined}
            aria-label={minimized && !hiddenForExternal ? 'Restore call window' : undefined}
            tabIndex={minimized && !hiddenForExternal ? 0 : undefined}
            style={hiddenForExternal ? { display: 'none' } : undefined}
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

                        {/* Picture-in-Picture / Minimize — single combined
                            button. Picks the best available floating layer:
                            Electron always-on-top window (desktop), browser's
                            native video PiP (web video call), Document PiP
                            (web audio call on Chrome/Edge 116+), or falls back
                            to the in-app floating widget. Lets the user keep
                            working inside WorkPulse — and outside — while the
                            call stays alive. */}
                        {isConnected && (
                            <button
                                className={s.controlBtn}
                                onClick={handleMinimize}
                                title="Picture-in-picture"
                                aria-label="Picture-in-picture"
                            >
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

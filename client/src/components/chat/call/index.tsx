/* eslint-disable @typescript-eslint/no-explicit-any */
import { useState, useEffect, useRef, useCallback } from "react";
import { createPortal } from "react-dom";
import { ChatAvatar } from "../";
import useWebRTC from "./useWebRTC";
import useCallControls from "./useCallControls";
import { QualityBadge, DeviceSelector } from "./CallWidgets";
import { AddParticipantPopup } from "./AddParticipantPopup";
import CallChatPanel from "./CallChatPanel";
import { useNotificationPrefs } from "../../../NotificationPrefsContext";
import {
    MicIcon,
    MicOffIcon,
    CamIcon,
    CamOffIcon,
    PhoneIcon,
    ScreenShareIcon,
    ScreenShareOffIcon,
    HoldIcon,
    ResumeIcon,
    PipIcon,
    AddParticipantIcon,
    ChatIcon,
    RecordIcon,
    NoiseSuppressionIcon,
    EmojiIcon,
} from "./CallIcons";
import s from "../CallOverlay.module.css";

const isElectron = !!window.electronAPI?.isElectron;
const isWinElectron = isElectron && window.electronAPI?.platform !== "darwin";
const hasElectronCallPip = !!(window.electronAPI as any)?.callPip;
const hasDocumentPip =
    typeof window !== "undefined" && typeof (window as any).documentPictureInPicture?.requestWindow === "function";

const REACTION_EMOJIS = ["\u{1F44D}", "\u{1F44F}", "\u{2764}\u{FE0F}", "\u{1F602}", "\u{1F389}", "\u{1F914}"];

// P1.1/P1.2 — client-side call lifecycle timeouts. The server keeps a backstop
// (`STALE_RINGING_TTL_SECS = 45` in server/jobs.ts) that MUST stay larger than
// RING_TIMEOUT_MS so the client always shows feedback first.
const RING_TIMEOUT_MS = 35000; // outgoing ring → "No answer"
const CONNECT_TIMEOUT_MS = 30000; // connecting/reconnecting → "Couldn't connect"
// How long the "No answer" / "Couldn't connect" message stays on screen before
// the overlay tears down.
const END_MESSAGE_LINGER_MS = 1800;

const MaximizeIcon = () => (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
        <path
            d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
        />
    </svg>
);

interface ChatMessageLike {
    sender_id?: number | string;
    [key: string]: any;
}

interface ReactionItem {
    id: number;
    emoji: string;
    fromSelf: boolean;
}

interface CallOverlayProps {
    callState: any;
    user: any;
    wsSend: (type: string, payload: any) => void;
    onEnd: () => void;
    chatMessages?: ChatMessageLike[];
    onSendChat?: (text: string) => void;
    onSendChatFile?: (file: any) => void;
    callReactionRef?: React.MutableRefObject<((emoji: string) => void) | null>;
}

export default function CallOverlay({
    callState,
    user,
    wsSend,
    onEnd,
    chatMessages = [],
    onSendChat,
    onSendChatFile,
    callReactionRef,
}: CallOverlayProps) {
    const { callId, conversationId, callType, isIncoming, remoteName, remoteAvatar, isGroup } = callState;

    const canAddParticipant = !!isGroup;

    const isReconnect = !!callState.isReconnect;
    // `preAccepted` means the user already clicked "Accept" in the global PiP
    // incoming-call notification (GlobalIncomingCall). When that happens we
    // navigate to the chat page and mount this overlay — but we MUST NOT show
    // another "incoming" screen with accept/reject buttons, otherwise the user
    // has to click accept twice. Start directly in `connecting`; useWebRTC's
    // auto-accept effect handles the actual WebRTC handshake in the background.
    const isPreAccepted = !!callState.preAccepted;
    const [status, setStatus] = useState(
        isReconnect ? "reconnecting" : isPreAccepted ? "connecting" : isIncoming ? "incoming" : "ringing"
    );
    const [duration, setDuration] = useState(0);
    const [showAddParticipant, setShowAddParticipant] = useState(false);
    const [showChat, setShowChat] = useState(false);
    const [chatUnread, setChatUnread] = useState(0);
    const [swapped, setSwapped] = useState(false);
    const [minimized, setMinimized] = useState(false);
    const [nativePipActive, setNativePipActive] = useState(false);
    const [electronPipActive, setElectronPipActive] = useState(false);
    const docPipWindowRef = useRef<any>(null);
    const canScreenShare = typeof navigator.mediaDevices?.getDisplayMedia === "function";
    const lastSeenMsgCountRef = useRef(chatMessages.length);

    // ─── New feature states ───
    const [controlsVisible, setControlsVisible] = useState(true);
    const [showStats, setShowStats] = useState(false);
    const [showShortcutsHelp, setShowShortcutsHelp] = useState(false);
    const [showReactionPicker, setShowReactionPicker] = useState(false);
    const [reactions, setReactions] = useState<ReactionItem[]>([]);
    const [reconnectToast, setReconnectToast] = useState<string | null>(null);
    // P1.1/P1.2 — terminal feedback shown briefly before the overlay closes
    // (e.g. "No answer", "Couldn't connect").
    const [endMessage, setEndMessage] = useState<string | null>(null);
    const [localVideoCorner, setLocalVideoCorner] = useState<string>(() => {
        try {
            return sessionStorage.getItem("wp_call_video_corner") || "bottom-right";
        } catch {
            return "bottom-right";
        }
    });
    const mouseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const prevStatusRef = useRef(status);
    const dragRef = useRef<{ startX: number; startY: number; moved: boolean } | null>(null);

    const { playRingtone, playOutgoing } = useNotificationPrefs() as any;

    const overlayRef = useRef<HTMLDivElement | null>(null);
    const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const handleEndRef = useRef<(() => void) | null>(null);
    const stopRingtoneRef = useRef<(() => void) | null>(null);

    const webrtc = useWebRTC({
        callState,
        callType,
        wsSend,
        onEnd,
        onStatusChange: setStatus,
    });

    const controls = useCallControls({
        localStreamRef: webrtc.localStreamRef,
        pcRef: webrtc.pcRef,
        screenStreamRef: webrtc.screenStreamRef,
        screenSenderRef: webrtc.screenSenderRef,
        localVideoRef: webrtc.localVideoRef,
        remoteVideoRef: webrtc.remoteVideoRef,
        overlayRef: overlayRef as React.MutableRefObject<HTMLElement | null>,
    });

    // ─── Connection / ring timeout ───
    // P1.1: an unanswered OUTGOING call rings for RING_TIMEOUT_MS (35s), then we
    // surface "No answer" and end. P1.2: a call stuck in connecting/reconnecting
    // for CONNECT_TIMEOUT_MS (30s) surfaces "Couldn't connect" and ends. Both
    // show a brief terminal message before tearing the overlay down.
    useEffect(() => {
        if (status === "ringing" || status === "connecting" || status === "reconnecting") {
            const isRinging = status === "ringing";
            webrtc.connectionTimeoutRef.current = setTimeout(
                () => {
                    setEndMessage(isRinging ? "No answer" : "Couldn't connect");
                    setTimeout(() => {
                        if (handleEndRef.current) handleEndRef.current();
                    }, END_MESSAGE_LINGER_MS);
                },
                isRinging ? RING_TIMEOUT_MS : CONNECT_TIMEOUT_MS
            );
        }
        return () => clearTimeout(webrtc.connectionTimeoutRef.current as any);
    }, [status]);

    handleEndRef.current = webrtc.handleEnd;

    // ─── Duration timer ───
    useEffect(() => {
        if (status === "connected") {
            timerRef.current = setInterval(() => setDuration((d) => d + 1), 1000);
        }
        return () => clearInterval(timerRef.current as any);
    }, [status]);

    // ─── Connection quality monitor ───
    useEffect(() => {
        if (status === "connected" && webrtc.pcRef.current) {
            const interval = controls.startQualityMonitor(webrtc.pcRef.current);
            return () => clearInterval(interval);
        }
    }, [status]);

    // ─── Emit OUR measured connection quality to the peer ───
    // Mirrors the mobile client: the peer renders a "<name>'s connection is
    // unstable" banner from this signal (Teams/Meet parity). sendQualityState
    // dedupes internally so this only emits on a real change.
    useEffect(() => {
        if (status !== "connected") return;
        const q = controls.connectionQuality;
        if (q === "good" || q === "fair" || q === "poor" || q === "unknown") {
            webrtc.sendQualityState?.(q);
        }
    }, [status, controls.connectionQuality]); // eslint-disable-line react-hooks/exhaustive-deps

    // ─── Track active device IDs ───
    useEffect(() => {
        if (webrtc.localStreamRef.current) {
            const at = webrtc.localStreamRef.current.getAudioTracks()[0];
            const vt = webrtc.localStreamRef.current.getVideoTracks()[0];
            if (at) (controls.switchAudioDevice as any) && void 0;
            if (vt) (controls.switchVideoDevice as any) && void 0;
        }
    }, [status]);

    // ─── Ringtone / outgoing tone ───
    useEffect(() => {
        let stop: (() => void) | null = null;
        if (status === "incoming") {
            stop = playRingtone();
        } else if (status === "ringing") {
            stop = playOutgoing();
        }
        stopRingtoneRef.current = stop;
        return () => {
            if (stopRingtoneRef.current) {
                try {
                    stopRingtoneRef.current();
                } catch {
                    /* ignore */
                }
                stopRingtoneRef.current = null;
            }
            try {
                webrtc.stopRingtone();
            } catch {
                /* ignore */
            }
        };
    }, [status, playRingtone, playOutgoing]);

    // ─── Cleanup timer on unmount ───
    useEffect(() => () => clearInterval(timerRef.current as any), []);

    const formatDuration = (secs: number) => {
        const m = Math.floor(secs / 60);
        const sec = secs % 60;
        return `${m}:${String(sec).padStart(2, "0")}`;
    };

    useEffect(() => {
        setSwapped(false);
    }, [status]);

    const isConnected = status === "connected";
    const isVideoCall = callType === "video";

    // ─── Track unread chat messages while the panel is closed ───
    useEffect(() => {
        if (showChat) {
            lastSeenMsgCountRef.current = chatMessages.length;
            setChatUnread(0);
            return;
        }
        const delta = chatMessages.length - lastSeenMsgCountRef.current;
        if (delta <= 0) {
            lastSeenMsgCountRef.current = chatMessages.length;
            return;
        }
        const newMsgs = chatMessages.slice(-delta);
        const fromOthers = newMsgs.filter((m) => m.sender_id !== user?.id).length;
        if (fromOthers > 0) {
            setChatUnread((c) => c + fromOthers);
        }
        lastSeenMsgCountRef.current = chatMessages.length;
    }, [chatMessages, showChat, user?.id]);

    const handleToggleChat = useCallback(() => {
        setShowChat((prev) => {
            const next = !prev;
            if (next) {
                lastSeenMsgCountRef.current = chatMessages.length;
                setChatUnread(0);
            }
            return next;
        });
    }, [chatMessages.length]);

    const handleSendChatMessage = useCallback(
        (text: string) => {
            if (onSendChat) onSendChat(text);
        },
        [onSendChat]
    );

    const handleSendChatFile = useCallback(
        (file: any) => {
            if (onSendChatFile) onSendChatFile(file);
        },
        [onSendChatFile]
    );

    // ─── Tell the peer whenever our outgoing video state changes ───
    useEffect(() => {
        if (status !== "connected") return;
        let peerSeesNoVideo;
        if (isVideoCall) {
            peerSeesNoVideo = controls.videoOff && !controls.screenSharing;
        } else {
            peerSeesNoVideo = !controls.screenSharing;
        }
        webrtc.sendLocalVideoState?.(peerSeesNoVideo);
    }, [status, isVideoCall, controls.videoOff, controls.screenSharing]);

    // Send local mute state to remote peer
    useEffect(() => {
        if (status !== "connected") return;
        webrtc.sendLocalMuteState?.(controls.muted);
    }, [status, controls.muted]);

    // Send local screen share state to remote peer
    useEffect(() => {
        if (status !== "connected") return;
        webrtc.sendLocalScreenShareState?.(controls.screenSharing);
    }, [status, controls.screenSharing]);

    // ═══════════════════════════════════════════════════════════════
    //  FEATURE: Auto-hide controls (video mode, 4s idle)
    // ═══════════════════════════════════════════════════════════════
    // Auto-hide the call chrome (controls bar, top status bar, name + duration)
    // after 4s of no mouse/touch movement — for ALL connected calls, including
    // AUDIO-ONLY ones (so the caller-info card with the name + duration hides
    // too, matching the mobile app). Only active while connected; ringing /
    // incoming / connecting always keep the controls visible.
    const resetControlsTimer = useCallback(() => {
        setControlsVisible(true);
        clearTimeout(mouseTimerRef.current as any);
        if (isConnected) {
            mouseTimerRef.current = setTimeout(() => setControlsVisible(false), 4000);
        }
    }, [isConnected]);

    useEffect(() => {
        if (!isConnected) {
            setControlsVisible(true);
            clearTimeout(mouseTimerRef.current as any);
            return;
        }
        mouseTimerRef.current = setTimeout(() => setControlsVisible(false), 4000);
        return () => clearTimeout(mouseTimerRef.current as any);
    }, [isConnected]);

    // ═══════════════════════════════════════════════════════════════
    //  FEATURE: Keyboard shortcuts
    // ═══════════════════════════════════════════════════════════════
    useEffect(() => {
        if (minimized) return;
        const handleKeyDown = (e: KeyboardEvent) => {
            const target = e.target as HTMLElement;
            const tag = target.tagName;
            if (tag === "INPUT" || tag === "TEXTAREA" || target.isContentEditable) return;

            const key = e.key.toLowerCase();
            if (key === "m") {
                controls.toggleMute();
                resetControlsTimer();
            } else if (key === "v" && isVideoCall) {
                controls.toggleVideo();
                resetControlsTimer();
            } else if (key === "s" && isConnected && canScreenShare) {
                controls.toggleScreenShare();
                resetControlsTimer();
            } else if (key === "h" && isConnected) {
                controls.toggleHold();
                resetControlsTimer();
            } else if (key === "e" || (e.ctrlKey && e.shiftKey && key === "h")) {
                webrtc.handleEnd();
            } else if (key === "?" || (e.shiftKey && key === "/")) {
                setShowShortcutsHelp((v) => !v);
            } else if (key === "escape") {
                if (showShortcutsHelp) setShowShortcutsHelp(false);
                else if (showStats) setShowStats(false);
                else if (showReactionPicker) setShowReactionPicker(false);
            } else if (key === " " && !e.repeat) {
                e.preventDefault();
                if (controls.muted) controls.toggleMute();
            }
        };
        const handleKeyUp = (e: KeyboardEvent) => {
            const target = e.target as HTMLElement;
            const tag = target.tagName;
            if (tag === "INPUT" || tag === "TEXTAREA" || target.isContentEditable) return;
            if (e.key === " ") {
                e.preventDefault();
                if (!controls.muted) controls.toggleMute();
            }
        };
        document.addEventListener("keydown", handleKeyDown);
        document.addEventListener("keyup", handleKeyUp);
        return () => {
            document.removeEventListener("keydown", handleKeyDown);
            document.removeEventListener("keyup", handleKeyUp);
        };
    }, [
        minimized,
        isVideoCall,
        isConnected,
        canScreenShare,
        controls,
        webrtc,
        resetControlsTimer,
        showShortcutsHelp,
        showStats,
        showReactionPicker,
    ]);

    // ═══════════════════════════════════════════════════════════════
    //  FEATURE: Network reconnect toast
    // ═══════════════════════════════════════════════════════════════
    useEffect(() => {
        if (status === "reconnecting" && prevStatusRef.current === "connected") {
            setReconnectToast("disconnected");
        } else if (status === "connected" && prevStatusRef.current === "reconnecting") {
            setReconnectToast("reconnected");
            const t = setTimeout(() => setReconnectToast(null), 3000);
            return () => clearTimeout(t);
        }
        prevStatusRef.current = status;
    }, [status]);

    // ═══════════════════════════════════════════════════════════════
    //  FEATURE: Emoji reactions
    // ═══════════════════════════════════════════════════════════════
    const sendReaction = useCallback(
        (emoji: string) => {
            if (!wsSend || !conversationId) return;
            const targetUserId = callState.isIncoming ? callState.callerId : callState.acceptedBy || callState.callerId;
            wsSend("call_reaction", { conversationId, targetUserId, emoji });
            const id = Date.now() + Math.random();
            setReactions((prev) => [...prev, { id, emoji, fromSelf: true }]);
            setTimeout(() => setReactions((prev) => prev.filter((r) => r.id !== id)), 2500);
            setShowReactionPicker(false);
        },
        [wsSend, conversationId, callState, user?.id]
    );

    useEffect(() => {
        if (!callReactionRef) return;
        const handler = (emoji: string) => {
            const id = Date.now() + Math.random();
            setReactions((prev) => [...prev, { id, emoji, fromSelf: false }]);
            setTimeout(() => setReactions((prev) => prev.filter((r) => r.id !== id)), 2500);
        };
        callReactionRef.current = handler;
        return () => {
            if (callReactionRef) callReactionRef.current = null;
        };
    }, [callReactionRef]);

    // ═══════════════════════════════════════════════════════════════
    //  FEATURE: Draggable local video (4 corner snap)
    // ═══════════════════════════════════════════════════════════════
    const handleLocalVideoDragStart = useCallback((e: any) => {
        e.preventDefault();
        const startX = e.clientX || e.touches?.[0]?.clientX || 0;
        const startY = e.clientY || e.touches?.[0]?.clientY || 0;
        dragRef.current = { startX, startY, moved: false };

        const onMove = (ev: any) => {
            if (!dragRef.current) return;
            const cx = ev.clientX || ev.touches?.[0]?.clientX || 0;
            const cy = ev.clientY || ev.touches?.[0]?.clientY || 0;
            if (Math.abs(cx - dragRef.current.startX) > 10 || Math.abs(cy - dragRef.current.startY) > 10) {
                dragRef.current.moved = true;
            }
        };
        const onEnd = (ev: any) => {
            document.removeEventListener("mousemove", onMove);
            document.removeEventListener("mouseup", onEnd);
            document.removeEventListener("touchmove", onMove);
            document.removeEventListener("touchend", onEnd);
            if (!dragRef.current?.moved) {
                dragRef.current = null;
                return;
            }
            const cx = ev.clientX || ev.changedTouches?.[0]?.clientX || 0;
            const cy = ev.clientY || ev.changedTouches?.[0]?.clientY || 0;
            const w = window.innerWidth;
            const h = window.innerHeight;
            const isRight = cx > w / 2;
            const isBottom = cy > h / 2;
            const corner = `${isBottom ? "bottom" : "top"}-${isRight ? "right" : "left"}`;
            setLocalVideoCorner(corner);
            try {
                sessionStorage.setItem("wp_call_video_corner", corner);
            } catch {
                /* ignore */
            }
            dragRef.current = null;
        };
        document.addEventListener("mousemove", onMove);
        document.addEventListener("mouseup", onEnd);
        document.addEventListener("touchmove", onMove);
        document.addEventListener("touchend", onEnd);
    }, []);

    // ─── Picture-in-Picture helpers ───
    const focusMainAppWindow = useCallback(() => {
        try {
            (window.electronAPI as any)?.showAndFocus?.();
        } catch {
            /* ignore */
        }
    }, []);

    const closeAllFloatingLayers = useCallback(() => {
        try {
            if (document.pictureInPictureElement) {
                document.exitPictureInPicture().catch(() => {
                    /* ignore */
                });
            }
        } catch {
            /* ignore */
        }
        try {
            docPipWindowRef.current?.close?.();
        } catch {
            /* ignore */
        }
        docPipWindowRef.current = null;
        if (hasElectronCallPip) {
            try {
                (window.electronAPI as any).callPip.close();
            } catch {
                /* ignore */
            }
        }
        setNativePipActive(false);
        setElectronPipActive(false);
    }, []);

    useEffect(() => {
        if (status === "incoming") {
            if (minimized) setMinimized(false);
            closeAllFloatingLayers();
        }
    }, [status, minimized, closeAllFloatingLayers]);

    useEffect(() => {
        const v = webrtc.remoteVideoRef.current;
        if (!v) return;
        const onEnter = () => setNativePipActive(true);
        const onLeave = () => {
            setNativePipActive(false);
            setMinimized(false);
            focusMainAppWindow();
        };
        v.addEventListener("enterpictureinpicture", onEnter);
        v.addEventListener("leavepictureinpicture", onLeave);
        return () => {
            v.removeEventListener("enterpictureinpicture", onEnter);
            v.removeEventListener("leavepictureinpicture", onLeave);
        };
    }, [webrtc.remoteVideoRef, webrtc.remoteHasVideo, focusMainAppWindow]);

    useEffect(() => {
        if (!hasElectronCallPip) return;
        const offClosed = (window.electronAPI as any).callPip.onWindowClosed(() => {
            setElectronPipActive(false);
            setMinimized(false);
            focusMainAppWindow();
        });
        const offAction = (window.electronAPI as any).callPip.onAction(({ action }: { action: string }) => {
            if (action === "mute" || action === "unmute") {
                controls.toggleMute();
            } else if (action === "restore") {
                setElectronPipActive(false);
                setMinimized(false);
                try {
                    (window.electronAPI as any).callPip.close();
                } catch {
                    /* ignore */
                }
                focusMainAppWindow();
            } else if (action === "end") {
                try {
                    (window.electronAPI as any).callPip.close();
                } catch {
                    /* ignore */
                }
                webrtc.handleEnd();
            }
        });
        return () => {
            try {
                offClosed?.();
            } catch {
                /* ignore */
            }
            try {
                offAction?.();
            } catch {
                /* ignore */
            }
        };
    }, [controls, webrtc, focusMainAppWindow]);

    useEffect(() => {
        if (!hasElectronCallPip || !electronPipActive) return;
        try {
            (window.electronAPI as any).callPip.updateState({
                remoteName: remoteName || "Call",
                remoteAvatar: remoteAvatar || null,
                status: controls.onHold ? "on-hold" : status,
                durationSec: duration,
                muted: controls.muted,
                videoOff: controls.videoOff,
                callType,
            });
        } catch {
            /* ignore */
        }
    }, [
        electronPipActive,
        status,
        duration,
        controls.muted,
        controls.videoOff,
        controls.onHold,
        remoteName,
        remoteAvatar,
        callType,
    ]);

    useEffect(
        () => () => {
            closeAllFloatingLayers();
        },
        [closeAllFloatingLayers]
    );

    const openElectronPip = useCallback(() => {
        if (!hasElectronCallPip) return false;
        try {
            (window.electronAPI as any).callPip.open({
                remoteName: remoteName || "Call",
                remoteAvatar: remoteAvatar || null,
                status: controls.onHold ? "on-hold" : status,
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
    }, [remoteName, remoteAvatar, status, duration, controls.muted, controls.videoOff, controls.onHold, callType]);

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
            const pipWin = await (window as any).documentPictureInPicture.requestWindow({
                width: 320,
                height: 220,
            });
            docPipWindowRef.current = pipWin;
            pipWin.document.title = "Loops Call";
            pipWin.document.body.style.margin = "0";
            pipWin.document.body.style.background = "#111827";
            pipWin.document.body.style.color = "#f9fafb";
            pipWin.document.body.style.fontFamily = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
            pipWin.document.body.innerHTML = `
                <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;gap:8px;padding:12px;box-sizing:border-box;">
                    <div id="wp-pip-avatar" style="width:64px;height:64px;border-radius:50%;background:#374151;display:flex;align-items:center;justify-content:center;font-size:26px;font-weight:600;overflow:hidden;"></div>
                    <div id="wp-pip-name" style="font-size:15px;font-weight:600;text-align:center;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%;"></div>
                    <div id="wp-pip-status" style="font-size:12px;opacity:0.75;"></div>
                </div>
            `;
            const setAvatar = () => {
                const el = pipWin.document.getElementById("wp-pip-avatar");
                if (!el) return;
                if (remoteAvatar) {
                    const url = remoteAvatar.startsWith("http")
                        ? remoteAvatar
                        : `${window.location.origin}${remoteAvatar.startsWith("/") ? "" : "/"}${remoteAvatar}`;
                    el.innerHTML = `<img src="${url}" alt="" style="width:100%;height:100%;object-fit:cover;" />`;
                } else {
                    el.textContent = (remoteName || "?").charAt(0).toUpperCase();
                }
            };
            setAvatar();
            const nameEl = pipWin.document.getElementById("wp-pip-name");
            if (nameEl) nameEl.textContent = remoteName || "Call";
            pipWin.addEventListener("pagehide", () => {
                docPipWindowRef.current = null;
                setMinimized(false);
                focusMainAppWindow();
            });
            return true;
        } catch {
            return false;
        }
    }, [remoteName, remoteAvatar, focusMainAppWindow]);

    useEffect(() => {
        const pipWin = docPipWindowRef.current;
        if (!pipWin) return;
        try {
            const el = pipWin.document.getElementById("wp-pip-status");
            if (!el) return;
            if (status === "incoming") el.textContent = "Incoming call\u2026";
            else if (status === "ringing") el.textContent = "Ringing\u2026";
            else if (status === "connecting") el.textContent = "Connecting\u2026";
            else if (status === "reconnecting") el.textContent = "Reconnecting\u2026";
            else if (controls.onHold) el.textContent = "On Hold";
            else el.textContent = formatDuration(duration);
        } catch {
            /* ignore */
        }
    }, [status, duration, controls.onHold]);

    const handleMinimize = useCallback(
        async (e?: any) => {
            e?.stopPropagation?.();
            setShowAddParticipant(false);
            setShowChat(false);
            controls.setShowAudioDevices?.(false);
            controls.setShowVideoDevices?.(false);
            setMinimized(true);

            const hasRemoteVideoStream = isVideoCall || webrtc.remoteHasVideo;
            if (hasRemoteVideoStream) {
                const ok = await openNativeVideoPip();
                if (ok) return;
            }
            if (openElectronPip()) return;
            if (isVideoCall) {
                const ok = await openNativeVideoPip();
                if (ok) return;
            }
            await openDocumentPip();
        },
        [controls, isVideoCall, webrtc.remoteHasVideo, openElectronPip, openNativeVideoPip, openDocumentPip]
    );

    const handleRestore = useCallback(
        (e?: any) => {
            e?.stopPropagation?.();
            setMinimized(false);
            closeAllFloatingLayers();
        },
        [closeAllFloatingLayers]
    );

    // ─── Auto-open PiP when the user minimises / hides WorkPulse ─────
    const handleMinimizeRef = useRef(handleMinimize);
    const statusRef = useRef(status);
    const minimizedRef = useRef(minimized);
    const closeAllFloatingLayersRef = useRef(closeAllFloatingLayers);
    useEffect(() => {
        handleMinimizeRef.current = handleMinimize;
    }, [handleMinimize]);
    useEffect(() => {
        statusRef.current = status;
    }, [status]);
    useEffect(() => {
        minimizedRef.current = minimized;
    }, [minimized]);
    useEffect(() => {
        closeAllFloatingLayersRef.current = closeAllFloatingLayers;
    }, [closeAllFloatingLayers]);

    useEffect(() => {
        if (!isElectron) return;
        const offHidden = (window.electronAPI as any)?.onWindowHidden?.(() => {
            const st = statusRef.current;
            if (st === "incoming" || st === "ended") return;
            if (minimizedRef.current) return;
            try {
                handleMinimizeRef.current?.();
            } catch {
                /* ignore */
            }
        });
        const offShown = (window.electronAPI as any)?.onWindowShown?.(() => {
            if (!minimizedRef.current) return;
            setMinimized(false);
            try {
                closeAllFloatingLayersRef.current?.();
            } catch {
                /* ignore */
            }
        });
        return () => {
            try {
                offHidden?.();
            } catch {
                /* ignore */
            }
            try {
                offShown?.();
            } catch {
                /* ignore */
            }
        };
    }, []);

    const externalFloaterActive = electronPipActive || nativePipActive || !!docPipWindowRef.current;
    const hiddenForExternal = minimized && externalFloaterActive;

    // ─── Re-sync video after PiP/minimize restore ────────────────────
    const wasMinimizedRef = useRef(false);
    useEffect(() => {
        if (minimized) {
            wasMinimizedRef.current = true;
            return;
        }
        if (!wasMinimizedRef.current) return;
        wasMinimizedRef.current = false;

        const timer = setTimeout(() => {
            if (status !== "connected") return;
            const rv = webrtc.remoteVideoRef.current;
            const rs = webrtc.remoteStreamRef.current;
            if (rv && rs) {
                rv.srcObject = null;
                rv.srcObject = rs;
                rv.play().catch(() => {});
            }
            if (isVideoCall) {
                const lv = webrtc.localVideoRef.current;
                const ls = webrtc.localStreamRef.current;
                if (lv && ls) {
                    lv.srcObject = null;
                    lv.srcObject = ls;
                    lv.play().catch(() => {});
                }
            }
            const ra = webrtc.remoteAudioRef.current;
            if (ra && rs && ra.paused) {
                ra.srcObject = rs;
                ra.play().catch(() => {});
            }
        }, 100);

        return () => clearTimeout(timer);
    }, [minimized, electronPipActive, nativePipActive]);

    // ─── Auto-stop recording on call end ───
    useEffect(() => {
        if (status === "ended" || !isConnected) {
            if (controls.recording) controls.stopRecording();
        }
    }, [status, isConnected]);

    const overlayContent = (
        <div
            ref={overlayRef}
            className={`${s.overlay} ${(isVideoCall || controls.screenSharing || webrtc.remoteHasVideo) && isConnected ? s.videoMode : ""} ${controls.onHold ? s.holdMode : ""} ${minimized ? s.minimized : ""}`}
            onClick={minimized && !hiddenForExternal ? handleRestore : undefined}
            onMouseMove={!minimized ? resetControlsTimer : undefined}
            onTouchStart={!minimized ? resetControlsTimer : undefined}
            role={minimized && !hiddenForExternal ? "button" : undefined}
            aria-label={minimized && !hiddenForExternal ? "Restore call window" : undefined}
            tabIndex={minimized && !hiddenForExternal ? 0 : undefined}
            style={hiddenForExternal ? { display: "none" } : undefined}
        >
            {/* Window controls for frameless Electron window */}
            {isWinElectron && !minimized && (
                <div className={s.windowControls}>
                    <button className={s.winBtn} onClick={() => window.electronAPI!.minimize()} title="Minimize">
                        <svg width="12" height="12" viewBox="0 0 12 12">
                            <rect x="1" y="5.5" width="10" height="1" fill="currentColor" />
                        </svg>
                    </button>
                    <button className={s.winBtn} onClick={() => window.electronAPI!.maximize()} title="Maximize">
                        <svg width="12" height="12" viewBox="0 0 12 12">
                            <rect x="0.5" y="0.5" width="11" height="11" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1" />
                        </svg>
                    </button>
                    <button className={`${s.winBtn} ${s.winCloseBtn}`} onClick={() => window.electronAPI!.close()} title="Close">
                        <svg width="12" height="12" viewBox="0 0 12 12">
                            <path d="M1 1l10 10M11 1L1 11" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
                        </svg>
                    </button>
                </div>
            )}

            <audio ref={webrtc.remoteAudioRef} autoPlay />

            {/* ─── Remote video tile (fullscreen) ─── */}
            {webrtc.remoteHasVideo && (
                <video
                    ref={webrtc.remoteVideoRef}
                    className={`${s.remoteVideo} ${swapped ? s.swapped : ""}`}
                    autoPlay
                    playsInline
                    onClick={swapped ? () => setSwapped(false) : undefined}
                />
            )}

            {/* Remote mute indicator */}
            {isConnected && webrtc.remoteMuted && (
                <div className={s.remoteMuteBadge}>
                    <MicOffIcon />
                </div>
            )}

            {/* ─── Local self-view tile (draggable corner snap) ─── */}
            {isVideoCall && (
                <video
                    ref={webrtc.localVideoRef}
                    className={`${s.localVideo} ${controls.videoOff ? s.localVideoHidden : ""} ${swapped ? s.swapped : ""} ${!swapped ? (s as any)[`localVideo_${localVideoCorner.replace("-", "_")}`] || "" : ""}`}
                    autoPlay
                    playsInline
                    muted
                    onMouseDown={!swapped ? handleLocalVideoDragStart : undefined}
                    onTouchStart={!swapped ? handleLocalVideoDragStart : undefined}
                    onClick={!swapped && !dragRef.current?.moved ? () => setSwapped(true) : undefined}
                />
            )}

            {/* Local self-tile AVATAR fallback */}
            {((isVideoCall && controls.videoOff) || (!isVideoCall && webrtc.remoteHasVideo)) && (
                <div
                    className={`${s.localVideoAvatar} ${!swapped ? (s as any)[`localVideoAvatar_${localVideoCorner.replace("-", "_")}`] || "" : ""}`}
                    onClick={isVideoCall ? () => setSwapped((prev) => !prev) : undefined}
                >
                    <ChatAvatar name={user?.fullName || "You"} avatar={user?.avatar} size="md" />
                </div>
            )}

            {/* Mute badge — anchored to the bottom-right CORNER of the local
                video PiP / avatar tile so it follows the tile when the user
                drags it to a different screen corner (top-left / top-right /
                bottom-left / bottom-right). Implemented via an invisible
                anchor element that mirrors the tile's position & size, with
                the actual badge pinned at bottom:6 right:6 INSIDE it.
                Audio-only calls (no remote video) render their mute badge
                inside the self-preview card below instead. */}
            {controls.muted && isConnected && (isVideoCall || webrtc.remoteHasVideo) && !swapped && (
                <div
                    className={`${s.localTileBadgeAnchor} ${(s as any)[`localTileBadgeAnchor_${localVideoCorner.replace("-", "_")}`] || ""} ${(isVideoCall && controls.videoOff) || !isVideoCall ? s.localTileBadgeAnchorAvatar : s.localTileBadgeAnchorVideo}`}
                    aria-hidden="true"
                >
                    <div className={s.localTileMuteBadge} title="You are muted" aria-label="You are muted">
                        <MicOffIcon />
                    </div>
                </div>
            )}

            {/* ─── Audio-call self-preview card (1:1 AND group) ─────────────
                Shown whenever the local participant has no other on-screen
                representation (no local video PiP, no local avatar tile).
                This gives the user a visual self-presence and a dedicated
                place for the local mute badge so it doesn't collide with the
                remote-mute badge in the top-right corner on mobile.
                Draggable & corner-snapping just like the local video tile. */}
            {isConnected && !isVideoCall && !webrtc.remoteHasVideo && !controls.screenSharing && (
                <div
                    className={`${s.selfPreviewCard} ${(s as any)[`selfPreviewCard_${localVideoCorner.replace("-", "_")}`] || ""}`}
                    onMouseDown={handleLocalVideoDragStart}
                    onTouchStart={handleLocalVideoDragStart}
                    role="img"
                    aria-label="Your preview"
                >
                    <ChatAvatar name={user?.fullName || user?.name || "You"} avatar={user?.avatar} size="md" />
                    <span className={s.selfPreviewLabel}>You</span>
                    {controls.muted && (
                        <div className={s.selfPreviewMuteBadge} title="You are muted" aria-label="You are muted">
                            <MicOffIcon />
                        </div>
                    )}
                </div>
            )}

            {/* ─── Top bar (status badges) ─── */}
            {isConnected && (
                <div className={`${s.topBar} ${!controlsVisible ? s.topBarHidden : ""}`}>
                    {controls.screenSharing && <span className={s.sharingBadge}>Screen Sharing</span>}
                    {controls.onHold && <span className={s.holdBadge}>On Hold</span>}
                    {controls.recording && <span className={s.recordingBadge}>REC</span>}
                    {controls.noiseSuppression && <span className={s.nsBadge}>NS</span>}
                </div>
            )}

            {/* ─── Detailed stats panel ─── */}
            {showStats && controls.detailedStats && (
                <div className={s.statsPanel}>
                    <div className={s.statsPanelHeader}>
                        <span>Connection Stats</span>
                        <button className={s.statsPanelClose} onClick={() => setShowStats(false)}>
                            &times;
                        </button>
                    </div>
                    <div className={s.statsPanelBody}>
                        {controls.detailedStats.rtt != null && (
                            <div className={s.statRow}>
                                <span>Latency</span>
                                <span>{controls.detailedStats.rtt} ms</span>
                            </div>
                        )}
                        <div className={s.statRow}>
                            <span>Packet Loss</span>
                            <span>{controls.detailedStats.packetLoss}%</span>
                        </div>
                        <div className={s.statRow}>
                            <span>Bitrate In</span>
                            <span>{controls.detailedStats.bitrateIn} kbps</span>
                        </div>
                        <div className={s.statRow}>
                            <span>Bitrate Out</span>
                            <span>{controls.detailedStats.bitrateOut} kbps</span>
                        </div>
                        {controls.detailedStats.frameRate && (
                            <div className={s.statRow}>
                                <span>Frame Rate</span>
                                <span>{controls.detailedStats.frameRate} fps</span>
                            </div>
                        )}
                        {controls.detailedStats.frameWidth && (
                            <div className={s.statRow}>
                                <span>Resolution</span>
                                <span>
                                    {controls.detailedStats.frameWidth}x{controls.detailedStats.frameHeight}
                                </span>
                            </div>
                        )}
                        {controls.detailedStats.audioCodec && (
                            <div className={s.statRow}>
                                <span>Audio Codec</span>
                                <span>{controls.detailedStats.audioCodec.replace("audio/", "")}</span>
                            </div>
                        )}
                        {controls.detailedStats.videoCodec && (
                            <div className={s.statRow}>
                                <span>Video Codec</span>
                                <span>{controls.detailedStats.videoCodec.replace("video/", "")}</span>
                            </div>
                        )}
                        {controls.detailedStats.localCandidateType && (
                            <div className={s.statRow}>
                                <span>Transport</span>
                                <span>{controls.detailedStats.localCandidateType}</span>
                            </div>
                        )}
                    </div>
                </div>
            )}

            {/* ─── Network reconnect toast ─── */}
            {reconnectToast && (
                <div className={`${s.reconnectToast} ${reconnectToast === "reconnected" ? s.reconnectToastSuccess : ""}`}>
                    {reconnectToast === "disconnected" ? "Connection lost. Reconnecting..." : "Reconnected"}
                </div>
            )}

            {/* ─── Peer connection-quality banner (Teams/Meet parity) ───
                The peer reports their own measured quality via the
                `quality-state` signal; when it's "poor" we attribute the
                freeze/stutter to the correct side instead of the local user
                blaming their own network. */}
            {isConnected && webrtc.remotePeerQuality === "poor" && (
                <div className={s.reconnectToast}>
                    {`${remoteName || "Your peer"}'s connection is unstable`}
                </div>
            )}

            {/* ─── Floating emoji reactions ─── */}
            {reactions.length > 0 && (
                <div className={s.reactionsContainer}>
                    {reactions.map((r) => (
                        <span key={r.id} className={s.floatingEmoji}>
                            {r.emoji}
                        </span>
                    ))}
                </div>
            )}

            {/* Caller-info card */}
            {(() => {
                const preConnect = !isConnected || controls.onHold || (status as string) === "reconnecting";
                let showCallInfo;
                if (preConnect) {
                    showCallInfo = true;
                } else if (isVideoCall) {
                    showCallInfo = webrtc.remoteVideoOff && !controls.screenSharing;
                } else {
                    showCallInfo = !webrtc.remoteHasVideo;
                }
                if (!showCallInfo) return null;
                // Auto-hide the caller-info card (name + duration) once connected
                // and idle — matches the controls bar / top bar fade so audio
                // calls hide their chrome too. Pre-connect states (incoming /
                // ringing / connecting / on-hold / reconnecting) always show it.
                const callInfoHidden = isConnected && !controls.onHold && !controlsVisible;
                return (
                    <div className={`${s.callInfo} ${callInfoHidden ? s.callInfoHidden : ""}`}>
                        <div
                            className={`${s.avatarContainer} ${status === "incoming" || status === "ringing" ? s.pulsing : ""}`}
                        >
                            <ChatAvatar name={remoteName || "User"} avatar={remoteAvatar} size="xl" />
                        </div>
                        <h2 className={s.callerName}>{remoteName || "Unknown"}</h2>
                        <p className={s.callStatus}>
                            {endMessage
                                ? endMessage
                                : (
                                    <>
                                        {status === "incoming" && `Incoming ${callType} call...`}
                                        {status === "ringing" && "Ringing..."}
                                        {status === "connecting" && "Connecting..."}
                                        {status === "reconnecting" && "Reconnecting..."}
                                        {isConnected && !controls.onHold && formatDuration(duration)}
                                        {isConnected && controls.onHold && `On Hold \u00B7 ${formatDuration(duration)}`}
                                    </>
                                )}
                        </p>
                        {isConnected && (
                            <button
                                className={s.qualityBadgeBtn}
                                onClick={() => setShowStats((v) => !v)}
                                title="Connection stats"
                            >
                                <QualityBadge quality={controls.connectionQuality} />
                            </button>
                        )}
                    </div>
                );
            })()}

            {isVideoCall && isConnected && !controls.onHold && (
                <div className={`${s.videoOverlayInfo} ${!controlsVisible ? s.videoOverlayInfoHidden : ""}`}>
                    <div className={s.videoOverlayTop}>
                        <span className={s.videoCallerName}>{remoteName}</span>
                        <button
                            className={s.qualityBadgeBtn}
                            onClick={() => setShowStats((v) => !v)}
                            title="Connection stats"
                        >
                            <QualityBadge quality={controls.connectionQuality} />
                        </button>
                    </div>
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

            {/* ─── Reaction emoji picker ─── */}
            {showReactionPicker && (
                <div className={s.reactionPicker}>
                    {REACTION_EMOJIS.map((emoji) => (
                        <button key={emoji} className={s.reactionPickerBtn} onClick={() => sendReaction(emoji)}>
                            {emoji}
                        </button>
                    ))}
                </div>
            )}

            {/* ─── Keyboard shortcuts help modal ─── */}
            {showShortcutsHelp && (
                <div className={s.shortcutsOverlay} onClick={() => setShowShortcutsHelp(false)}>
                    <div className={s.shortcutsModal} onClick={(e) => e.stopPropagation()}>
                        <div className={s.shortcutsHeader}>
                            <span>Keyboard Shortcuts</span>
                            <button className={s.shortcutsClose} onClick={() => setShowShortcutsHelp(false)}>
                                &times;
                            </button>
                        </div>
                        <div className={s.shortcutsList}>
                            <div className={s.shortcutRow}>
                                <kbd>M</kbd>
                                <span>Toggle mute</span>
                            </div>
                            <div className={s.shortcutRow}>
                                <kbd>V</kbd>
                                <span>Toggle video</span>
                            </div>
                            <div className={s.shortcutRow}>
                                <kbd>S</kbd>
                                <span>Toggle screen share</span>
                            </div>
                            <div className={s.shortcutRow}>
                                <kbd>H</kbd>
                                <span>Toggle hold</span>
                            </div>
                            <div className={s.shortcutRow}>
                                <kbd>E</kbd>
                                <span>End call</span>
                            </div>
                            <div className={s.shortcutRow}>
                                <kbd>Space</kbd>
                                <span>Push-to-talk (hold)</span>
                            </div>
                            <div className={s.shortcutRow}>
                                <kbd>Esc</kbd>
                                <span>Close panel</span>
                            </div>
                            <div className={s.shortcutRow}>
                                <kbd>?</kbd>
                                <span>Toggle this help</span>
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {/* ─── Controls bar ─── */}
            <div className={`${s.controls} ${!controlsVisible && isConnected ? s.controlsHidden : ""}`}>
                {status === "incoming" ? (
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
                        <button
                            className={`${s.controlBtn} ${controls.muted ? s.active : ""}`}
                            onClick={controls.toggleMute}
                            title={controls.muted ? "Unmute (M)" : "Mute (M)"}
                        >
                            {controls.muted ? <MicOffIcon /> : <MicIcon />}
                        </button>

                        {/* Noise suppression toggle */}
                        {isConnected && (
                            <button
                                className={`${s.controlBtn} ${s.smallBtn} ${controls.noiseSuppression ? s.active : ""}`}
                                onClick={controls.toggleNoiseSuppression}
                                title={controls.noiseSuppression ? "Disable noise suppression" : "Enable noise suppression"}
                            >
                                <NoiseSuppressionIcon />
                            </button>
                        )}

                        {isVideoCall && (
                            <button
                                className={`${s.controlBtn} ${controls.videoOff ? s.active : ""}`}
                                onClick={controls.toggleVideo}
                                title={controls.videoOff ? "Turn on camera (V)" : "Turn off camera (V)"}
                            >
                                {controls.videoOff ? <CamOffIcon /> : <CamIcon />}
                            </button>
                        )}

                        {isConnected && canScreenShare && (
                            <button
                                className={`${s.controlBtn} ${controls.screenSharing ? s.active : ""}`}
                                onClick={controls.toggleScreenShare}
                                title={controls.screenSharing ? "Stop sharing (S)" : "Share screen (S)"}
                            >
                                {controls.screenSharing ? <ScreenShareOffIcon /> : <ScreenShareIcon />}
                            </button>
                        )}

                        {isConnected && (
                            <button
                                className={`${s.controlBtn} ${controls.onHold ? s.holdActive : ""}`}
                                onClick={controls.toggleHold}
                                title={controls.onHold ? "Resume (H)" : "Hold (H)"}
                            >
                                {controls.onHold ? <ResumeIcon /> : <HoldIcon />}
                            </button>
                        )}

                        {/* PiP / Minimize */}
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

                        {/* Call recording */}
                        {isConnected && (
                            <button
                                className={`${s.controlBtn} ${controls.recording ? s.recordActive : ""}`}
                                onClick={() => {
                                    if (controls.recording) controls.stopRecording();
                                    else controls.startRecording(webrtc.remoteStreamRef.current!);
                                }}
                                title={controls.recording ? "Stop recording" : "Record call"}
                            >
                                <RecordIcon />
                            </button>
                        )}

                        {/* Emoji reactions */}
                        {isConnected && (
                            <button
                                className={`${s.controlBtn} ${showReactionPicker ? s.active : ""}`}
                                onClick={() => setShowReactionPicker((v) => !v)}
                                title="Send reaction"
                            >
                                <EmojiIcon />
                            </button>
                        )}

                        {/* Personal chat */}
                        {isConnected && onSendChat && (
                            <button
                                className={`${s.controlBtn} ${showChat ? s.active : ""} ${s.chatBtn}`}
                                onClick={handleToggleChat}
                                title="Chat"
                                aria-label="Toggle chat"
                            >
                                <ChatIcon />
                                {chatUnread > 0 && !showChat && (
                                    <span className={s.chatUnreadBadge}>{chatUnread > 99 ? "99+" : chatUnread}</span>
                                )}
                            </button>
                        )}

                        {isConnected && canAddParticipant && (
                            <button
                                className={`${s.controlBtn} ${showAddParticipant ? s.active : ""}`}
                                onClick={() => setShowAddParticipant((v) => !v)}
                                title="Add participant"
                            >
                                <AddParticipantIcon />
                            </button>
                        )}

                        <button className={`${s.controlBtn} ${s.endBtn}`} onClick={webrtc.handleEnd} title="End call (E)">
                            <PhoneIcon rotate />
                        </button>
                    </>
                )}
            </div>

            {/* Mini-mode bottom strip */}
            {minimized && (
                <div className={s.miniBar} onClick={(e) => e.stopPropagation()}>
                    <div className={s.miniBarInfo}>
                        <span className={s.miniBarName}>{remoteName || "Call"}</span>
                        <span className={s.miniBarMeta}>
                            {isConnected
                                ? formatDuration(duration)
                                : status === "incoming"
                                  ? "Incoming\u2026"
                                  : status === "ringing"
                                    ? "Ringing\u2026"
                                    : (status as string) === "reconnecting"
                                      ? "Reconnecting\u2026"
                                      : "Connecting\u2026"}
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
                            onClick={(e) => {
                                e.stopPropagation();
                                controls.toggleMute();
                            }}
                            title={controls.muted ? "Unmute" : "Mute"}
                            aria-label={controls.muted ? "Unmute" : "Mute"}
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
                            onClick={(e) => {
                                e.stopPropagation();
                                webrtc.handleEnd();
                            }}
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

    return createPortal(overlayContent, document.body);
}
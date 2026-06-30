import { useEffect, useRef, useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { useGlobalCall } from "../../CallContext";
import { useNotificationPrefs } from "../../NotificationPrefsContext";
import s from "./GlobalIncomingCall.module.css";

const PhoneIcon = ({ size = 18 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    <path
      d="M3.51 5.47a2.5 2.5 0 0 1 3.53 0l1.06 1.06a2.5 2.5 0 0 1 0 3.54l-.53.53a9 9 0 0 0 5.83 5.83l.53-.53a2.5 2.5 0 0 1 3.54 0l1.06 1.06a2.5 2.5 0 0 1 0 3.53l-.87.87a3 3 0 0 1-3.15.73C9.42 20.45 3.55 14.58 1.91 9.49a3 3 0 0 1 .73-3.15l.87-.87z"
      stroke="currentColor"
      strokeWidth="2"
      fill="none"
    />
  </svg>
);

const VideoIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
    <rect
      x="2"
      y="7"
      width="14"
      height="10"
      rx="2"
      stroke="currentColor"
      strokeWidth="2"
    />
    <path
      d="M16 11l6-4v10l-6-4"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

interface DragState {
  startX: number;
  startY: number;
  origRight: number;
  origTop: number;
}

export default function GlobalIncomingCall() {
  const { globalIncomingCall, acceptGlobalCall, rejectGlobalCall } =
    useGlobalCall() as any;
  const { playRingtone } = useNotificationPrefs() as any;
  const navigate = useNavigate();
  const stopRingtoneRef = useRef<(() => void) | null>(null);
  const pipRef = useRef<HTMLDivElement | null>(null);
  const dragState = useRef<DragState | null>(null);
  const notifRef = useRef<Notification | null>(null);
  const [pos, setPos] = useState({ right: 24, top: 80 });

  // Browser notification + desktop window flash for incoming calls
  useEffect(() => {
    if (!globalIncomingCall) {
      // Clear notification and stop flashing when call is dismissed
      if (notifRef.current) {
        notifRef.current.close();
        notifRef.current = null;
      }
      if ((window.electronAPI as any)?.flashFrame)
        (window.electronAPI as any).flashFrame(false);
      return;
    }
    const { callerName, callType, isGroup, groupName } = globalIncomingCall;
    const displayName = isGroup
      ? groupName || "Group Call"
      : callerName || "Unknown";
    const callLabel = callType === "video" ? "Video Call" : "Voice Call";

    // Desktop (Electron): flash taskbar and bring window to front
    if ((window.electronAPI as any)?.isElectron) {
      (window.electronAPI as any).flashFrame(true);
      (window.electronAPI as any).showAndFocus();
    }

    // Web: show browser notification when tab is not focused
    if (
      typeof Notification !== "undefined" &&
      Notification.permission === "granted" &&
      !document.hasFocus()
    ) {
      try {
        const n = new Notification(`Incoming ${callLabel}`, {
          body: `${displayName} is calling...`,
          tag: "workpulse-incoming-call",
          icon: "/icon-192.png",
          requireInteraction: true,
        });
        n.onclick = () => {
          window.focus();
          n.close();
        };
        notifRef.current = n;
      } catch {
        /* notification not available */
      }
    }
    return () => {
      if (notifRef.current) {
        notifRef.current.close();
        notifRef.current = null;
      }
    };
  }, [globalIncomingCall]);

  // Ringtone — uses the user-selected preset / volume / mute toggle from
  // NotificationPrefsContext (see Profile menu → Notification Sounds).
  useEffect(() => {
    if (!globalIncomingCall) return;
    stopRingtoneRef.current = playRingtone();
    return () => {
      if (stopRingtoneRef.current) {
        try {
          stopRingtoneRef.current();
        } catch {
          /* ignore */
        }
        stopRingtoneRef.current = null;
      }
    };
  }, [globalIncomingCall, playRingtone]);

  // Dragging
  useEffect(() => {
    if (!globalIncomingCall) return;
    const onMove = (e: MouseEvent | TouchEvent) => {
      if (!dragState.current) return;
      e.preventDefault();
      const clientX = "touches" in e ? e.touches[0].clientX : e.clientX;
      const clientY = "touches" in e ? e.touches[0].clientY : e.clientY;
      const dx = clientX - dragState.current.startX;
      const dy = clientY - dragState.current.startY;
      setPos({
        right: Math.max(0, dragState.current.origRight - dx),
        top: Math.max(0, dragState.current.origTop + dy),
      });
    };
    const onUp = () => {
      dragState.current = null;
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    window.addEventListener("touchmove", onMove, { passive: false });
    window.addEventListener("touchend", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      window.removeEventListener("touchmove", onMove);
      window.removeEventListener("touchend", onUp);
    };
  }, [globalIncomingCall]);

  const onDragStart = useCallback(
    (e: React.MouseEvent | React.TouchEvent) => {
      if ((e.target as HTMLElement).closest("button")) return;
      const clientX = "touches" in e ? e.touches[0].clientX : e.clientX;
      const clientY = "touches" in e ? e.touches[0].clientY : e.clientY;
      dragState.current = {
        startX: clientX,
        startY: clientY,
        origRight: pos.right,
        origTop: pos.top,
      };
    },
    [pos],
  );

  if (!globalIncomingCall) return null;

  const { callerName, callerAvatar, callType, isGroup, groupName, meetingCode } =
    globalIncomingCall;
  const displayName = isGroup
    ? groupName || "Group Call"
    : callerName || "Unknown";
  const initial = displayName.charAt(0).toUpperCase();
  const avatarUrl = callerAvatar || null;

  const handleAccept = () => {
    // Group CALL (huddle): auto-join the n-way mesh via /huddle/<code> — NO
    // meeting lobby/pre-screen ("Join meeting" was the bug). It joins audio-only
    // for a voice call and drops straight into the in-call room. The 1:1 path
    // stays on /chat where the CallOverlay picks up the pending-accepted p2p call.
    if (meetingCode) {
      acceptGlobalCall();
      navigate(`/huddle/${meetingCode}`);
      return;
    }
    acceptGlobalCall();
    navigate("/chat");
  };

  const handleReject = () => {
    rejectGlobalCall();
  };

  return (
    <div
      ref={pipRef}
      className={s.pip}
      style={{ right: pos.right, top: pos.top }}
      onMouseDown={onDragStart}
      onTouchStart={onDragStart}
    >
      {/* Animated call bar at top */}
      <div className={s.callBar}>
        <span className={s.pulseRing} />
        <span className={s.callLabel}>
          {callType === "video" ? "Video Call" : "Voice Call"}
        </span>
      </div>

      {/* Caller info */}
      <div className={s.callerInfo}>
        {avatarUrl ? (
          <img src={avatarUrl} alt={displayName} className={s.avatar} />
        ) : (
          <div className={s.avatarPlaceholder}>{initial}</div>
        )}
        <div className={s.callerText}>
          <span className={s.callerName}>{displayName}</span>
          <span className={s.callerStatus}>Incoming call…</span>
        </div>
      </div>

      {/* Accept / Reject */}
      <div className={s.actions}>
        <button
          className={`${s.btn} ${s.rejectBtn}`}
          onClick={handleReject}
          title="Decline"
        >
          <PhoneIcon />
        </button>
        <button
          className={`${s.btn} ${s.acceptBtn}`}
          onClick={handleAccept}
          title="Accept"
        >
          {callType === "video" ? <VideoIcon /> : <PhoneIcon />}
        </button>
      </div>
    </div>
  );
}

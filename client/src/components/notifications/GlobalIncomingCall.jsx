import { useEffect, useRef, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useGlobalCall } from '../../CallContext';
import s from './GlobalIncomingCall.module.css';

const PhoneIcon = ({ size = 18 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    <path d="M3.51 5.47a2.5 2.5 0 0 1 3.53 0l1.06 1.06a2.5 2.5 0 0 1 0 3.54l-.53.53a9 9 0 0 0 5.83 5.83l.53-.53a2.5 2.5 0 0 1 3.54 0l1.06 1.06a2.5 2.5 0 0 1 0 3.53l-.87.87a3 3 0 0 1-3.15.73C9.42 20.45 3.55 14.58 1.91 9.49a3 3 0 0 1 .73-3.15l.87-.87z" stroke="currentColor" strokeWidth="2" fill="none" />
  </svg>
);

const VideoIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
    <rect x="2" y="7" width="14" height="10" rx="2" stroke="currentColor" strokeWidth="2" />
    <path d="M16 11l6-4v10l-6-4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export default function GlobalIncomingCall() {
  const { globalIncomingCall, acceptGlobalCall, rejectGlobalCall } = useGlobalCall();
  const navigate = useNavigate();
  const ringtoneRef = useRef(null);
  const pipRef = useRef(null);
  const dragState = useRef(null);
  const notifRef = useRef(null);
  const [pos, setPos] = useState({ right: 24, top: 80 });

  // Browser notification + desktop window flash for incoming calls
  useEffect(() => {
    if (!globalIncomingCall) {
      // Clear notification and stop flashing when call is dismissed
      if (notifRef.current) { notifRef.current.close(); notifRef.current = null; }
      if (window.electronAPI?.flashFrame) window.electronAPI.flashFrame(false);
      return;
    }
    const { callerName, callType, isGroup, groupName } = globalIncomingCall;
    const displayName = isGroup ? (groupName || 'Group Call') : (callerName || 'Unknown');
    const callLabel = callType === 'video' ? 'Video Call' : 'Voice Call';

    // Desktop (Electron): flash taskbar and bring window to front
    if (window.electronAPI?.isElectron) {
      window.electronAPI.flashFrame(true);
      window.electronAPI.showAndFocus();
    }

    // Web: show browser notification when tab is not focused
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted' && !document.hasFocus()) {
      try {
        const n = new Notification(`Incoming ${callLabel}`, {
          body: `${displayName} is calling...`,
          tag: 'workpulse-incoming-call',
          icon: '/icon-192.svg',
          requireInteraction: true,
        });
        n.onclick = () => {
          window.focus();
          n.close();
        };
        notifRef.current = n;
      } catch { /* notification not available */ }
    }
    return () => {
      if (notifRef.current) { notifRef.current.close(); notifRef.current = null; }
    };
  }, [globalIncomingCall]);

  // Ringtone
  useEffect(() => {
    if (!globalIncomingCall) return;
    let pulseTimer = null;
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.frequency.value = 440;
      gain.gain.value = 0.1;
      osc.start();
      ringtoneRef.current = { ctx, osc, gain };
      const pulse = () => {
        if (!ringtoneRef.current) return;
        gain.gain.setValueAtTime(0.1, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.5);
        pulseTimer = setTimeout(pulse, 1000);
      };
      pulse();
    } catch { /* audio not available */ }
    return () => {
      clearTimeout(pulseTimer);
      if (ringtoneRef.current) {
        try { ringtoneRef.current.osc.stop(); ringtoneRef.current.ctx.close(); } catch {}
        ringtoneRef.current = null;
      }
    };
  }, [globalIncomingCall]);

  // Dragging
  useEffect(() => {
    if (!globalIncomingCall) return;
    const onMove = (e) => {
      if (!dragState.current) return;
      e.preventDefault();
      const clientX = e.touches ? e.touches[0].clientX : e.clientX;
      const clientY = e.touches ? e.touches[0].clientY : e.clientY;
      const dx = clientX - dragState.current.startX;
      const dy = clientY - dragState.current.startY;
      setPos({
        right: Math.max(0, dragState.current.origRight - dx),
        top: Math.max(0, dragState.current.origTop + dy),
      });
    };
    const onUp = () => { dragState.current = null; };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    window.addEventListener('touchmove', onMove, { passive: false });
    window.addEventListener('touchend', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      window.removeEventListener('touchmove', onMove);
      window.removeEventListener('touchend', onUp);
    };
  }, [globalIncomingCall]);

  const onDragStart = useCallback((e) => {
    if (e.target.closest('button')) return;
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    dragState.current = {
      startX: clientX,
      startY: clientY,
      origRight: pos.right,
      origTop: pos.top,
    };
  }, [pos]);

  if (!globalIncomingCall) return null;

  const { callerName, callerAvatar, callType, isGroup, groupName } = globalIncomingCall;
  const displayName = isGroup ? (groupName || 'Group Call') : (callerName || 'Unknown');
  const initial = displayName.charAt(0).toUpperCase();
  const avatarUrl = callerAvatar || null;

  const handleAccept = () => {
    acceptGlobalCall();
    navigate('/chat');
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
          {callType === 'video' ? 'Video Call' : 'Voice Call'}
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
        <button className={`${s.btn} ${s.rejectBtn}`} onClick={handleReject} title="Decline">
          <PhoneIcon />
        </button>
        <button className={`${s.btn} ${s.acceptBtn}`} onClick={handleAccept} title="Accept">
          {callType === 'video' ? <VideoIcon /> : <PhoneIcon />}
        </button>
      </div>
    </div>
  );
}

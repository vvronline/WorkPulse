import { useEffect, useRef, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import useWebSocket from '../../hooks/useWebSocket';
import s from './GlobalMeetingNotification.module.css';

/**
 * Teams-like floating notification card that appears when a meeting starts.
 * Shows meeting title, organizer name, and join/dismiss buttons.
 * Draggable, auto-dismisses after 60 seconds.
 */
export default function GlobalMeetingNotification() {
    const [notification, setNotification] = useState(null);
    const navigate = useNavigate();
    const pipRef = useRef(null);
    const dragState = useRef(null);
    const autoDismissRef = useRef(null);
    const [pos, setPos] = useState({ right: 24, top: 80 });

    // Listen for meeting_started WS events
    useWebSocket(useCallback((msg) => {
        if (msg.type === 'meeting_started' && msg.data) {
            setNotification(msg.data);
            setPos({ right: 24, top: 80 });
        }
    }, []));

    // Auto-dismiss after 60 seconds
    useEffect(() => {
        if (!notification) return;
        autoDismissRef.current = setTimeout(() => setNotification(null), 60000);
        return () => clearTimeout(autoDismissRef.current);
    }, [notification]);

    // Browser notification when tab is not focused
    useEffect(() => {
        if (!notification) return;
        if (typeof Notification !== 'undefined' && Notification.permission === 'granted' && !document.hasFocus()) {
            try {
                const n = new Notification('Meeting Started', {
                    body: `${notification.organizerName} started "${notification.title}"`,
                    tag: 'workpulse-meeting-started',
                    icon: '/icon-192.svg',
                });
                n.onclick = () => { window.focus(); n.close(); };
            } catch { /* not available */ }
        }
    }, [notification]);

    // Dragging
    useEffect(() => {
        if (!notification) return;
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
    }, [notification]);

    const onDragStart = (e) => {
        if (e.target.closest('button')) return;
        const clientX = e.touches ? e.touches[0].clientX : e.clientX;
        const clientY = e.touches ? e.touches[0].clientY : e.clientY;
        dragState.current = {
            startX: clientX,
            startY: clientY,
            origRight: pos.right,
            origTop: pos.top,
        };
    };

    const handleJoin = () => {
        const code = notification.meetingCode;
        setNotification(null);
        navigate(`/meeting/${code}`);
    };

    const handleDismiss = () => {
        setNotification(null);
    };

    if (!notification) return null;

    return (
        <div
            ref={pipRef}
            className={s.card}
            style={{ right: pos.right, top: pos.top }}
            onMouseDown={onDragStart}
            onTouchStart={onDragStart}
        >
            <div className={s.topBar}>
                <span className={s.pulseRing} />
                <span className={s.topLabel}>Meeting Started</span>
                <button className={s.dismissBtn} onClick={handleDismiss} title="Dismiss">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                        <path d="M18 6L6 18M6 6l12 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                    </svg>
                </button>
            </div>
            <div className={s.meetInfo}>
                <h3 className={s.meetTitle}>{notification.title || 'Meeting'}</h3>
                <p className={s.meetHost}>{notification.organizerName} started this meeting</p>
            </div>
            <div className={s.actions}>
                <button className={s.joinBtn} onClick={handleJoin}>Join now</button>
                <button className={s.declineBtn} onClick={handleDismiss}>Dismiss</button>
            </div>
        </div>
    );
}

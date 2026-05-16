import { useEffect, useRef, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import useWebSocket from '../../hooks/useWebSocket';
import s from './GlobalMeetingNotification.module.css';

/**
 * Teams-like floating notification card that appears when a meeting starts.
 * Shows meeting title, organizer name, and join/dismiss buttons.
 * Listens for 'meeting_started' WS events directly AND via custom DOM events
 * dispatched by NotificationBell (redundancy for reliability).
 * Auto-dismisses after 60 seconds.
 */
export default function GlobalMeetingNotification() {
    const [notification, setNotification] = useState(null);
    const navigate = useNavigate();
    const autoDismissRef = useRef(null);

    // Direct WS listener — works regardless of whether Navbar/NotificationBell is mounted
    useWebSocket(useCallback((msg) => {
        if (msg.type === 'meeting_started' && msg.data) {
            setNotification(msg.data);
        }
    }, []));

    // Also listen for meeting_started custom events from NotificationBell (redundancy)
    useEffect(() => {
        const handler = (e) => {
            if (e.detail) {
                setNotification(e.detail);
            }
        };
        window.addEventListener('meeting_started', handler);
        return () => window.removeEventListener('meeting_started', handler);
    }, []);

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
        <div className={s.card}>
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

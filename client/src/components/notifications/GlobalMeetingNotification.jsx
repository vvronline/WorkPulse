import { useEffect, useRef, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import useWebSocket from '../../hooks/useWebSocket';
import { useMeeting } from '../../MeetingContext';
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
    const shownMeetingRef = useRef(null); // dedup: track which meetingId is currently shown
    const { session } = useMeeting() || {};
    const activeMeetingIdRef = useRef(null);
    activeMeetingIdRef.current = session?.meetingId ?? null;

    const showNotification = useCallback((data) => {
        if (!data || !data.meetingId) return;
        // Suppress the "Meeting Started/Restarted" card entirely when the
        // current user is ALREADY in this meeting (e.g. they just joined
        // and the server is broadcasting the start event to all invitees,
        // or another participant joined later and the server is re-emitting
        // the started event). Without this guard the card kept popping
        // back up on top of the in-meeting UI even after joining.
        if (activeMeetingIdRef.current === data.meetingId) return;
        // Deduplicate: if already showing this meeting's card, skip (unless it's a restart)
        if (shownMeetingRef.current === data.meetingId && !data.restarted) return;
        shownMeetingRef.current = data.meetingId;
        setNotification(data);
    }, []);

    // If the user joins the meeting that's currently shown in the card,
    // immediately dismiss the card so we don't have a stale invite floating
    // over the meeting room.
    useEffect(() => {
        if (session?.meetingId && notification?.meetingId === session.meetingId) {
            shownMeetingRef.current = null;
            setNotification(null);
        }
    }, [session?.meetingId, notification?.meetingId]);

    // Direct WS listener — works regardless of whether Navbar/NotificationBell is mounted
    useWebSocket(useCallback((msg) => {
        if (msg.type === 'meeting_started' && msg.data) {
            showNotification(msg.data);
        }
    }, [showNotification]));

    // Also listen for meeting_started custom events from CallContext/NotificationBell
    useEffect(() => {
        const handler = (e) => {
            if (e.detail) {
                showNotification(e.detail);
            }
        };
        window.addEventListener('meeting_started', handler);
        return () => window.removeEventListener('meeting_started', handler);
    }, [showNotification]);

    // Auto-dismiss after 60 seconds
    useEffect(() => {
        if (!notification) return;
        autoDismissRef.current = setTimeout(() => {
            shownMeetingRef.current = null;
            setNotification(null);
        }, 60000);
        return () => clearTimeout(autoDismissRef.current);
    }, [notification]);

    // Browser notification when tab is not focused
    useEffect(() => {
        if (!notification) return;
        if (typeof Notification !== 'undefined' && Notification.permission === 'granted' && !document.hasFocus()) {
            try {
                const label = notification.restarted ? 'Meeting Restarted' : 'Meeting Started';
                const verb = notification.restarted ? 'restarted' : 'started';
                const n = new Notification(label, {
                    body: `${notification.organizerName} ${verb} "${notification.title}"`,
                    tag: 'workpulse-meeting-started',
                    icon: '/icon-192.svg',
                });
                n.onclick = () => { window.focus(); n.close(); };
            } catch { /* not available */ }
        }
    }, [notification]);

    const handleJoin = () => {
        const code = notification.meetingCode;
        shownMeetingRef.current = null;
        setNotification(null);
        navigate(`/meeting/${code}`);
    };

    const handleDismiss = () => {
        shownMeetingRef.current = null;
        setNotification(null);
    };

    if (!notification) return null;

    return (
        <div className={s.card}>
            <div className={s.topBar}>
                <span className={s.pulseRing} />
                <span className={s.topLabel}>{notification.restarted ? 'Meeting Restarted' : 'Meeting Started'}</span>
                <button className={s.dismissBtn} onClick={handleDismiss} title="Dismiss">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                        <path d="M18 6L6 18M6 6l12 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                    </svg>
                </button>
            </div>
            <div className={s.meetInfo}>
                <h3 className={s.meetTitle}>{notification.title || 'Meeting'}</h3>
                <p className={s.meetHost}>{notification.organizerName} {notification.restarted ? 'restarted' : 'started'} this meeting</p>
            </div>
            <div className={s.actions}>
                <button className={s.joinBtn} onClick={handleJoin}>Join now</button>
                <button className={s.declineBtn} onClick={handleDismiss}>Dismiss</button>
            </div>
        </div>
    );
}

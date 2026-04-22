import React, { createContext, useContext, useState, useRef, useCallback, useEffect, useMemo } from 'react';
import { useUserStatus } from './UserStatusContext';

const MeetingCtx = createContext(null);

export function useMeeting() {
    return useContext(MeetingCtx);
}

/**
 * Global meeting provider — keeps an active meeting alive across page navigations.
 * The WebSocket, local media stream, peer connections, and state survive route changes.
 * When the user navigates away from the meeting room, a PiP overlay is shown.
 */
export function MeetingProvider({ children }) {
    // Active meeting session state
    const [session, setSession] = useState(null);
    // session shape: { meetingId, code, meeting, initialMuted, initialVideoOff }

    const wsRef = useRef(null);
    const localStreamRef = useRef(null);

    const leaveMeetingRef = useRef(null);

    const { setAutoStatus, clearAutoStatus } = useUserStatus();
    const meetingStatusRef = useRef(false);

    // Auto-status: set "in_meeting" when session is active
    useEffect(() => {
        if (session) {
            meetingStatusRef.current = true;
            setAutoStatus('in_meeting');
        } else if (meetingStatusRef.current) {
            meetingStatusRef.current = false;
            clearAutoStatus('in_meeting');
        }
    }, [session, setAutoStatus, clearAutoStatus]);

    const joinMeeting = useCallback(({ meetingId, code, meeting, initialMuted, initialVideoOff }) => {
        // If we already have a WS for this meeting, reuse it
        if (wsRef.current && wsRef.current.readyState <= 1) {
            setSession(prev => prev?.meetingId === meetingId ? prev : {
                meetingId, code, meeting,
                initialMuted: initialMuted ?? false,
                initialVideoOff: initialVideoOff ?? false,
            });
            return;
        }

        // Close stale WebSocket before creating a new one
        if (wsRef.current) {
            try { wsRef.current.close(); } catch { /* ignore */ }
            wsRef.current = null;
        }

        // Create WebSocket for this meeting session
        let wsUrl;
        if (import.meta.env.VITE_WS_URL) {
            wsUrl = import.meta.env.VITE_WS_URL;
        } else {
            const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
            const host = import.meta.env.PROD ? window.location.host : `${window.location.hostname}:${import.meta.env.VITE_API_PORT || '5000'}`;
            wsUrl = `${proto}://${host}/ws`;
        }
        const ws = new WebSocket(wsUrl);
        wsRef.current = ws;

        ws.addEventListener('error', () => {
            console.warn('Meeting WebSocket connection error');
        });

        // Listen for meeting_ended while in PiP / away from room
        ws.addEventListener('message', (e) => {
            try {
                const msg = JSON.parse(e.data);
                if (msg.type === 'meeting_ended') {
                    if (leaveMeetingRef.current) leaveMeetingRef.current();
                }
            } catch { /* ignore */ }
        });

        setSession({
            meetingId, code, meeting,
            initialMuted: initialMuted ?? false,
            initialVideoOff: initialVideoOff ?? false,
        });
    }, []);

    const leaveMeeting = useCallback(() => {
        if (wsRef.current) {
            wsRef.current.close();
            wsRef.current = null;
        }
        if (localStreamRef.current) {
            localStreamRef.current.getTracks().forEach(t => t.stop());
            localStreamRef.current = null;
        }
        setSession(null);
    }, []);

    leaveMeetingRef.current = leaveMeeting;

    // Store ref to localStream so PiP can access it
    const setLocalStream = useCallback((stream) => {
        localStreamRef.current = stream;
    }, []);

    // Cleanup on unmount
    useEffect(() => {
        return () => {
            if (wsRef.current) wsRef.current.close();
            if (localStreamRef.current) localStreamRef.current.getTracks().forEach(t => t.stop());
        };
    }, []);

    const value = useMemo(() => ({
        session,
        joinMeeting,
        leaveMeeting,
        setLocalStream,
        localStreamRef,
        wsRef,
    }), [session, joinMeeting, leaveMeeting, setLocalStream]);

    return (
        <MeetingCtx.Provider value={value}>
            {children}
        </MeetingCtx.Provider>
    );
}

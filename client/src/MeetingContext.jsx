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

    // When true, the meeting room UI is hidden (display:none) and the PiP
    // floating widget takes over. The MeetingRoom component STAYS MOUNTED
    // so peer connections, participants Map, etc. survive minimize/maximize.
    const [minimized, setMinimized] = useState(false);

    const wsRef = useRef(null);
    const [ws, setWs] = useState(null);
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
            setWs(null);
        }

        // Create WebSocket for this meeting session
        let wsUrl;
        if (import.meta.env.VITE_WS_URL) {
            wsUrl = import.meta.env.VITE_WS_URL;
        } else {
            const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
            const host = window.location.host;
            wsUrl = `${proto}://${host}/ws`;
        }

        let reconnectAttempts = 0;
        const maxReconnects = 5;

        const createWs = () => {
            const newWs = new WebSocket(wsUrl);
            wsRef.current = newWs;
            setWs(newWs);

            newWs.addEventListener('open', () => {
                reconnectAttempts = 0;
            });

            newWs.addEventListener('error', () => {
                console.warn('Meeting WebSocket connection error');
            });

            newWs.addEventListener('close', (e) => {
                if (e.code === 4001 || e.code === 4029) return;
                if (reconnectAttempts < maxReconnects && wsRef.current === newWs) {
                    reconnectAttempts++;
                    const delay = Math.min(1000 * Math.pow(2, reconnectAttempts - 1), 10000);
                    setTimeout(() => {
                        if (wsRef.current === newWs || wsRef.current === null) {
                            createWs();
                        }
                    }, delay);
                }
            });

            // Listen for meeting_ended while in PiP / away from room
            newWs.addEventListener('message', (e) => {
                try {
                    const msg = JSON.parse(e.data);
                    if (msg.type === 'meeting_ended') {
                        if (leaveMeetingRef.current) leaveMeetingRef.current();
                    }
                } catch { /* ignore */ }
            });
        };

        createWs();

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
        setWs(null);
        if (localStreamRef.current) {
            localStreamRef.current.getTracks().forEach(t => t.stop());
            localStreamRef.current = null;
        }
        setSession(null);
        setMinimized(false);
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
        ws,
        minimized,
        setMinimized,
        joinMeeting,
        leaveMeeting,
        setLocalStream,
        localStreamRef,
        wsRef,
    }), [session, ws, minimized, joinMeeting, leaveMeeting, setLocalStream]);

    return (
        <MeetingCtx.Provider value={value}>
            {children}
        </MeetingCtx.Provider>
    );
}

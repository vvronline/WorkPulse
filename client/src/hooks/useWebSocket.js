import { useEffect, useRef, useCallback, useState } from 'react';

/**
 * Hook that maintains a WebSocket connection for real-time updates.
 * Reconnects automatically on disconnect. Auth is via HttpOnly cookie.
 */
export default function useWebSocket(onMessage) {
    const wsRef = useRef(null);
    const reconnectTimer = useRef(null);
    const connectingRef = useRef(false);
    const [connected, setConnected] = useState(false);
    const onMessageRef = useRef(onMessage);
    onMessageRef.current = onMessage;

    const connect = useCallback(() => {
        // Prevent duplicate connections: skip if already open, connecting, or a connect is in-flight
        if (connectingRef.current) return;
        if (wsRef.current && wsRef.current.readyState <= 1) return;
        connectingRef.current = true;

        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const host = import.meta.env.PROD ? window.location.host : 'localhost:5000';
        const ws = new WebSocket(`${protocol}//${host}/ws`);

        ws.onopen = () => {
            connectingRef.current = false;
            setConnected(true);
        };

        ws.onmessage = (event) => {
            try {
                const msg = JSON.parse(event.data);
                if (onMessageRef.current) onMessageRef.current(msg);
            } catch { /* ignore non-JSON */ }
        };

        ws.onclose = (e) => {
            connectingRef.current = false;
            setConnected(false);
            wsRef.current = null;
            // Reconnect after 3s unless auth failure
            if (e.code !== 4001) {
                reconnectTimer.current = setTimeout(connect, 3000);
            }
        };

        ws.onerror = () => {
            ws.close();
        };

        wsRef.current = ws;
    }, []);

    const sendMessage = useCallback((type, data) => {
        if (wsRef.current && wsRef.current.readyState === 1) {
            wsRef.current.send(JSON.stringify({ type, data }));
        }
    }, []);

    useEffect(() => {
        connect();
        return () => {
            clearTimeout(reconnectTimer.current);
            if (wsRef.current) {
                wsRef.current.onclose = null; // prevent reconnect on unmount
                wsRef.current.close();
            }
        };
    }, [connect]);

    return { connected, sendMessage };
}

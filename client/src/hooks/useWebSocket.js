import { useEffect, useRef, useCallback, useState } from 'react';

/** Bound the outbound queue so a long offline stretch can't grow unboundedly. */
const MAX_QUEUED_MESSAGES = 100;

/**
 * Hook that maintains a WebSocket connection for real-time updates.
 * Reconnects automatically on disconnect. Auth is via HttpOnly cookie.
 * Queues outbound messages while disconnected and flushes on reconnect.
 */
export default function useWebSocket(onMessage) {
    const wsRef = useRef(null);
    const reconnectTimer = useRef(null);
    const connectingRef = useRef(false);
    const [connected, setConnected] = useState(false);
    const onMessageRef = useRef(onMessage);
    onMessageRef.current = onMessage;
    const queueRef = useRef([]);

    const flushQueue = useCallback(() => {
        if (!wsRef.current || wsRef.current.readyState !== 1) return;
        const pending = queueRef.current.splice(0);
        for (const msg of pending) {
            wsRef.current.send(msg);
        }
    }, []);

    const connect = useCallback(() => {
        // Prevent duplicate connections: skip if already open, connecting, or a connect is in-flight
        if (connectingRef.current) return;
        if (wsRef.current && wsRef.current.readyState <= 1) return;
        connectingRef.current = true;

        let wsUrl;
        if (import.meta.env.VITE_WS_URL) {
            wsUrl = import.meta.env.VITE_WS_URL;
        } else {
            const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
            const host = window.location.host;
            wsUrl = `${protocol}//${host}/ws`;
        }
        const ws = new WebSocket(wsUrl);

        ws.onopen = () => {
            connectingRef.current = false;
            setConnected(true);
            flushQueue();
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
            // Reconnect after a delay unless auth failure or too-many-connections
            if (e.code !== 4001 && e.code !== 4029) {
                reconnectTimer.current = setTimeout(connect, 3000);
            }
        };

        ws.onerror = () => {
            ws.close();
        };

        wsRef.current = ws;
    }, [flushQueue]);

    const sendMessage = useCallback((type, data) => {
        const msg = JSON.stringify({ type, data });
        if (wsRef.current && wsRef.current.readyState === 1) {
            wsRef.current.send(msg);
        } else {
            // Queue the message to send on reconnect, but cap the queue so
            // a long disconnect (e.g. laptop closed for hours) doesn't grow
            // memory unboundedly. Drop oldest first — newer messages are
            // almost always more relevant (e.g. typing indicators, ping).
            if (queueRef.current.length >= MAX_QUEUED_MESSAGES) {
                queueRef.current.shift();
            }
            queueRef.current.push(msg);
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

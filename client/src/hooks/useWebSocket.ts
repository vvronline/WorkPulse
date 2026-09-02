import { useEffect, useRef, useCallback, useState } from "react";

/** Bound the outbound queue so a long offline stretch can't grow unboundedly. */
const MAX_QUEUED_MESSAGES = 100;

/** Heartbeat: how often the client sends a ping while the socket is open. */
const HEARTBEAT_INTERVAL_MS = 25_000;
/** If no frame (pong or any message) arrives within this window after a ping,
 *  treat the socket as dead and force a reconnect. After laptop sleep/wake or a
 *  network blip a socket can look "open" but be silently dead — without this the
 *  client would keep believing it's connected and miss every live update. */
const HEARTBEAT_TIMEOUT_MS = 10_000;

/** Reconnect backoff bounds. We start fast (so a transient blip recovers almost
 *  instantly) and back off up to a cap so a downed server isn't hammered. */
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 15_000;

/** Retry persisted chat frames when their correlated server echo was lost. */
const CHAT_ACK_RETRY_MS = 10_000;
const CHAT_MAX_SEND_ATTEMPTS = 6;

interface ReliableOutbound {
  clientMsgId: string;
  serialized: string;
  lastSentAt: number;
  attempts: number;
}

export interface WebSocketMessage {
  type: string;
  data?: AnyData;
  [key: string]: unknown;
}

type AnyData = Record<string, unknown> | unknown;
type OnMessage = ((msg: WebSocketMessage) => void) | null;

/**
 * Hook that maintains a WebSocket connection for real-time updates.
 * Reconnects automatically on disconnect. Auth is via HttpOnly cookie.
 * Queues outbound messages while disconnected and flushes on reconnect.
 *
 * Reliability features (important for the desktop app, which spends long
 * stretches minimized to the tray and survives laptop sleep/wake):
 *   • Client heartbeat detects dead-but-"open" sockets and reconnects.
 *   • Exponential backoff with jitter on reconnect.
 *   • Immediate reconnect when the app regains focus / comes back online /
 *     becomes visible (web + Electron `window-shown`).
 */
export default function useWebSocket(onMessage: OnMessage) {
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const connectingRef = useRef(false);
  const [connected, setConnected] = useState(false);
  const onMessageRef = useRef<OnMessage>(onMessage);
  onMessageRef.current = onMessage;
  const queueRef = useRef<string[]>([]);
  // Chat messages need stronger semantics than transient events: retain each
  // frame until the server echoes its clientMsgId (or explicitly rejects it).
  const reliableChatRef = useRef<Map<string, ReliableOutbound>>(new Map());
  const ackRetryTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  // Backoff state: number of consecutive failed/closed attempts.
  const retryCountRef = useRef(0);
  // Heartbeat timers.
  const heartbeatTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const heartbeatTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  const sendReliable = useCallback((item: ReliableOutbound) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    try {
      ws.send(item.serialized);
      item.lastSentAt = Date.now();
      item.attempts += 1;
      return true;
    } catch {
      // Keep the item in reliableChatRef. Closing starts reconnect and
      // the next socket will safely retry the same idempotency key.
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      return false;
    }
  }, []);

  const flushReliable = useCallback(() => {
    for (const item of reliableChatRef.current.values()) {
      if (!sendReliable(item)) break;
    }
  }, [sendReliable]);

  const flushQueue = useCallback(() => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    // Remove a transient frame only after send succeeds. This avoids losing
    // the rest of the queue if the socket dies midway through a flush.
    while (queueRef.current.length > 0 && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(queueRef.current[0]);
        queueRef.current.shift();
      } catch {
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        break;
      }
    }
  }, []);

  const stopAckRetry = useCallback(() => {
    if (ackRetryTimer.current) clearInterval(ackRetryTimer.current);
    ackRetryTimer.current = null;
  }, []);

  const startAckRetry = useCallback(() => {
    stopAckRetry();
    ackRetryTimer.current = setInterval(() => {
      const now = Date.now();
      for (const item of reliableChatRef.current.values()) {
        if (
          item.lastSentAt !== 0 &&
          now - item.lastSentAt < CHAT_ACK_RETRY_MS
        ) {
          continue;
        }

        if (item.attempts >= CHAT_MAX_SEND_ATTEMPTS) {
          reliableChatRef.current.delete(item.clientMsgId);
          onMessageRef.current?.({
            type: "chat_message_error",
            data: {
              clientMsgId: item.clientMsgId,
              reason: "Message delivery was not acknowledged. Tap to retry.",
            },
          });
          continue;
        }

        if (!sendReliable(item)) break;
      }
    }, CHAT_ACK_RETRY_MS);
  }, [sendReliable, stopAckRetry]);

  const stopHeartbeat = useCallback(() => {
    if (heartbeatTimer.current) clearInterval(heartbeatTimer.current);
    if (heartbeatTimeout.current) clearTimeout(heartbeatTimeout.current);
    heartbeatTimer.current = null;
    heartbeatTimeout.current = null;
  }, []);

  const startHeartbeat = useCallback(() => {
    stopHeartbeat();
    heartbeatTimer.current = setInterval(() => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== 1) return;
      try {
        ws.send(JSON.stringify({ type: "ping" }));
      } catch {
        /* send can throw if the socket died mid-flight */
      }
      // Arm a watchdog: if nothing arrives before it fires, the socket is
      // dead. Any inbound frame (see onmessage) clears it.
      if (heartbeatTimeout.current) clearTimeout(heartbeatTimeout.current);
      heartbeatTimeout.current = setTimeout(() => {
        if (wsRef.current) {
          // Force-close; onclose will schedule a reconnect.
          try {
            wsRef.current.close();
          } catch {
            /* ignore */
          }
        }
      }, HEARTBEAT_TIMEOUT_MS);
    }, HEARTBEAT_INTERVAL_MS);
  }, [stopHeartbeat]);

  const connect = useCallback(() => {
    // Prevent duplicate connections: skip if already open, connecting, or a connect is in-flight
    if (connectingRef.current) return;
    if (wsRef.current && wsRef.current.readyState <= 1) return;
    connectingRef.current = true;
    // A new connect attempt supersedes any pending reconnect timer.
    if (reconnectTimer.current) clearTimeout(reconnectTimer.current);

    let wsUrl: string;
    if (import.meta.env.VITE_WS_URL) {
      wsUrl = import.meta.env.VITE_WS_URL;
    } else {
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const host = window.location.host;
      wsUrl = `${protocol}//${host}/ws`;
    }
    const ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      connectingRef.current = false;
      retryCountRef.current = 0; // reset backoff on a successful open
      setConnected(true);
      // Reliable chat goes first so user-authored messages are not held
      // behind transient typing/presence traffic accumulated offline.
      flushReliable();
      flushQueue();
      startAckRetry();
      startHeartbeat();
    };

    ws.onmessage = (event) => {
      // Any inbound frame proves the socket is alive — clear the
      // heartbeat watchdog so a healthy-but-quiet connection isn't
      // torn down.
      if (heartbeatTimeout.current) clearTimeout(heartbeatTimeout.current);
      try {
        const msg = JSON.parse(event.data);
        // Server may answer our ping with a pong; swallow it.
        if (msg && msg.type === "pong") return;

        // A chat echo confirms persistence; an error confirms terminal
        // rejection. Either response ends automatic retry for this ID.
        if (
          msg &&
          (msg.type === "chat_message" || msg.type === "chat_message_error") &&
          typeof msg.data?.clientMsgId === "string"
        ) {
          reliableChatRef.current.delete(msg.data.clientMsgId);
        }

        if (onMessageRef.current) onMessageRef.current(msg);
      } catch {
        /* ignore non-JSON */
      }
    };

    ws.onclose = (e) => {
      connectingRef.current = false;
      setConnected(false);
      wsRef.current = null;
      stopAckRetry();
      stopHeartbeat();
      // Reconnect after a delay unless auth failure or too-many-connections
      if (e.code !== 4001 && e.code !== 4029) {
        const attempt = retryCountRef.current++;
        // Exponential backoff with full jitter, capped.
        const ceiling = Math.min(
          RECONNECT_MAX_MS,
          RECONNECT_BASE_MS * 2 ** attempt,
        );
        const delay = Math.round(Math.random() * ceiling);
        reconnectTimer.current = setTimeout(connect, delay);
      }
    };

    ws.onerror = () => {
      ws.close();
    };

    wsRef.current = ws;
  }, [
    flushQueue,
    flushReliable,
    startAckRetry,
    startHeartbeat,
    stopAckRetry,
    stopHeartbeat,
  ]);

  // Force an immediate reconnect (used on focus / online / visibility). If the
  // socket is already open this is a no-op; otherwise we reset the backoff so
  // the user doesn't wait out a long timer after returning to the app.
  const reconnectNow = useCallback(() => {
    const ws = wsRef.current;
    if (ws && ws.readyState === 1) return; // already healthy
    retryCountRef.current = 0;
    if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
    connect();
  }, [connect]);

  // Force a HARD reconnect — unconditionally close the current socket (even if
  // healthy) and immediately open a fresh one. Used when the authenticated
  // identity changes (login / logout). Unlike `reconnectNow`, this does NOT
  // short-circuit on an already-open socket: the whole point is to drop the
  // socket that is still registered server-side under the PREVIOUS user.
  const hardReconnect = useCallback(() => {
    retryCountRef.current = 0;
    if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
    const ws = wsRef.current;
    if (ws) {
      // Detach onclose so its auto-reconnect (with backoff) doesn't race
      // our explicit connect() below; we drive the reconnect ourselves.
      ws.onclose = null;
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      wsRef.current = null;
    }
    stopAckRetry();
    stopHeartbeat();
    // Never send one authenticated user's queued data after an account change.
    reliableChatRef.current.clear();
    queueRef.current = [];
    connectingRef.current = false;
    setConnected(false);
    connect();
  }, [connect, stopAckRetry, stopHeartbeat]);

  const sendMessage = useCallback(
    (type: string, data?: AnyData) => {
      const msg = JSON.stringify({ type, data });
      const clientMsgId =
        type === "chat_message" &&
        data &&
        typeof data === "object" &&
        "clientMsgId" in data &&
        typeof data.clientMsgId === "string"
          ? data.clientMsgId
          : null;

      if (clientMsgId) {
        // Re-sending the same client id (manual retry) updates rather
        // than duplicates the retained frame.
        const item: ReliableOutbound = {
          clientMsgId,
          serialized: msg,
          lastSentAt: 0,
          attempts: 0,
        };
        reliableChatRef.current.set(clientMsgId, item);
        sendReliable(item);

        // If transport is unavailable but the browser reports network,
        // begin connecting now rather than waiting for backoff.
        if (
          (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) &&
          navigator.onLine
        ) {
          retryCountRef.current = 0;
          if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
          connect();
        }
        return;
      }

      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(msg);
          return;
        } catch {
          try {
            ws.close();
          } catch {
            /* ignore */
          }
        }
      }

      // Transient messages use the bounded best-effort queue. Reliable
      // chat messages never enter this queue and therefore cannot be
      // evicted by typing indicators or call signalling.
      if (queueRef.current.length >= MAX_QUEUED_MESSAGES) {
        queueRef.current.shift();
      }
      queueRef.current.push(msg);
    },
    [connect, sendReliable],
  );

  useEffect(() => {
    connect();
    return () => {
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      stopAckRetry();
      stopHeartbeat();
      if (wsRef.current) {
        wsRef.current.onclose = null; // prevent reconnect on unmount
        wsRef.current.close();
      }
    };
  }, [connect, stopAckRetry, stopHeartbeat]);

  // Reconnect when a message handler is provided after a 4001 auth rejection.
  // This handles the desktop app case where the WS connects before login
  // (gets 4001, stops retrying), then the user logs in and auth becomes available.
  useEffect(() => {
    if (onMessage && (!wsRef.current || wsRef.current.readyState > 1)) {
      connect();
    }
  }, [onMessage, connect]);

  // Reset the socket whenever the authenticated identity changes (login OR
  // logout). AuthContext dispatches `auth-changed` for both. This is critical
  // for the no-reload desktop app: after "logout then login as a DIFFERENT
  // user" on the same device, the previous user's socket would otherwise stay
  // open and registered server-side as that user — so the new user would, e.g.,
  // see an INCOMING call (routed to the stale previous-user socket) at the same
  // time as their own OUTGOING call. Hard-reconnecting binds the socket to the
  // new user's cookie (or drops it entirely on logout).
  useEffect(() => {
    const onAuthChanged = () => hardReconnect();
    window.addEventListener("auth-changed", onAuthChanged);
    return () => window.removeEventListener("auth-changed", onAuthChanged);
  }, [hardReconnect]);

  // Force an immediate reconnect when the app comes back to the foreground or
  // the network returns. On the desktop app the window is minimized to the
  // tray for long stretches and survives laptop sleep/wake — without these
  // triggers the socket can stay dead (or wait out a backoff timer) so live
  // updates feel laggy when you reopen the app. Listening to focus / online /
  // visibilitychange (web) and the Electron `window-shown` IPC covers every
  // "user is back" path.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") reconnectNow();
    };
    window.addEventListener("focus", reconnectNow);
    window.addEventListener("online", reconnectNow);
    document.addEventListener("visibilitychange", onVisible);

    let unsubscribeWindowShown: (() => void) | null = null;
    if (
      window.electronAPI &&
      typeof window.electronAPI.onWindowShown === "function"
    ) {
      unsubscribeWindowShown = window.electronAPI.onWindowShown(() =>
        reconnectNow(),
      );
    }

    return () => {
      window.removeEventListener("focus", reconnectNow);
      window.removeEventListener("online", reconnectNow);
      document.removeEventListener("visibilitychange", onVisible);
      if (typeof unsubscribeWindowShown === "function")
        unsubscribeWindowShown();
    };
  }, [reconnectNow]);

  return { connected, sendMessage };
}

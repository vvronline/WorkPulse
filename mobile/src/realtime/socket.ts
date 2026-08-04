import { AppState, type AppStateStatus } from "react-native";
import { wsUrl } from "../config";
import { getToken } from "../auth/tokenStore";

export type WSMessage = { type: string; data?: any };
type Listener = (msg: WSMessage) => void;
type SendRetryOptions = {
  timeoutMs?: number;
  retryEveryMs?: number;
  ensureConnected?: boolean;
  maxAttempts?: number;
  initialBackoffMs?: number;
  maxBackoffMs?: number;
  jitterRatio?: number;
  useExponentialBackoff?: boolean;
};

type RetryBackoffPlanOptions = {
  maxAttempts: number;
  initialDelayMs: number;
  maxDelayMs: number;
  jitterRatio?: number;
};

export function buildRetryBackoffPlan({
  maxAttempts,
  initialDelayMs,
  maxDelayMs,
  jitterRatio = 0.15,
}: RetryBackoffPlanOptions): number[] {
  const total = Math.max(0, Math.floor(maxAttempts));
  const initial = Math.max(1, Math.floor(initialDelayMs));
  const ceiling = Math.max(initial, Math.floor(maxDelayMs));
  const ratio = Number.isFinite(jitterRatio) ? Math.max(0, jitterRatio) : 0;
  const plan: number[] = [];

  for (let attempt = 0; attempt < total; attempt += 1) {
    const baseDelay = Math.min(ceiling, initial * 2 ** attempt);
    if (ratio === 0) {
      plan.push(baseDelay);
      continue;
    }
    const jitterBand = baseDelay * ratio;
    const jitterOffset = (Math.random() * 2 - 1) * jitterBand;
    plan.push(Math.max(1, Math.round(baseDelay + jitterOffset)));
  }

  return plan;
}

/**
 * Singleton WebSocket client for the WorkPulse realtime channel (/ws).
 * - Auth via `?token=<jwt>` query param (matches backend resolution order).
 * - Exponential-backoff reconnect.
 * - Ping every 25s (server heartbeat window).
 * - Reconnects when the app returns to the foreground.
 */
class RealtimeSocket {
  private ws: WebSocket | null = null;
  private listeners = new Set<Listener>();
  // P2.11 — fired every time the socket transitions to OPEN (initial connect
  // AND every reconnect). Used to re-register the FCM push token after a
  // reconnect so a token that rotated while the socket was down is refreshed.
  private openListeners = new Set<() => void>();
  private reconnectAttempts = 0;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private shouldRun = false;
  private appStateSub: { remove: () => void } | null = null;
  // In-flight `open()` guard. `open()` awaits `getToken()` (a native keychain
  // read), so the `isSocketLive()` check at its top is STALE by the time the
  // socket is actually constructed. Without this, `connect()`, `onAppState`,
  // `waitUntilConnected()` and the two un-awaited `this.open()` calls inside
  // `sendWithBackoff()` can interleave across that await and each build their
  // own WebSocket — the earlier one is overwritten by `this.ws = ws` and leaks
  // (its `onclose` hits the `this.ws !== ws` guard, so it never reconnects
  // either). Symptoms: duplicate realtime messages (double ring / double
  // toast) plus one leaked connection per foreground cycle. Every caller now
  // shares the SAME in-flight promise, so exactly one socket is created.
  private openPromise: Promise<void> | null = null;
  private isSocketLive() {
    return !!this.ws && this.ws.readyState <= 1;
  }

  async connect() {
    this.shouldRun = true;
    if (!this.appStateSub) {
      this.appStateSub = AppState.addEventListener("change", this.onAppState);
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.isSocketLive()) return;
    await this.open();
  }

  /**
   * Awaitable "socket is OPEN" gate. Resolves true once the WS reaches
   * readyState===1 (connected) within the timeout, false otherwise. Used by the
   * killed/headless reject path so we can confirm the realtime channel is
   * actually live before relying on it (and fall back to HTTP when it is not).
   */
  async waitUntilConnected(timeoutMs = 3000): Promise<boolean> {
    await this.connect();
    const deadline = Date.now() + Math.max(1, timeoutMs);
    while (Date.now() < deadline) {
      if (this.ws && this.ws.readyState === 1) return true;
      if (this.shouldRun && !this.isSocketLive()) this.open();
      await new Promise((r) => setTimeout(r, 80));
    }
    return !!this.ws && this.ws.readyState === 1;
  }

  private onAppState = (state: AppStateStatus) => {
    if (state === "active" && this.shouldRun) {
      if (!this.isSocketLive()) this.open();
    }
  };

  /**
   * Serialized socket opener. Concurrent callers share the single in-flight
   * attempt instead of each racing to construct their own WebSocket. See the
   * `openPromise` field comment for why the naive version leaked sockets.
   */
  private open(): Promise<void> {
    if (!this.shouldRun || this.isSocketLive()) return Promise.resolve();
    if (this.openPromise) return this.openPromise;
    const attempt = this.doOpen().finally(() => {
      // Only clear if we're still the current attempt — a later open() that
      // replaced us owns the slot from here on.
      if (this.openPromise === attempt) this.openPromise = null;
    });
    this.openPromise = attempt;
    return attempt;
  }

  private async doOpen() {
    if (!this.shouldRun || this.isSocketLive()) return;
    const token = await getToken();
    // Re-check AFTER the await: `shouldRun` may have been flipped by
    // disconnect() (logout) and another socket may have come up while the
    // keychain read was in flight. Opening now would strand that socket.
    if (!token || !this.shouldRun || this.isSocketLive()) return;
    let ws: WebSocket;
    try {
      ws = new WebSocket(wsUrl(token));
    } catch {
      this.scheduleReconnect();
      return;
    }
    // Defensive: if a socket somehow survived the checks above, close it
    // explicitly rather than dropping the reference and leaking it.
    if (this.ws && this.ws !== ws) {
      try {
        this.ws.close();
      } catch {
        /* ignore */
      }
    }
    this.ws = ws;

    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.reconnectAttempts = 0;
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
      this.startPing();
      // P2.11 — notify open-listeners (e.g. push-token re-registration) that the
      // realtime channel is (re)connected. Listener errors must never kill the
      // socket.
      this.openListeners.forEach((cb) => {
        try {
          cb();
        } catch {
          /* listener errors shouldn't kill the socket */
        }
      });
    };

    ws.onmessage = (e) => {
      if (this.ws !== ws) return;
      let msg: WSMessage;
      try {
        msg = JSON.parse(typeof e.data === "string" ? e.data : "");
      } catch {
        return;
      }
      if (msg.type === "pong") return;
      this.listeners.forEach((l) => {
        try {
          l(msg);
        } catch {
          /* listener errors shouldn't kill the socket */
        }
      });
    };

    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.stopPing();
      if (this.shouldRun) this.scheduleReconnect();
    };

    ws.onerror = () => {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    };
  }

  private startPing() {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      this.send("ping", {});
    }, 25000);
  }

  private stopPing() {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) return;
    const delay = Math.min(1000 * 2 ** this.reconnectAttempts, 15000);
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.shouldRun) this.open();
    }, delay);
  }

  send(type: string, data: any) {
    if (this.ws && this.ws.readyState === 1) {
      this.ws.send(JSON.stringify({ type, data }));
      return true;
    }
    return false;
  }

  async sendWithRetry(
    type: string,
    data: any,
    options: SendRetryOptions = {},
  ): Promise<boolean> {
    const {
      timeoutMs = 5000,
      retryEveryMs = 200,
      ensureConnected = true,
    } = options;

    const maxAttempts =
      options.maxAttempts ??
      Math.max(1, Math.floor(timeoutMs / Math.max(1, retryEveryMs)));

    return this.sendWithBackoff(type, data, {
      timeoutMs,
      ensureConnected,
      maxAttempts,
      initialBackoffMs: retryEveryMs,
      maxBackoffMs: retryEveryMs,
      jitterRatio: 0,
      useExponentialBackoff: false,
    });
  }

  async sendWithBackoff(
    type: string,
    data: any,
    {
      timeoutMs = 6000,
      ensureConnected = true,
      maxAttempts = 6,
      initialBackoffMs = 120,
      maxBackoffMs = 1200,
      jitterRatio = 0.15,
      useExponentialBackoff = true,
    }: SendRetryOptions = {},
  ): Promise<boolean> {
    if (ensureConnected && this.shouldRun && !this.isSocketLive()) {
      this.open();
    }

    const attemptsBudget = Math.max(1, Math.floor(maxAttempts));
    const deadline = Date.now() + Math.max(1, timeoutMs);
    const delayPlan = useExponentialBackoff
      ? buildRetryBackoffPlan({
          maxAttempts: Math.max(0, attemptsBudget - 1),
          initialDelayMs: initialBackoffMs,
          maxDelayMs: maxBackoffMs,
          jitterRatio,
        })
      : new Array(Math.max(0, attemptsBudget - 1)).fill(Math.max(1, initialBackoffMs));

    let sent = this.send(type, data);
    if (sent) return true;

    for (const plannedDelay of delayPlan) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await new Promise((r) => setTimeout(r, Math.min(plannedDelay, remaining)));
      if (ensureConnected && this.shouldRun && !this.isSocketLive()) {
        this.open();
      }
      sent = this.send(type, data);
      if (sent) return true;
    }

    return false;
  }

  async sendCallActionWithRetry(
    action: "accept" | "reject" | "end",
    data: { callId: number | null; conversationId: number | null; clientMsgId?: string },
    options: Omit<SendRetryOptions, "ensureConnected"> = {},
  ): Promise<boolean> {
    if (!data.callId || !data.conversationId) return false;
    const clientMsgId =
      data.clientMsgId || `native:${action}:${data.callId}:${data.conversationId}:${Date.now()}`;
    return this.sendWithBackoff(
      `call_${action}`,
      {
        callId: data.callId,
        conversationId: data.conversationId,
        clientMsgId,
      },
      {
        timeoutMs: options.timeoutMs ?? 6000,
        ensureConnected: true,
        maxAttempts: options.maxAttempts ?? 7,
        initialBackoffMs: options.initialBackoffMs ?? 120,
        maxBackoffMs: options.maxBackoffMs ?? 1000,
        jitterRatio: options.jitterRatio ?? 0.12,
        useExponentialBackoff: true,
      },
    );
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * P2.11 — Subscribe to socket-OPEN transitions (initial connect + every
   * reconnect). Returns an unsubscribe function. If the socket is ALREADY open
   * when subscribing, the callback is invoked once immediately so a late
   * subscriber doesn't miss the current connection.
   */
  onOpen(listener: () => void): () => void {
    this.openListeners.add(listener);
    if (this.ws && this.ws.readyState === 1) {
      try {
        listener();
      } catch {
        /* ignore */
      }
    }
    return () => this.openListeners.delete(listener);
  }

  disconnect() {
    this.shouldRun = false;
    // Drop any in-flight open attempt: `doOpen()` re-checks `shouldRun` after
    // its await, so the pending attempt will bail rather than resurrect the
    // socket after logout.
    this.openPromise = null;
    this.stopPing();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.appStateSub?.remove();
    this.appStateSub = null;
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.ws = null;
  }
}

export const socket = new RealtimeSocket();

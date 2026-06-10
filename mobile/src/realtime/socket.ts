import { AppState, type AppStateStatus } from "react-native";
import { wsUrl } from "../config";
import { getToken } from "../auth/tokenStore";

export type WSMessage = { type: string; data?: any };
type Listener = (msg: WSMessage) => void;

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
  private reconnectAttempts = 0;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private shouldRun = false;
  private appStateSub: { remove: () => void } | null = null;

  async connect() {
    this.shouldRun = true;
    if (!this.appStateSub) {
      this.appStateSub = AppState.addEventListener("change", this.onAppState);
    }
    await this.open();
  }

  private onAppState = (state: AppStateStatus) => {
    if (state === "active" && this.shouldRun) {
      if (!this.ws || this.ws.readyState > 1) this.open();
    }
  };

  private async open() {
    const token = await getToken();
    if (!token) return;
    try {
      this.ws = new WebSocket(wsUrl(token));
    } catch {
      this.scheduleReconnect();
      return;
    }

    this.ws.onopen = () => {
      this.reconnectAttempts = 0;
      this.startPing();
    };

    this.ws.onmessage = (e) => {
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

    this.ws.onclose = () => {
      this.stopPing();
      if (this.shouldRun) this.scheduleReconnect();
    };

    this.ws.onerror = () => {
      try {
        this.ws?.close();
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

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  disconnect() {
    this.shouldRun = false;
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

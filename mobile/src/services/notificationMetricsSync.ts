import { api } from "../api";
import { getToken } from "../auth/tokenStore";
import {
  notificationLogger,
  type NotificationLogEntry,
} from "../utils/notificationLogger";

type MetricEventPayload = {
  clientEventId: string;
  timestamp: number;
  level: string;
  event: string;
  dedupeKey?: string;
  conversationId?: string;
  messageId?: string;
  notificationType?: string;
  state?: string;
  durationMs?: number;
  source?: string;
  errorHash?: string;
  metadata?: Record<string, unknown>;
};

class NotificationMetricsSyncService {
  private syncing = false;
  private queuedTimer: ReturnType<typeof setTimeout> | null = null;

  queueSync(delayMs: number = 0): void {
    if (this.queuedTimer) clearTimeout(this.queuedTimer);
    this.queuedTimer = setTimeout(() => {
      this.queuedTimer = null;
      void this.syncNow();
    }, Math.max(0, delayMs));
  }

  async syncNow(): Promise<void> {
    if (this.syncing) return;
    const token = await getToken();
    if (!token) return;

    this.syncing = true;
    try {
      const logs = await notificationLogger.getUnsyncedLogs(100);
      if (logs.length === 0) return;

      await api.post("/notifications/metrics/events", {
        events: logs.map(this.toPayload),
      });
      await notificationLogger.markLogsSynced(logs.map((log) => log.id));
    } catch (err) {
      console.warn("[NotificationMetricsSync] Failed to sync notification metrics:", err);
    } finally {
      this.syncing = false;
    }
  }

  private toPayload(log: NotificationLogEntry): MetricEventPayload {
    return {
      clientEventId: log.id,
      timestamp: log.timestamp,
      level: log.level,
      event: log.event,
      dedupeKey: log.dedupeKey,
      conversationId: log.conversationId,
      messageId: log.messageId,
      notificationType: log.type,
      state: log.state,
      durationMs: log.duration_ms,
      source: log.source,
      errorHash: log.errorHash,
      metadata: log.metadata,
    };
  }
}

export const notificationMetricsSync = new NotificationMetricsSyncService();

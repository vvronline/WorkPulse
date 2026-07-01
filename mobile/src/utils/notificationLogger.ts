/**
 * Notification Logging Framework
 * 
 * Provides structured logging for all notification lifecycle events.
 * Enables tracing, debugging, and metrics collection.
 */

import * as SecureStore from 'expo-secure-store';

// ============================================================================
// TYPES & INTERFACES
// ============================================================================

export enum NotificationLogLevel {
  DEBUG = 'DEBUG',
  INFO = 'INFO',
  WARN = 'WARN',
  ERROR = 'ERROR',
}

export enum NotificationState {
  QUEUED = 'queued',           // FCM pending delivery
  DELIVERED = 'delivered',      // Arrived on device
  DISPLAYED = 'displayed',      // Shown in status bar / lock screen
  TAPPED = 'tapped',            // User clicked notification
  ROUTE_PERSISTED = 'route_persisted',  // Route written to SecureStore
  ROUTE_CONSUMED = 'route_consumed',    // App read the route
  NAVIGATION_STARTED = 'navigation_started',  // Router.push() called
  NAVIGATION_COMPLETED = 'navigation_completed'  // Screen mounted
}

export interface NotificationLogEntry {
  id: string;
  timestamp: number;
  level: NotificationLogLevel;
  event: string;
  dedupeKey?: string;
  conversationId?: string;
  messageId?: string;
  type?: 'call' | 'message';
  state?: NotificationState;
  duration_ms?: number;  // Time since DELIVERED
  error?: string;
  errorHash?: string;    // Hash of error for grouping (not full message)
  source?: string;
  syncedAt?: number;
  metadata?: Record<string, unknown>;
}

export interface NotificationMetrics {
  totalNotifications: number;
  successfulRoutes: number;
  failedRoutes: number;
  averageLatencyMs: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  validationFailures: number;
  deliveryFailures: number;
  deduplicatedCount: number;  // Messages skipped as duplicates
}

// ============================================================================
// NOTIFICATION LOGGER SERVICE
// ============================================================================

class NotificationLoggerService {
  private static instance: NotificationLoggerService;
  private logs: NotificationLogEntry[] = [];
  private readonly MAX_LOGS = 1000;  // Keep last 1000 logs in memory
  private readonly STORE_KEY = 'notification_logs';
  private metrics: Map<string, NotificationMetrics> = new Map();

  private constructor() {}

  static getInstance(): NotificationLoggerService {
    if (!NotificationLoggerService.instance) {
      NotificationLoggerService.instance = new NotificationLoggerService();
    }
    return NotificationLoggerService.instance;
  }

  /**
   * Log a notification lifecycle event
   */
  log(
    event: string,
    level: NotificationLogLevel | 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' = NotificationLogLevel.INFO,
    details?: Partial<NotificationLogEntry>
  ): void {
    const entry: NotificationLogEntry = {
      id: details?.id || this.createEntryId(event, details?.dedupeKey),
      timestamp: Date.now(),
      event,
      level: level as NotificationLogLevel,
      ...details,
    };

    this.logs.push(entry);

    // Keep memory usage bounded
    if (this.logs.length > this.MAX_LOGS) {
      this.logs.shift();
    }

    // Log to console in development
    if (__DEV__) {
      this.logToConsole(entry);
    }

    // Persist to secure storage
    this.persistLog(entry).catch(err => {
      console.warn('Failed to persist notification log:', err);
    });
  }

  /**
   * Convenience methods for common log levels
   */
  debug(event: string, details?: Partial<NotificationLogEntry>): void {
    this.log(event, NotificationLogLevel.DEBUG, details);
  }

  info(event: string, details?: Partial<NotificationLogEntry>): void {
    this.log(event, NotificationLogLevel.INFO, details);
  }

  warn(event: string, details?: Partial<NotificationLogEntry>): void {
    this.log(event, NotificationLogLevel.WARN, details);
  }

  error(event: string, error?: unknown, details?: Partial<NotificationLogEntry>): void {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorHash = this.hashError(errorMessage);

    this.log(event, NotificationLogLevel.ERROR, {
      ...details,
      error: errorMessage,
      errorHash,
    });
  }

  /**
   * Track notification state transitions
   */
  recordStateTransition(
    dedupeKey: string,
    fromState: NotificationState | null,
    toState: NotificationState,
    conversationId?: string,
    metadata?: Record<string, unknown>
  ): void {
    this.info('notification_state_transition', {
      dedupeKey,
      conversationId,
      state: toState,
      metadata: {
        fromState,
        ...metadata,
      },
    });
  }

  /**
   * Get all logs matching criteria
   */
  getLogs(filters?: {
    level?: NotificationLogLevel;
    event?: string;
    dedupeKey?: string;
    conversationId?: string;
    sinceTimestamp?: number;
  }): NotificationLogEntry[] {
    return this.logs.filter(log => {
      if (filters?.level && log.level !== filters.level) return false;
      if (filters?.event && log.event !== filters.event) return false;
      if (filters?.dedupeKey && log.dedupeKey !== filters.dedupeKey) return false;
      if (filters?.conversationId && log.conversationId !== filters.conversationId) return false;
      if (filters?.sinceTimestamp && log.timestamp < filters.sinceTimestamp) return false;
      return true;
    });
  }

  /**
   * Get logs for a specific notification
   */
  getNotificationLogs(dedupeKey: string): NotificationLogEntry[] {
    return this.getLogs({ dedupeKey });
  }

  /**
   * Returns durable logs that have not yet been uploaded to the server metrics API.
   */
  async getUnsyncedLogs(limit: number = 100): Promise<NotificationLogEntry[]> {
    const logs = await this.readPersistedLogs();
    return logs
      .filter(log => !log.syncedAt)
      .slice(-Math.max(1, Math.min(limit, 200)));
  }

  /**
   * Marks durable logs as synced after the server accepted the batch.
   */
  async markLogsSynced(ids: string[], syncedAt: number = Date.now()): Promise<void> {
    if (ids.length === 0) return;
    const idSet = new Set(ids);
    this.logs = this.logs.map(log => (
      idSet.has(log.id) ? { ...log, syncedAt } : log
    ));
    const persisted = await this.readPersistedLogs();
    const updated = persisted.map(log => (
      idSet.has(log.id) ? { ...log, syncedAt } : log
    ));
    await SecureStore.setItemAsync(this.STORE_KEY, JSON.stringify(updated.slice(-500)));
  }

  /**
   * Calculate latency for a notification (DELIVERED → state)
   */
  calculateLatency(
    dedupeKey: string,
    toState: NotificationState = NotificationState.NAVIGATION_COMPLETED
  ): number | null {
    const logs = this.getNotificationLogs(dedupeKey);
    
    const deliveredLog = logs.find(l => l.state === NotificationState.DELIVERED);
    const targetLog = logs.find(l => l.state === toState);

    if (!deliveredLog || !targetLog) return null;

    return targetLog.timestamp - deliveredLog.timestamp;
  }

  /**
   * Calculate metrics for success rate and latency
   */
  calculateMetrics(timeWindowMs: number = 24 * 60 * 60 * 1000): NotificationMetrics {
    const now = Date.now();
    const recentLogs = this.logs.filter(
      log => log.timestamp > now - timeWindowMs
    );

    const totalNotifications = new Set(
      recentLogs.map(log => log.dedupeKey).filter(Boolean)
    ).size;

    const successfulRoutes = new Set(
      recentLogs
        .filter(log =>
          log.state === NotificationState.ROUTE_CONSUMED ||
          log.state === NotificationState.NAVIGATION_COMPLETED
        )
        .map(log => log.dedupeKey)
        .filter(Boolean)
    ).size;

    const failedRoutes = new Set(
      recentLogs
        .filter(log => log.level === NotificationLogLevel.ERROR && log.dedupeKey)
        .map(log => log.dedupeKey)
        .filter(Boolean)
    ).size;

    const latencies = recentLogs
      .map(log => log.duration_ms)
      .filter((ms): ms is number => ms !== undefined && ms > 0)
      .sort((a, b) => a - b);

    const averageLatencyMs = latencies.length > 0
      ? latencies.reduce((a, b) => a + b, 0) / latencies.length
      : 0;

    const p50LatencyMs = latencies.length > 0
      ? latencies[Math.floor(latencies.length * 0.5)]
      : 0;

    const p95LatencyMs = latencies.length > 0
      ? latencies[Math.floor(latencies.length * 0.95)]
      : 0;

    const validationFailures = recentLogs.filter(
      log => log.event === 'validation_failure'
    ).length;

    const deliveryFailures = recentLogs.filter(
      log => log.event === 'delivery_failure'
    ).length;

    const deduplicatedCount = recentLogs.filter(
      log => log.event === 'message_skipped_duplicate'
    ).length;

    return {
      totalNotifications,
      successfulRoutes,
      failedRoutes,
      averageLatencyMs,
      p50LatencyMs,
      p95LatencyMs,
      validationFailures,
      deliveryFailures,
      deduplicatedCount,
    };
  }

  /**
   * Calculate success rate
   */
  getSuccessRate(timeWindowMs: number = 24 * 60 * 60 * 1000): number {
    const metrics = this.calculateMetrics(timeWindowMs);
    if (metrics.totalNotifications === 0) return 100;
    return (metrics.successfulRoutes / metrics.totalNotifications) * 100;
  }

  /**
   * Clear all logs (use with caution)
   */
  clearLogs(): void {
    this.logs = [];
  }

  /**
   * Export logs for analysis
   */
  exportLogs(format: 'json' | 'csv' = 'json'): string {
    if (format === 'json') {
      return JSON.stringify(this.logs, null, 2);
    } else {
      // CSV format
      const headers = Object.keys(this.logs[0] || {}).join(',');
      const rows = this.logs.map(log => 
        Object.values(log).map(v => 
          typeof v === 'string' && v.includes(',') ? `"${v}"` : v
        ).join(',')
      );
      return [headers, ...rows].join('\n');
    }
  }

  /**
   * Helper: Track a notification state transition
   * Logs the state change with relevant metadata
   */
  logStateTransition(
    dedupeKey: string,
    conversationId: string,
    toState: NotificationState,
    metadata?: Record<string, unknown>
  ): void {
    const deliveredLog = this.logs
      .filter(log => log.dedupeKey === dedupeKey && log.state === NotificationState.DELIVERED)
      .sort((a, b) => b.timestamp - a.timestamp)[0];
    const durationMs = deliveredLog ? Date.now() - deliveredLog.timestamp : undefined;

    this.info(`state_transition_${toState}`, {
      source: 'state_machine',
      dedupeKey,
      conversationId,
      state: toState,
      duration_ms: durationMs,
      metadata,
    });
  }

  /**
   * Helper: Track when a notification is displayed
   */
  logNotificationDisplayed(
    dedupeKey: string,
    conversationId: string,
    type: 'call' | 'message'
  ): void {
    this.logStateTransition(dedupeKey, conversationId, NotificationState.DISPLAYED, { type });
  }

  /**
   * Helper: Track when a notification is tapped
   */
  logNotificationTapped(
    dedupeKey: string,
    conversationId: string,
    messageId?: string
  ): void {
    this.logStateTransition(dedupeKey, conversationId, NotificationState.TAPPED, { messageId });
  }

  /**
   * Helper: Track when navigation to the notification target completes
   */
  logNavigationCompleted(
    dedupeKey: string,
    conversationId: string,
    durationMs: number
  ): void {
    this.logStateTransition(
      dedupeKey,
      conversationId,
      NotificationState.NAVIGATION_COMPLETED,
      { durationMs }
    );
  }

  // ========================================================================
  // PRIVATE METHODS
  // ========================================================================

  private logToConsole(entry: NotificationLogEntry): void {
    const prefix = `[${entry.level}] ${entry.event}`;
    const keyInfo = entry.dedupeKey ? ` (${entry.dedupeKey})` : '';
    const message = `${prefix}${keyInfo}`;

    const logData = {
      ...entry,
    };

    switch (entry.level) {
      case NotificationLogLevel.DEBUG:
        console.debug(message, logData);
        break;
      case NotificationLogLevel.INFO:
        console.log(message, logData);
        break;
      case NotificationLogLevel.WARN:
        console.warn(message, logData);
        break;
      case NotificationLogLevel.ERROR:
        console.error(message, logData);
        break;
    }
  }

  async readPersistedLogs(): Promise<NotificationLogEntry[]> {
    try {
      const existing = await SecureStore.getItemAsync(this.STORE_KEY);
      const parsed = existing ? JSON.parse(existing) : [];
      if (!Array.isArray(parsed)) return [];
      return parsed.map((log, index) => this.normalizePersistedLog(log, index));
    } catch (err) {
      console.warn('Failed to read notification logs from storage:', err);
      return [];
    }
  }

  private async persistLog(entry: NotificationLogEntry): Promise<void> {
    try {
      const logs = await this.readPersistedLogs();
      logs.push(entry);

      // Keep only last 500 logs to avoid storage bloat
      const trimmed = logs.slice(-500);

      // Store
      await SecureStore.setItemAsync(this.STORE_KEY, JSON.stringify(trimmed));
    } catch (err) {
      // Fail silently to avoid disrupting app
      console.warn('Failed to persist log to storage:', err);
    }
  }

  private normalizePersistedLog(raw: unknown, index: number): NotificationLogEntry {
    const log = raw && typeof raw === 'object'
      ? raw as Partial<NotificationLogEntry>
      : {};
    const event = typeof log.event === 'string' ? log.event : 'unknown_event';
    const timestamp = typeof log.timestamp === 'number' ? log.timestamp : Date.now();
    const level = Object.values(NotificationLogLevel).includes(log.level as NotificationLogLevel)
      ? log.level as NotificationLogLevel
      : NotificationLogLevel.INFO;

    return {
      ...log,
      id: typeof log.id === 'string' && log.id.length > 0
        ? log.id
        : `legacy_${timestamp}_${event}_${index}`,
      timestamp,
      event,
      level,
    };
  }

  private createEntryId(event: string, dedupeKey?: string): string {
    const normalizedKey = dedupeKey ? this.hashError(dedupeKey) : 'no_key';
    return `${Date.now()}_${event}_${normalizedKey}_${Math.random().toString(36).slice(2, 10)}`;
  }

  private hashError(error: string): string {
    // Simple hash for grouping similar errors
    let hash = 0;
    for (let i = 0; i < error.length; i++) {
      const char = error.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    return `error_${Math.abs(hash)}`;
  }
}

// ============================================================================
// EXPORTS
// ============================================================================

export const notificationLogger = NotificationLoggerService.getInstance();

/**
 * Initialize the logger (call at app startup)
 */
export async function initializeNotificationLogger(): Promise<void> {
  notificationLogger.info('notification_logger_initialized', {
    source: 'dispatch',
  });
}

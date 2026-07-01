/**
 * Notification Deduplicator
 *
 * Groups messages by conversationId and deduplicates by dedupeKey.
 * Prevents "burst" spam where multiple identical messages from the same
 * conversation arrive in rapid succession.
 *
 * Problem it solves:
 * - Server sends the same message push multiple times (retry logic, misconfiguration, etc)
 * - This results in N duplicate notifications for 1 message
 * - User sees 3-5 copies of the same message notification
 * - Fixes: Only the latest message per conversation is displayed
 */

import { storage } from "../storage/mmkv";
import { notificationLogger } from "./notificationLogger";

// ============================================================================
// TYPES & INTERFACES
// ============================================================================

export interface NotificationMessage {
  conversationId: string;
  dedupeKey: string;
  messageId?: string;
  timestamp: number;
  [key: string]: any;
}

export interface DeduplicationResult {
  shouldDisplay: boolean;
  reason: string;
  isDuplicate: boolean;
  previousTimestamp?: number;
}

// ============================================================================
// DEDUPLICATOR SERVICE
// ============================================================================

class NotificationDeduplicatorService {
  private static instance: NotificationDeduplicatorService;
  
  // Store deduplication state in MMKV (survives process kills)
  private readonly DEDUP_STATE_KEY = 'notification_dedup_state';
  private readonly DEDUP_TTL_MS = 5 * 60 * 1000; // 5 minutes
  
  // In-memory cache of recent messages (fast lookup)
  private recentMessages: Map<string, NotificationMessage> = new Map();

  private constructor() {
    this.loadState();
  }

  static getInstance(): NotificationDeduplicatorService {
    if (!NotificationDeduplicatorService.instance) {
      NotificationDeduplicatorService.instance = new NotificationDeduplicatorService();
    }
    return NotificationDeduplicatorService.instance;
  }

  /**
   * Check if a message should be displayed (not a duplicate of a recent message)
   * 
   * Returns true for:
   * - First message with this dedupeKey
   * - Message arrives > 5 minutes after the previous one
   * 
   * Returns false for:
   * - Duplicate dedupeKey within 5 minutes (same conversation)
   * - Missing required fields (conversationId, dedupeKey)
   */
  shouldDisplay(message: NotificationMessage): DeduplicationResult {
    // Validate required fields
    if (!message.conversationId || !message.dedupeKey) {
      return {
        shouldDisplay: false,
        reason: 'Missing conversationId or dedupeKey',
        isDuplicate: false,
      };
    }

    const key = this.getMessageKey(message.conversationId, message.dedupeKey);
    const now = Date.now();

    // Check in-memory cache first (fast path)
    const cached = this.recentMessages.get(key);
    if (cached) {
      const age = now - cached.timestamp;
      
      if (age < this.DEDUP_TTL_MS) {
        // Within TTL window — this is a duplicate
        notificationLogger.info('message_deduplicated', {
          source: 'deduplicator',
          dedupeKey: message.dedupeKey,
          conversationId: message.conversationId,
          metadata: {
            ageMs: age,
            previousTimestamp: cached.timestamp,
            isDuplicate: true,
          },
        });

        return {
          shouldDisplay: false,
          reason: `Duplicate within ${this.DEDUP_TTL_MS}ms`,
          isDuplicate: true,
          previousTimestamp: cached.timestamp,
        };
      } else {
        // Stale entry — remove it and allow new message
        this.recentMessages.delete(key);
      }
    }

    // First message with this dedupeKey, or previous one is stale
    notificationLogger.info('message_unique_for_display', {
      source: 'deduplicator',
      dedupeKey: message.dedupeKey,
      conversationId: message.conversationId,
      metadata: {
        isDuplicate: false,
      },
    });

    // Record this message so later duplicates can be detected
    this.recordMessage(message);

    return {
      shouldDisplay: true,
      reason: 'Message is unique (not a duplicate)',
      isDuplicate: false,
    };
  }

  /**
   * Record a message in the deduplication cache
   * Called after a message has been displayed
   */
  private recordMessage(message: NotificationMessage): void {
    const key = this.getMessageKey(message.conversationId, message.dedupeKey);
    this.recentMessages.set(key, {
      ...message,
      timestamp: Date.now(),
    });

    // Periodically clean up stale entries to prevent memory bloat
    this.cleanupStaleEntries();

    // Persist to MMKV for recovery after process kill
    this.saveState();
  }

  /**
   * Clean up messages older than the TTL
   */
  private cleanupStaleEntries(): void {
    const now = Date.now();
    let cleaned = 0;

    for (const [key, message] of this.recentMessages.entries()) {
      if (now - message.timestamp > this.DEDUP_TTL_MS) {
        this.recentMessages.delete(key);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      notificationLogger.info('dedup_cleanup', {
        source: 'deduplicator',
        metadata: {
          entriesRemoved: cleaned,
          remainingEntries: this.recentMessages.size,
        },
      });
    }
  }

  /**
   * Get a stable key for a message (conversationId + dedupeKey)
   */
  private getMessageKey(conversationId: string, dedupeKey: string): string {
    return `${conversationId}:${dedupeKey}`;
  }

  /**
   * Save deduplication state to MMKV (survives process kills)
   */
  private saveState(): void {
    try {
      const state = Array.from(this.recentMessages.entries()).map(([key, msg]) => ({
        key,
        msg,
      }));

      storage.set(
        this.DEDUP_STATE_KEY,
        JSON.stringify(state)
      );
    } catch (error) {
      notificationLogger.warn('dedup_state_save_failed', {
        source: 'deduplicator',
      });
    }
  }

  /**
   * Load deduplication state from MMKV
   */
  private loadState(): void {
    try {
      const data = storage.getString(this.DEDUP_STATE_KEY);
      if (!data) return;

      const state = JSON.parse(data) as Array<{ key: string; msg: NotificationMessage }>;
      const now = Date.now();
      let loaded = 0;
      let stale = 0;

      for (const { key, msg } of state) {
        if (now - msg.timestamp < this.DEDUP_TTL_MS) {
          this.recentMessages.set(key, msg);
          loaded++;
        } else {
          stale++;
        }
      }

      if (loaded > 0 || stale > 0) {
        notificationLogger.info('dedup_state_loaded', {
          source: 'deduplicator',
          metadata: {
            loadedEntries: loaded,
            staleEntries: stale,
          },
        });
      }
    } catch (error) {
      notificationLogger.warn('dedup_state_load_failed', {
        source: 'deduplicator',
      });
      // Continue with empty cache if load fails
      this.recentMessages.clear();
    }
  }

  /**
   * Get deduplication statistics (for debugging)
   */
  getStats() {
    const now = Date.now();
    const entries = Array.from(this.recentMessages.entries()).map(([key, msg]) => ({
      key,
      ageMs: now - msg.timestamp,
      conversationId: msg.conversationId,
      dedupeKey: msg.dedupeKey,
    }));

    return {
      totalEntries: this.recentMessages.size,
      ttlMs: this.DEDUP_TTL_MS,
      entries,
    };
  }

  /**
   * Clear all deduplication state (use only for testing)
   */
  clear(): void {
    this.recentMessages.clear();
    try {
      storage.remove(this.DEDUP_STATE_KEY);
    } catch {
      // ignore
    }
  }
}

// ============================================================================
// EXPORTS
// ============================================================================

export const notificationDeduplicator = NotificationDeduplicatorService.getInstance();

/**
 * Helper function for common deduplication check
 */
export function shouldDisplayNotification(
  message: NotificationMessage
): boolean {
  const result = notificationDeduplicator.shouldDisplay(message);
  return result.shouldDisplay;
}

/**
 * Helper function to get full deduplication result
 */
export function checkNotificationDeduplication(
  message: NotificationMessage
): DeduplicationResult {
  return notificationDeduplicator.shouldDisplay(message);
}

/**
 * Chat Unread Events Service
 * File: mobile/src/realtime/chatUnreadEvents.ts
 * 
 * Purpose: Manage server-authoritative unread state and trigger reconciliation
 * when notifications arrive or app comes to foreground.
 */

interface UnreadSyncState {
  conversationId: string;
  unreadCount: number;
  lastSyncTime: number;
  isDirty: boolean;
}

type ConversationId = string | number;

function toConversationKey(conversationId: ConversationId): string {
  return String(conversationId);
}

// Legacy listener pattern for backward compatibility
type Listener = () => void;
const listeners = new Set<Listener>();

export function emitChatUnreadChanged(): void {
  listeners.forEach((listener) => {
    try {
      listener();
    } catch {
      // Keep notifier resilient; one bad listener must not break others.
    }
  });
}

export function subscribeChatUnreadChanged(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// Enhanced unread state management with server-authoritative sync
class ChatUnreadManager {
  private unreadState = new Map<string, UnreadSyncState>();
  private syncScheduled = false;
  private readonly syncDebounceMs = 1000;
  private unreadChangeListeners = new Set<(convId: string, count: number) => void>();
  private syncNeededListeners = new Set<(conversationIds: string[]) => void>();

  /**
   * Update unread count for a conversation.
   * Marks as dirty for later reconciliation with server.
   */
  updateUnreadCount(conversationId: ConversationId, count: number): void {
    const key = toConversationKey(conversationId);
    const current = this.unreadState.get(key) || {
      conversationId: key,
      unreadCount: 0,
      lastSyncTime: 0,
      isDirty: false,
    };

    const changed = current.unreadCount !== count;
    current.unreadCount = count;
    current.isDirty = true;
    this.unreadState.set(key, current);

    if (changed) {
      console.debug('[ChatUnreadEvents] Unread count updated', {
        conversationId: key,
        count,
      });
      this.unreadChangeListeners.forEach((listener) => {
        try {
          listener(key, count);
        } catch (e) {
          console.error('[ChatUnreadEvents] Listener error', e);
        }
      });
      emitChatUnreadChanged();
      this.scheduleSyncCheck();
    }
  }

  /**
   * Mark conversation as read, clearing unread count.
   */
  markConversationRead(conversationId: ConversationId): void {
    const key = toConversationKey(conversationId);
    const state = this.unreadState.get(key);
    if (state && state.unreadCount > 0) {
      state.unreadCount = 0;
      state.isDirty = true;
      console.debug('[ChatUnreadEvents] Conversation marked read', {
        conversationId: key,
      });
      this.unreadChangeListeners.forEach((listener) => {
        try {
          listener(key, 0);
        } catch (e) {
          console.error('[ChatUnreadEvents] Listener error', e);
        }
      });
      emitChatUnreadChanged();
      this.scheduleSyncCheck();
    }
  }

  /**
   * Get unread count for a specific conversation.
   */
  getUnreadCount(conversationId: ConversationId): number {
    return this.unreadState.get(toConversationKey(conversationId))?.unreadCount || 0;
  }

  /**
   * Get total unread across all conversations (for launcher badge).
   */
  getTotalUnread(): number {
    return Array.from(this.unreadState.values()).reduce((sum, s) => sum + s.unreadCount, 0);
  }

  /**
   * Get all conversations that need sync with server.
   */
  getDirtyConversations(): string[] {
    return Array.from(this.unreadState.entries())
      .filter(([_, state]) => state.isDirty)
      .map(([conversationId]) => conversationId);
  }

  /**
   * Clear dirty flag after successful server sync.
   */
  clearDirtyFlag(conversationId: ConversationId): void {
    const state = this.unreadState.get(toConversationKey(conversationId));
    if (state) {
      state.isDirty = false;
      state.lastSyncTime = Date.now();
    }
  }

  /**
   * Batch update unread counts (typically from server sync).
   */
  updateBatch(updates: Array<{ conversationId: ConversationId; count: number }>): void {
    updates.forEach(({ conversationId, count }) => {
      this.updateUnreadCount(conversationId, count);
    });
  }

  /**
   * Subscribe to unread count changes.
   */
  onUnreadChange(listener: (conversationId: string, count: number) => void): () => void {
    this.unreadChangeListeners.add(listener);
    return () => {
      this.unreadChangeListeners.delete(listener);
    };
  }

  /**
   * Subscribe to sync needed events.
   */
  onSyncNeeded(listener: (conversationIds: string[]) => void): () => void {
    this.syncNeededListeners.add(listener);
    return () => {
      this.syncNeededListeners.delete(listener);
    };
  }

  /**
   * Schedule a sync check (debounced) to reconcile with server.
   */
  private scheduleSyncCheck(): void {
    if (this.syncScheduled) {
      return;
    }

    this.syncScheduled = true;
    setTimeout(() => {
      this.syncScheduled = false;
      const dirty = this.getDirtyConversations();
      if (dirty.length > 0) {
        console.debug('[ChatUnreadEvents] Emitting sync needed', { count: dirty.length });
        this.syncNeededListeners.forEach((listener) => {
          try {
            listener(dirty);
          } catch (e) {
            console.error('[ChatUnreadEvents] Sync listener error', e);
          }
        });
      }
    }, this.syncDebounceMs);
  }

  /**
   * Reset all unread state (e.g., on logout).
   */
  reset(): void {
    this.unreadState.clear();
    console.debug('[ChatUnreadEvents] State reset');
  }

  /**
   * Get current state for debugging.
   */
  getState(): Record<string, UnreadSyncState> {
    const state: Record<string, UnreadSyncState> = {};
    this.unreadState.forEach((v, k) => {
      state[k] = v;
    });
    return state;
  }
}

// Export singleton instance
export const chatUnreadManager = new ChatUnreadManager();

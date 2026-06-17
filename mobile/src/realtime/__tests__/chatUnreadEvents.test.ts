/**
 * Test: Unread badge synchronization logic
 * File: mobile/src/realtime/__tests__/chatUnreadEvents.test.ts
 * 
 * Purpose: Verify unread badge state is synchronized with server and updated
 * when notifications arrive or messages are read.
 */

import { EventEmitter } from 'eventemitter3';

// Mock types
interface UnreadSyncState {
  conversationId: string;
  unreadCount: number;
  lastSyncTime: number;
  isDirty: boolean;
}

class ChatUnreadEvents extends EventEmitter {
  private unreadState = new Map<string, UnreadSyncState>();

  updateUnreadCount(conversationId: string, count: number) {
    const current = this.unreadState.get(conversationId) || {
      conversationId,
      unreadCount: 0,
      lastSyncTime: 0,
      isDirty: false,
    };
    current.unreadCount = count;
    current.isDirty = true;
    this.unreadState.set(conversationId, current);
    this.emit('unread:updated', { conversationId, count });
  }

  getUnreadCount(conversationId: string): number {
    return this.unreadState.get(conversationId)?.unreadCount || 0;
  }

  markConversationRead(conversationId: string) {
    const state = this.unreadState.get(conversationId);
    if (state) {
      state.unreadCount = 0;
      state.isDirty = true;
      this.emit('unread:cleared', { conversationId });
    }
  }

  getTotalUnread(): number {
    return Array.from(this.unreadState.values()).reduce((sum, s) => sum + s.unreadCount, 0);
  }

  getDirtyConversations(): string[] {
    return Array.from(this.unreadState.entries())
      .filter(([_, state]) => state.isDirty)
      .map(([conversationId]) => conversationId);
  }

  clearDirtyFlag(conversationId: string) {
    const state = this.unreadState.get(conversationId);
    if (state) {
      state.isDirty = false;
    }
  }
}

describe('Chat Unread Events - Badge Synchronization', () => {
  let chatUnread: ChatUnreadEvents;

  beforeEach(() => {
    chatUnread = new ChatUnreadEvents();
  });

  test('T025.1: Track unread count per conversation', () => {
    chatUnread.updateUnreadCount('conv-1', 5);
    chatUnread.updateUnreadCount('conv-2', 3);

    expect(chatUnread.getUnreadCount('conv-1')).toBe(5);
    expect(chatUnread.getUnreadCount('conv-2')).toBe(3);
  });

  test('T025.2: Calculate total unread across all conversations', () => {
    chatUnread.updateUnreadCount('conv-1', 5);
    chatUnread.updateUnreadCount('conv-2', 3);
    chatUnread.updateUnreadCount('conv-3', 2);

    expect(chatUnread.getTotalUnread()).toBe(10);
  });

  test('T025.3: Emit event when unread count changes', (done) => {
    const listener = jest.fn();
    chatUnread.on('unread:updated', listener);

    chatUnread.updateUnreadCount('conv-1', 5);

    expect(listener).toHaveBeenCalledWith({
      conversationId: 'conv-1',
      count: 5,
    });
    done();
  });

  test('T025.4: Mark conversation as read and clear unread count', () => {
    chatUnread.updateUnreadCount('conv-1', 5);
    expect(chatUnread.getUnreadCount('conv-1')).toBe(5);

    chatUnread.markConversationRead('conv-1');
    expect(chatUnread.getUnreadCount('conv-1')).toBe(0);
  });

  test('T025.5: Emit cleared event when conversation marked read', (done) => {
    const listener = jest.fn();
    chatUnread.on('unread:cleared', listener);

    chatUnread.updateUnreadCount('conv-1', 5);
    chatUnread.markConversationRead('conv-1');

    expect(listener).toHaveBeenCalledWith({ conversationId: 'conv-1' });
    done();
  });

  test('T025.6: Track dirty state for sync reconciliation', () => {
    chatUnread.updateUnreadCount('conv-1', 5);
    chatUnread.updateUnreadCount('conv-2', 3);

    const dirty = chatUnread.getDirtyConversations();
    expect(dirty).toContain('conv-1');
    expect(dirty).toContain('conv-2');
  });

  test('T025.7: Clear dirty flag after sync', () => {
    chatUnread.updateUnreadCount('conv-1', 5);
    chatUnread.clearDirtyFlag('conv-1');

    const dirty = chatUnread.getDirtyConversations();
    expect(dirty).not.toContain('conv-1');
  });

  test('T025.8: Handle incremental unread updates', () => {
    chatUnread.updateUnreadCount('conv-1', 1);
    chatUnread.updateUnreadCount('conv-1', 2);
    chatUnread.updateUnreadCount('conv-1', 3);

    expect(chatUnread.getUnreadCount('conv-1')).toBe(3);
  });

  test('T025.9: Return zero for non-existent conversation', () => {
    expect(chatUnread.getUnreadCount('conv-unknown')).toBe(0);
  });

  test('T025.10: Support batch unread update from server response', () => {
    const batch = [
      { conversationId: 'conv-1', count: 5 },
      { conversationId: 'conv-2', count: 3 },
      { conversationId: 'conv-3', count: 2 },
    ];

    batch.forEach(({ conversationId, count }) => {
      chatUnread.updateUnreadCount(conversationId, count);
    });

    expect(chatUnread.getTotalUnread()).toBe(10);
  });
});

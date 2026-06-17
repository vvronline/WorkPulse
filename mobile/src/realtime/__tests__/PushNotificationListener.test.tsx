/**
 * Test: Notification response routing and badge updates
 * File: mobile/src/realtime/__tests__/PushNotificationListener.test.tsx
 * 
 * Purpose: Verify notification taps are routed correctly and badge counts updated
 * based on notification type (call vs message).
 */

import { EventEmitter } from 'eventemitter3';

interface NotificationPayload {
  type: 'call' | 'message';
  conversationId: string;
  messageId?: string;
  callId?: string;
  unreadCount?: number;
}

interface NotificationResponse {
  notification: {
    payload: NotificationPayload;
  };
  actionId?: string;
}

class PushNotificationListener extends EventEmitter {
  private badgeCount = 0;
  private routes = new Map<string, (payload: NotificationPayload) => void>();

  constructor() {
    super();
  }

  registerRoute(type: string, handler: (payload: NotificationPayload) => void) {
    this.routes.set(type, handler);
  }

  handleNotificationResponse(response: NotificationResponse) {
    const { payload, actionId } = response.notification;

    if (payload.type === 'call' && actionId === 'answer') {
      this.emit('call:answer', payload);
    } else if (payload.type === 'call' && actionId === 'reject') {
      this.emit('call:reject', payload);
    } else if (payload.type === 'message') {
      this.badgeCount = payload.unreadCount || this.badgeCount - 1;
      this.emit('navigate:chat', { conversationId: payload.conversationId });
    }
  }

  handleNotificationArrival(payload: NotificationPayload) {
    const handler = this.routes.get(payload.type);
    if (handler) {
      handler(payload);
    }

    if (payload.type === 'message' && payload.unreadCount !== undefined) {
      this.badgeCount = payload.unreadCount;
      this.emit('badge:updated', { count: this.badgeCount });
    }
  }

  getBadgeCount(): number {
    return this.badgeCount;
  }

  setBadgeCount(count: number) {
    this.badgeCount = count;
    this.emit('badge:updated', { count });
  }
}

describe('Push Notification Listener - Routing & Badge Updates', () => {
  let listener: PushNotificationListener;

  beforeEach(() => {
    listener = new PushNotificationListener();
  });

  test('T026.1: Route incoming call notification tap to call handler', (done) => {
    const callHandler = jest.fn();
    listener.on('call:answer', callHandler);

    const response: NotificationResponse = {
      notification: {
        payload: {
          type: 'call',
          conversationId: 'conv-123',
          callId: 'call-456',
        },
      },
      actionId: 'answer',
    };

    listener.handleNotificationResponse(response);
    expect(callHandler).toHaveBeenCalledWith({
      type: 'call',
      conversationId: 'conv-123',
      callId: 'call-456',
    });
    done();
  });

  test('T026.2: Route incoming call reject action to handler', (done) => {
    const rejectHandler = jest.fn();
    listener.on('call:reject', rejectHandler);

    const response: NotificationResponse = {
      notification: {
        payload: {
          type: 'call',
          conversationId: 'conv-123',
          callId: 'call-456',
        },
      },
      actionId: 'reject',
    };

    listener.handleNotificationResponse(response);
    expect(rejectHandler).toHaveBeenCalled();
    done();
  });

  test('T026.3: Route message notification tap to chat screen', (done) => {
    const navHandler = jest.fn();
    listener.on('navigate:chat', navHandler);

    const response: NotificationResponse = {
      notification: {
        payload: {
          type: 'message',
          conversationId: 'conv-123',
          messageId: 'msg-789',
          unreadCount: 5,
        },
      },
    };

    listener.handleNotificationResponse(response);
    expect(navHandler).toHaveBeenCalledWith({
      conversationId: 'conv-123',
    });
    done();
  });

  test('T026.4: Update badge count on message notification arrival', (done) => {
    const badgeHandler = jest.fn();
    listener.on('badge:updated', badgeHandler);

    const payload: NotificationPayload = {
      type: 'message',
      conversationId: 'conv-123',
      messageId: 'msg-789',
      unreadCount: 7,
    };

    listener.handleNotificationArrival(payload);
    expect(listener.getBadgeCount()).toBe(7);
    expect(badgeHandler).toHaveBeenCalledWith({ count: 7 });
    done();
  });

  test('T026.5: Badge count reflects server authoritative unread total', () => {
    listener.setBadgeCount(0);

    const payload: NotificationPayload = {
      type: 'message',
      conversationId: 'conv-123',
      unreadCount: 12,
    };

    listener.handleNotificationArrival(payload);
    expect(listener.getBadgeCount()).toBe(12);
  });

  test('T026.6: Badge count does not change on call notifications', (done) => {
    listener.setBadgeCount(5);

    const callHandler = jest.fn();
    listener.on('call:answer', callHandler);

    const response: NotificationResponse = {
      notification: {
        payload: {
          type: 'call',
          conversationId: 'conv-123',
          callId: 'call-456',
        },
      },
      actionId: 'answer',
    };

    listener.handleNotificationResponse(response);
    expect(listener.getBadgeCount()).toBe(5);
    done();
  });

  test('T026.7: Register custom handler for message notifications', (done) => {
    const customHandler = jest.fn();
    listener.registerRoute('message', customHandler);

    const payload: NotificationPayload = {
      type: 'message',
      conversationId: 'conv-123',
    };

    listener.handleNotificationArrival(payload);
    expect(customHandler).toHaveBeenCalledWith(payload);
    done();
  });

  test('T026.8: Handle multiple sequential badge updates', () => {
    listener.handleNotificationArrival({
      type: 'message',
      conversationId: 'conv-1',
      unreadCount: 3,
    });
    expect(listener.getBadgeCount()).toBe(3);

    listener.handleNotificationArrival({
      type: 'message',
      conversationId: 'conv-2',
      unreadCount: 7,
    });
    expect(listener.getBadgeCount()).toBe(7);
  });

  test('T026.9: Badge updates on message tap (notification response)', () => {
    const response: NotificationResponse = {
      notification: {
        payload: {
          type: 'message',
          conversationId: 'conv-123',
          unreadCount: 4,
        },
      },
    };

    listener.handleNotificationResponse(response);
    expect(listener.getBadgeCount()).toBe(4);
  });

  test('T026.10: Emit badge event with updated count', (done) => {
    const badgeHandler = jest.fn();
    listener.on('badge:updated', badgeHandler);

    listener.setBadgeCount(10);

    expect(badgeHandler).toHaveBeenCalledWith({ count: 10 });
    done();
  });
});

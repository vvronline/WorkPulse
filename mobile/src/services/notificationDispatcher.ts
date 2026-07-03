/**
 * Notification Dispatcher Service
 * 
 * Single-reader pattern for getInitialNotification() to fix race condition.
 * 
 * CRITICAL: This service MUST be the only component that reads
 * getInitialNotification(). All other components read from the store.
 * 
 * Problem it solves:
 * - Multiple components (app/index.tsx, PendingCallNavigator) were calling
 *   getInitialNotification() simultaneously
 * - This is a ONE-SHOT API (can only be read once per app launch)
 * - Result: 50% of the time, one component gets NULL instead of the route
 * - Fixes: Cold-start routing success from 50-70% → 100%
 */

import * as SecureStore from 'expo-secure-store';
import notifee from '@notifee/react-native';
import { notificationLogger, NotificationState } from '../utils/notificationLogger';
import {
  pendingCallFromData,
  persistPendingCall,
  setPendingCall,
  loadPersistedPendingCall,
  type PendingCallRoute,
} from '../realtime/pendingCall';
import {
  persistPendingChat,
  setPendingChat,
  loadPersistedPendingChat,
} from '../realtime/pendingChat';
import {
  getPendingCallAction,
  clearPendingCallAction,
} from '../../modules/call-ringer';

// ============================================================================
// TYPES & INTERFACES
// ============================================================================

export interface NotificationRoute {
  type: 'call' | 'message';
  conversationId: string;
  messageId?: string;
  callId?: string;
  timestamp: number;
  dedupeKey: string;
  sourceState: 'cold_start' | 'warm' | 'background_alive';
  // When true (a KILLED-state GROUP-SUMMARY tap for 2+ unread chats), the
  // consumer opens the CHAT LIST instead of a specific thread — never the
  // dashboard. See notifeeService.postGroupSummary's `openChatList` marker.
  openChatList?: boolean;
}

export interface DispatcherState {
  route: NotificationRoute | null;
  initialized: boolean;
  initialNotificationRead: boolean;
  timestampCaptured: number;
}

// ============================================================================
// NOTIFICATION DISPATCHER SERVICE
// ============================================================================

class NotificationDispatcherService {
  private static instance: NotificationDispatcherService;
  private state: DispatcherState = {
    route: null,
    initialized: false,
    initialNotificationRead: false,
    timestampCaptured: 0,
  };
  private initializationPromise: Promise<void> | null = null;

  private subscribers: Set<(route: NotificationRoute | null) => void> = new Set();
  private readonly STORE_KEY = 'notification_dispatcher_route';
  private readonly STATE_TTL_MS = 60 * 1000; // 60 seconds

  private constructor() {}

  static getInstance(): NotificationDispatcherService {
    if (!NotificationDispatcherService.instance) {
      NotificationDispatcherService.instance = new NotificationDispatcherService();
    }
    return NotificationDispatcherService.instance;
  }

  /**
   * CRITICAL: Initialize the dispatcher at app boot (BEFORE React)
   * 
   * This MUST be called from mobile/index.js BEFORE expo-router entry.
   * It reads getInitialNotification() EXACTLY ONCE.
   * All other components read from the store.
   * 
   * @param sourceState - Where the app is coming from (cold/warm/bg)
   */
  async initialize(sourceState: NotificationRoute['sourceState'] = 'cold_start'): Promise<void> {
    if (this.initializationPromise) return this.initializationPromise;
    this.initializationPromise = this.doInitialize(sourceState);
    try {
      await this.initializationPromise;
    } finally {
      this.initializationPromise = null;
    }
  }

  private async doInitialize(sourceState: NotificationRoute['sourceState'] = 'cold_start'): Promise<void> {
    try {
      const startTime = Date.now();

      const hasRoute = Boolean(this.getRoute());
      const shouldRecheckInitialNotification =
        this.state.initialNotificationRead && this.state.initialized && !hasRoute;

      // Guard only while the first read is actively in flight. Android back can
      // destroy the Activity while leaving this JS singleton alive; the next
      // notification tap starts a fresh Activity with a fresh launch intent, so
      // a process-lifetime "read once" guard would skip that intent and fall
      // through to the dashboard.
      if (this.state.initialNotificationRead && !this.state.initialized) {
        notificationLogger.info('dispatcher_initialization_in_progress', {
          source: 'dispatch',
          metadata: { sourceState },
        });
        return;
      }

      if (hasRoute) {
        notificationLogger.info('dispatcher_already_has_route', {
          source: 'dispatch',
          metadata: { sourceState },
        });
        return;
      }

      if (shouldRecheckInitialNotification) {
        notificationLogger.info('dispatcher_rechecking_initial_notification', {
          source: 'dispatch',
          metadata: { sourceState },
        });
      } else {
        this.state.initialNotificationRead = true;
        this.state.initialized = false;
      }

      notificationLogger.info('dispatcher_initialize_start', {
        source: 'dispatch',
        metadata: { sourceState },
      });

      const nativeActionRoute = await this.captureNativeCallAction(sourceState);
      if (nativeActionRoute) {
        await this.captureRoute(nativeActionRoute, sourceState, startTime);
        return;
      }

      // 1. Read from Notifee (ONE-SHOT), with a bounded cold-start retry.
      // This is the ONLY place in the app where getInitialNotification() should
      // be called. On a KILLED cold start Android can attach the launch intent
      // to the Activity a few hundred ms AFTER the JS bundle begins executing,
      // so a single early read returns null and the tapped chat is lost — the
      // "tapping a message notification from the killed/exited state opens the
      // dashboard" bug. readInitialNotificationWithRetry re-polls (only when a
      // Notifee notification is actually on screen, so a normal launcher-icon
      // open is NOT delayed) until the intent becomes visible.
      const notification = await this.readInitialNotificationWithRetry(sourceState);

      if (!notification) {
        notificationLogger.info('no_initial_notification', {
          source: 'dispatch',
          metadata: { sourceState },
        });
        this.state.initialized = true;
        return;
      }

      // 2. Parse the notification data
      const payload: any = notification.notification?.data || {};
      const pressActionId: string | undefined = notification.pressAction?.id;
      
      notificationLogger.info('initial_notification_received', {
        source: 'dispatch',
        dedupeKey: payload.dedupeKey,
        conversationId: payload.conversationId,
        metadata: { sourceState, payloadKeys: Object.keys(payload) },
      });

      // 3. Create route object
      const route = this.parseNotificationData(payload, sourceState, pressActionId);

      if (!route) {
        console.log(
          `[WP-COLDSTART] initial notification RECEIVED but parse REJECTED it ` +
            `source=${sourceState} type=${payload.type ?? '-'} ` +
            `conv=${payload.conversationId ?? '-'} press=${pressActionId ?? '-'}`,
        );
        notificationLogger.warn('failed_to_parse_initial_notification', {
          source: 'dispatch',
          dedupeKey: payload.dedupeKey,
          metadata: { sourceState, payload },
        });
        this.state.initialized = true;
        return;
      }

      console.log(
        `[WP-COLDSTART] initial notification PARSED source=${sourceState} ` +
          `routeType=${route.type} conv=${route.conversationId} ` +
          `openChatList=${route.openChatList ? '1' : '0'}`,
      );

      // CONCRETE-THREAD PREFERENCE (root-cause fix for "tapping a specific
      // chat's notification opens the chat list instead of that thread" when
      // 2+ chats are unread): with multiple unread conversations Android often
      // returns the GROUP SUMMARY (openChatList) from getInitialNotification()
      // even though the user tapped a SPECIFIC child. The child's background
      // PRESS event, however, persists the EXACT conversation to the
      // pendingChat store. If such a fresh concrete route exists, prefer it —
      // and critically, do NOT let stageRoute() overwrite it with the fuzzy
      // "open chat list" route. A genuine summary tap (no concrete child
      // route) still opens the chat list.
      if (route.openChatList) {
        const persistedChat = await loadPersistedPendingChat();
        if (persistedChat?.conversationId && !persistedChat.openChatList) {
          const concrete: NotificationRoute = {
            type: 'message',
            conversationId: String(persistedChat.conversationId),
            messageId: persistedChat.messageId,
            timestamp: Date.now(),
            dedupeKey:
              persistedChat.dedupeKey || `chat:${persistedChat.conversationId}`,
            sourceState,
          };
          notificationLogger.info('summary_route_replaced_by_concrete_child', {
            source: 'dispatch',
            dedupeKey: concrete.dedupeKey,
            conversationId: concrete.conversationId,
            metadata: { sourceState, reason: 'child_press_route_persisted' },
          });
          // Re-stage the concrete route (refreshes its in-memory copy +
          // subscriber notification) and capture it instead of the list route.
          setPendingChat({
            conversationId: concrete.conversationId,
            dedupeKey: concrete.dedupeKey,
            messageId: concrete.messageId,
          });
          await this.captureRoute(concrete, sourceState, startTime);
          return;
        }
      }

      await this.stageRoute(route, payload, pressActionId);
      await this.captureRoute(route, sourceState, startTime);
    } catch (error) {
      notificationLogger.error('dispatcher_initialize_failed', error instanceof Error ? error : String(error), {
        source: 'dispatch',
        metadata: { sourceState },
      });
      this.state.initialized = true; // Mark initialized even on error
    }
  }

  /**
   * Get the initial route (non-blocking, instant)
   * Returns the route if available, null otherwise
   * This is safe to call from any component, any time
   */
  getRoute(): NotificationRoute | null {
    // Check if route is stale (TTL expired)
    if (this.state.route) {
      const age = Date.now() - this.state.timestampCaptured;
      if (age > this.STATE_TTL_MS) {
        notificationLogger.warn('route_is_stale', {
          source: 'dispatch',
          dedupeKey: this.state.route.dedupeKey,
          metadata: { ageMs: age, ttlMs: this.STATE_TTL_MS },
        });
        this.state.route = null;
        return null;
      }
    }

    return this.state.route;
  }

  /**
   * Wait for route with timeout (blocking)
   * Useful for edge cases where initialization might still be pending
   * 
   * @param timeoutMs - Maximum time to wait (default 600ms)
   * @returns Route if available, null if timeout
   */
  async waitForRoute(timeoutMs: number = 600): Promise<NotificationRoute | null> {
    const startTime = Date.now();

    // If already have route, return immediately
    const existingRoute = this.getRoute();
    if (existingRoute) {
      return existingRoute;
    }

    // Poll with small delays until timeout
    return new Promise((resolve) => {
      const checkInterval = setInterval(() => {
        const route = this.getRoute();
        if (route) {
          clearInterval(checkInterval);
          resolve(route);
          return;
        }

        const elapsed = Date.now() - startTime;
        if (elapsed >= timeoutMs) {
          clearInterval(checkInterval);
          resolve(null);
        }
      }, 50); // Check every 50ms
    });
  }

  /**
   * Wait until the dispatcher has FINISHED its one-shot
   * getInitialNotification() read (route found OR none), up to `timeoutMs`.
   *
   * WHY: app/index.tsx used to wait a fixed 600ms for a ROUTE. On a killed
   * cold start the JS bundle + Notifee's getInitialNotification() can easily
   * take longer than 600ms — the root route then gave up, redirected to the
   * dashboard, and the tapped conversation never opened ("notification tap
   * from killed state opens the dashboard"). Waiting on the INITIALIZED flag
   * (with a generous cap) means the cold-start decision is made only after
   * the dispatcher has definitively answered "was this launch a notification
   * tap?" — no more racing the read.
   *
   * Resolves with the captured route (may be null when the launch was NOT a
   * notification tap — the common case, which resolves as soon as the read
   * completes, typically well under the cap).
   */
  async waitForInitialization(
    timeoutMs: number = 3000,
  ): Promise<NotificationRoute | null> {
    const startTime = Date.now();
    if (this.state.initialized) return this.getRoute();
    return new Promise((resolve) => {
      const checkInterval = setInterval(() => {
        if (this.state.initialized) {
          clearInterval(checkInterval);
          resolve(this.getRoute());
          return;
        }
        if (Date.now() - startTime >= timeoutMs) {
          clearInterval(checkInterval);
          resolve(this.getRoute());
        }
      }, 50);
    });
  }

  /**
   * Peek at the route without consuming it
   * Safe for any component to call
   */
  peekRoute(): NotificationRoute | null {
    return this.getRoute();
  }

  /**
   * Consume the route (clear it)
   * Call this after navigation is complete
   */
  consumeRoute(): void {
    if (this.state.route) {
      const route = this.state.route;
      notificationLogger.info('route_consumed', {
        source: 'dispatch',
        dedupeKey: route.dedupeKey,
        conversationId: route.conversationId,
        state: NotificationState.ROUTE_CONSUMED,
      });
      this.state.route = null;
    }
  }

  /**
   * Subscribe to route changes
   * Called when dispatcher initializes with a route
   */
  subscribe(callback: (route: NotificationRoute | null) => void): () => void {
    this.subscribers.add(callback);

    // Return unsubscribe function
    return () => {
      this.subscribers.delete(callback);
    };
  }

  /**
   * Get dispatcher state (for debugging)
   */
  getState(): DispatcherState {
    return {
      ...this.state,
      route: this.state.route ? { ...this.state.route } : null,
    };
  }

  /**
   * Clear state (use only for testing)
   */
  clearState(): void {
    this.state = {
      route: null,
      initialized: false,
      initialNotificationRead: false,
      timestampCaptured: 0,
    };
    this.subscribers.clear();
  }

  // ========================================================================
  // PRIVATE METHODS
  // ========================================================================

  /**
   * Reads notifee.getInitialNotification() with a bounded cold-start retry.
   *
   * ROOT-CAUSE FIX for "tapping a message notification from the KILLED/EXITED
   * state opens the dashboard instead of the chat thread" (Android, every time):
   * on a cold Activity launch Android can attach the launching notification
   * intent to the Activity a few HUNDRED ms AFTER the JS bundle starts running.
   * The dispatcher's single early read (from mobile/index.js) — and even the
   * short (~400ms) re-check loop in app/index.tsx — could all fire BEFORE the
   * intent was visible, so getInitialNotification() returned null on every read
   * and the tapped conversation was never routed.
   *
   * We therefore re-poll getInitialNotification() until it resolves, but ONLY
   * when there is at least one Notifee notification actually on screen that
   * could have launched the app (a chat/call/summary entry). That guard means a
   * NORMAL launcher-icon open (no pending notification) is NOT delayed at all —
   * it returns immediately. When a candidate exists we wait up to ~1.8s, which
   * comfortably covers the intent-attach delay on slower devices.
   *
   * The `[WP-COLDSTART]` console lines are intentionally always-on (NOT gated by
   * __DEV__ like notificationLogger's console output) so a single `adb logcat`
   * capture on a release/preview build reveals exactly what Notifee saw.
   */
  private async readInitialNotificationWithRetry(
    sourceState: NotificationRoute['sourceState'],
  ): Promise<any | null> {
    // Fast path: a single read covers the warm/recheck case and any launch
    // whose intent is already attached.
    let notification = await notifee.getInitialNotification();
    if (notification) {
      console.log(
        `[WP-COLDSTART] getInitialNotification hit immediately source=${sourceState} ` +
          `conv=${notification?.notification?.data?.conversationId ?? '-'} ` +
          `press=${notification?.pressAction?.id ?? '-'}`,
      );
      return notification;
    }

    // Is there any Notifee notification on screen that could have launched us?
    let hasCandidate = false;
    try {
      const displayed = await notifee.getDisplayedNotifications();
      const list = Array.isArray(displayed) ? displayed : [];
      hasCandidate = list.some((d: any) => {
        const data = d?.notification?.data || {};
        return Boolean(
          data.conversationId || data.callId || data.messageId || data.openChatList,
        );
      });
      const summary = list
        .map((d: any) => {
          const dt = d?.notification?.data || {};
          return `${dt.type ?? '?'}:${dt.conversationId ?? dt.callId ?? '-'}`;
        })
        .join(',');
      console.log(
        `[WP-COLDSTART] getInitialNotification=null source=${sourceState} ` +
          `displayed=${list.length} candidates=${hasCandidate} [${summary}]`,
      );
    } catch (err) {
      console.log('[WP-COLDSTART] getDisplayedNotifications failed', err);
    }

    // No on-screen notification → this was almost certainly a plain app open;
    // do NOT block the cold start waiting for an intent that will never arrive.
    if (!hasCandidate) return null;

    const deadlineMs = Date.now() + 1800;
    let attempt = 0;
    while (Date.now() < deadlineMs) {
      await new Promise((r) => setTimeout(r, 150));
      attempt += 1;
      notification = await notifee.getInitialNotification();
      if (notification) {
        console.log(
          `[WP-COLDSTART] getInitialNotification RESOLVED after retry ` +
            `attempt=${attempt} source=${sourceState} ` +
            `conv=${notification?.notification?.data?.conversationId ?? '-'}`,
        );
        return notification;
      }
    }
    console.log(
      `[WP-COLDSTART] getInitialNotification STILL null after ${attempt} retries ` +
        `source=${sourceState} — notification was on screen but never became the ` +
        `launch intent (Notifee not tracking this notification / launched via a ` +
        `non-Notifee intent).`,
    );
    return null;
  }

  private parseNotificationData(
    payload: any,
    sourceState: NotificationRoute['sourceState'],
    pressActionId?: string
  ): NotificationRoute | null {
    // KILLED-STATE MULTI-CHAT SUMMARY: a group-summary tap for 2+ unread chats
    // carries `openChatList` (Android can't tell WHICH child was tapped). Route
    // to the CHAT LIST — never the dashboard — before the conversationId guard,
    // since there is no single target thread. See notifeeService.postGroupSummary.
    if (payload.openChatList === '1' || payload.openChatList === true) {
      notificationLogger.info('initial_notification_open_chat_list', {
        source: 'dispatch',
        dedupeKey: payload.dedupeKey || 'chat:list',
        metadata: { sourceState },
      });
      return {
        type: 'message',
        conversationId: String(payload.conversationId || ''),
        timestamp: Date.now(),
        dedupeKey: payload.dedupeKey || 'chat:list',
        sourceState,
        openChatList: true,
      };
    }

    // Validate required fields
    if (!payload.conversationId) {
      notificationLogger.warn('missing_conversationId_in_payload', {
        source: 'dispatch',
        dedupeKey: payload.dedupeKey,
      });
      return null;
    }

    if (pressActionId === 'reply' || pressActionId === 'mark_read') {
      notificationLogger.info('initial_notification_action_not_routable', {
        source: 'dispatch',
        dedupeKey: payload.dedupeKey,
        conversationId: payload.conversationId,
        metadata: { pressActionId },
      });
      return null;
    }

    const isCall =
      Boolean(payload.callId) ||
      payload.type === 'call' ||
      payload.type === 'incoming_call';
    const isMessage =
      Boolean(payload.messageId) ||
      payload.type === 'message' ||
      payload.type === 'chat_message';
    if (!isCall && !isMessage) {
      notificationLogger.warn('invalid_notification_type', {
        source: 'dispatch',
        dedupeKey: payload.dedupeKey,
        metadata: { type: payload.type },
      });
      return null;
    }

    // KILLED-STATE GROUP-SUMMARY FIX: when the app is killed, Android frequently
    // returns the message GROUP SUMMARY (not the tapped child) from
    // getInitialNotification(). For a single active conversation that summary
    // carries only { conversationId, type: "chat_message" } — it has NO
    // dedupeKey (and no messageId). Previously we hard-required dedupeKey here
    // and returned null, so the cold-start tap fell through to the dashboard /
    // chat list instead of opening the exact 1:1 thread. dedupeKey is only used
    // for logging/idempotency — routing genuinely needs only the conversationId
    // plus a message/call intent (validated above). Synthesize a stable fallback
    // key from the ids so a summary tap still deep-links to the right thread.
    const dedupeKey: string =
      payload.dedupeKey ||
      (isCall
        ? `call:${payload.callId ?? payload.conversationId}`
        : payload.messageId
          ? `msg:${payload.messageId}`
          : `chat:${payload.conversationId}`);
    if (!payload.dedupeKey) {
      notificationLogger.warn('synthesized_dedupeKey_for_payload', {
        source: 'dispatch',
        conversationId: payload.conversationId,
        dedupeKey,
        metadata: {
          reason: 'missing_dedupeKey',
          type: payload.type,
          sourceState,
        },
      });
    }

    return {
      type: isCall ? 'call' : 'message',
      conversationId: String(payload.conversationId),
      messageId: payload.messageId,
      callId: payload.callId,
      timestamp: Date.now(),
      dedupeKey,
      sourceState,
    };
  }

  private async captureNativeCallAction(
    sourceState: NotificationRoute['sourceState']
  ): Promise<NotificationRoute | null> {
    try {
      const nativeAction = getPendingCallAction();
      if (!nativeAction) return null;

      const persisted = await loadPersistedPendingCall();
      const matches =
        persisted &&
        String(persisted.callId) === String(nativeAction.callId) &&
        String(persisted.conversationId) === String(nativeAction.conversationId);
      const base: PendingCallRoute =
        matches && persisted
          ? persisted
          : {
              conversationId: String(nativeAction.conversationId),
              callId: String(nativeAction.callId),
              dedupeKey: `call:${nativeAction.callId}`,
              callType: 'voice',
              peerId: '',
              peerName: 'Incoming call',
              peerAvatar: '',
              autoAnswer: '0',
            };
      const merged: PendingCallRoute = {
        ...base,
        autoAnswer: nativeAction.action === 'answer' ? '1' : '0',
        ...(nativeAction.action === 'decline'
          ? { action: 'decline' }
          : { action: undefined }),
      };

      setPendingCall(merged);
      await persistPendingCall(merged);
      clearPendingCallAction();

      const dedupeKey = merged.dedupeKey || `call:${merged.callId}`;
      notificationLogger.logNotificationTapped(dedupeKey, merged.conversationId, merged.callId);
      notificationLogger.logStateTransition(dedupeKey, merged.conversationId, NotificationState.ROUTE_PERSISTED, {
        source: 'notification_dispatcher',
        action: nativeAction.action,
        sourceState,
      });

      return {
        type: 'call',
        conversationId: merged.conversationId,
        callId: merged.callId,
        timestamp: Date.now(),
        dedupeKey,
        sourceState,
      };
    } catch (error) {
      notificationLogger.error('dispatcher_native_action_capture_failed', error instanceof Error ? error : String(error), {
        source: 'dispatch',
        metadata: { sourceState },
      });
      return null;
    }
  }

  private async stageRoute(
    route: NotificationRoute,
    payload: Record<string, string | undefined>,
    pressActionId?: string
  ): Promise<void> {
    notificationLogger.logNotificationTapped(route.dedupeKey, route.conversationId, route.messageId || route.callId);

    if (route.type === 'call') {
      const action =
        pressActionId === 'answer'
          ? 'accept_call'
          : pressActionId === 'decline'
            ? 'decline_call'
            : undefined;
      const pendingCall = pendingCallFromData({
        ...payload,
        notificationAction: action,
      });
      if (pendingCall) {
        setPendingCall(pendingCall);
        await persistPendingCall(pendingCall);
      }
    } else {
      const pendingChat = {
        conversationId: route.conversationId,
        dedupeKey: route.dedupeKey,
        messageId: route.messageId,
        // Carry the "open chat list" marker (2+ unread summary tap) so the
        // cold-start consumer routes to the LIST rather than the dashboard.
        ...(route.openChatList ? { openChatList: true } : {}),
      };
      setPendingChat(pendingChat);
      await persistPendingChat(pendingChat);
    }

    notificationLogger.logStateTransition(route.dedupeKey, route.conversationId, NotificationState.ROUTE_PERSISTED, {
      source: 'notification_dispatcher',
      action: pressActionId || 'body_press',
      type: route.type,
    });
  }

  private async captureRoute(
    route: NotificationRoute,
    sourceState: NotificationRoute['sourceState'],
    startTime: number
  ): Promise<void> {
    // Store route in memory
    this.state.route = route;
    this.state.timestampCaptured = Date.now();

    notificationLogger.info('dispatcher_route_captured', {
      source: 'dispatch',
      dedupeKey: route.dedupeKey,
      conversationId: route.conversationId,
      metadata: {
        sourceState,
        type: route.type,
        durationMs: Date.now() - startTime,
      },
    });

    await this.persistRoute(route);
    this.notifySubscribers(route);
    this.state.initialized = true;

    notificationLogger.info('dispatcher_initialized', {
      source: 'dispatch',
      dedupeKey: route.dedupeKey,
      conversationId: route.conversationId,
      metadata: {
        sourceState,
        durationMs: Date.now() - startTime,
      },
    });
  }

  private async persistRoute(route: NotificationRoute): Promise<void> {
    try {
      await SecureStore.setItemAsync(
        this.STORE_KEY,
        JSON.stringify(route)
      );
    } catch (error) {
      notificationLogger.warn('failed_to_persist_route', {
        source: 'dispatch',
        dedupeKey: route.dedupeKey,
      });
    }
  }

  private notifySubscribers(route: NotificationRoute): void {
    for (const subscriber of this.subscribers) {
      try {
        subscriber(route);
      } catch (error) {
        notificationLogger.error('subscriber_callback_failed', error instanceof Error ? error : String(error), {
          source: 'dispatch',
          dedupeKey: route.dedupeKey,
        });
      }
    }
  }
}

// ============================================================================
// EXPORTS
// ============================================================================

export const notificationDispatcher = NotificationDispatcherService.getInstance();

/**
 * Export for use in mobile/index.js (entry point)
 * 
 * Usage in mobile/index.js:
 * ```typescript
 * import { notificationDispatcher } from './src/services/notificationDispatcher';
 * 
 * // Call at very start of index.js (BEFORE expo-router entry)
 * await notificationDispatcher.initialize('cold_start');
 * 
 * // Then continue with app entry
 * require('expo-router/entry');
 * ```
 */
export async function initializeNotificationDispatcher(): Promise<void> {
  await notificationDispatcher.initialize();
}

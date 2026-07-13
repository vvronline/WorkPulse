/**
 * Global push notification listener for the WorkPulse app.
 * Handles incoming call notifications, message alerts, and general notifications.
 * Integrates with WebSocket listeners for consistent behavior whether online or backgrounded.
 */

import { useEffect } from "react";
import { useRouter } from "expo-router";
import { Alert, Linking, Platform } from "react-native";
import * as Notifications from "expo-notifications";
import { pushNotificationService, type NotificationPayload } from "../services/pushNotificationService";
import { socket } from "./socket";
import { emitChatUnreadChanged, chatUnreadManager } from "./chatUnreadEvents";
import { backgroundPushService } from "../services/backgroundPushService";
import { notifeeService } from "../services/notifeeService";
import { beginCallNavigation, endCallNavigation } from "./callRouting";
import {
  persistPendingChat,
  setPendingChat,
  type PendingChatRoute,
} from "./pendingChat";
import { notificationLogger, NotificationState } from "../utils/notificationLogger";

/**
 * Root-level listener that handles all incoming push notifications.
 * Should be mounted once in the app root (_layout.tsx).
 */
export default function PushNotificationListener() {
  const router = useRouter();

  useEffect(() => {
    // T032: Check notification permissions on mount and offer recovery if denied
    checkAndRecoverPermissions().catch(() => {});
    // Android 14+: ensure the full-screen-intent permission so the incoming-call
    // screen can surface over the lock screen (otherwise only the ring sound
    // plays and the user is forced to open the app to answer/reject).
    notifeeService.ensureFullScreenIntentPermission().catch(() => {});
  }, []);

  useEffect(() => {
    const unsubscribe = pushNotificationService.subscribe((notification) => {
      // expo-notifications types data as Record<string, unknown> — safely
      // convert to Record<string, string | undefined> for our payload
      const rawData = notification.request.content.data as Record<string, unknown>;
      const safeData: NotificationPayload["data"] = Object.fromEntries(
        Object.entries(rawData).map(([k, v]) => [k, typeof v === "string" ? v : String(v ?? "")]),
      );
      const payload: NotificationPayload = {
        title: notification.request.content.title || "",
        body: notification.request.content.body || "",
        data: safeData,
      };

      const isNotificationResponse = safeData.notificationResponse === "1";
      if (!isNotificationResponse) {
        backgroundPushService.handleNotificationPayload(payload).catch((err) => {
          console.warn("Failed to route push payload through background service:", err);
        });
      }
      handlePushNotification(payload, router);
    });

    return unsubscribe;
  }, [router]);

  return null;
}

/**
 * T032: Check notification permissions and offer recovery if denied.
 * Prompts user to enable notifications in settings if they denied permissions.
 */
async function checkAndRecoverPermissions(): Promise<void> {
  try {
    const permissions = await Notifications.getPermissionsAsync();
    
    if (permissions.status === "granted") {
      console.debug('[PushNotificationListener] Notification permissions granted');
      return;
    }

    if (permissions.status === "denied") {
      console.warn('[PushNotificationListener] Notification permissions denied by user');
      
      // T032: Show recovery UX with settings deep-link
      setTimeout(() => {
        Alert.alert(
          "Enable Notifications",
          "To receive incoming calls and messages, please enable notifications in your device settings.",
          [
            {
              text: "Cancel",
              onPress: () => {
                console.debug('[PushNotificationListener] User dismissed permission recovery');
              },
              style: "cancel",
            },
            {
              text: "Open Settings",
              onPress: () => {
                console.info('[PushNotificationListener] User opened notification settings');
                // Deep-link to platform-specific notification settings
                if (Platform.OS === "android") {
                  Linking.openSettings().catch(() => {
                    console.error('[PushNotificationListener] Failed to open Android settings');
                  });
                } else if (Platform.OS === "ios") {
                  Linking.openURL("app-settings://notification").catch(() => {
                    // Fallback: open general settings
                    Linking.openSettings().catch(() => {
                      console.error('[PushNotificationListener] Failed to open iOS settings');
                    });
                  });
                }
              },
            },
          ],
          { cancelable: false },
        );
      }, 1000); // Delay to let app mount fully
    }
  } catch (err) {
    console.error('[PushNotificationListener] Permission check failed', err);
  }
}

/**
 * Route the push notification to the appropriate handler based on type.
 */
function handlePushNotification(payload: NotificationPayload, router: any): void {
  const { data } = payload;
  if (!data) return;
  const isNotificationResponse = data.notificationResponse === "1";

  // Incoming call notification
  if (data.callId && data.conversationId) {
    handleCallNotification(
      {
        callId: parseInt(data.callId, 10),
        conversationId: parseInt(data.conversationId, 10),
        callerId: data.callerId
          ? parseInt(data.callerId, 10)
          : data.senderId
            ? parseInt(data.senderId, 10)
            : 0,
        callType: (data.callType as "voice" | "video") || "voice",
        callerName: data.callerName,
        callerAvatar: data.callerAvatar,
        notificationAction: data.notificationAction,
        meetingCode: data.meetingCode || undefined,
      },
      router,
    );
  }
  // Message notification
  else if (
    !data.callId &&
    (data.conversationId || data.openChatList === "1") &&
    (data.messageId ||
      data.type === "chat_message" ||
      data.type === "message" ||
      data.openChatList === "1")
  ) {
    handleMessageNotification(
      {
        conversationId: data.conversationId || "",
        messageId: data.messageId,
        senderId: data.senderId ? parseInt(data.senderId, 10) : 0,
        senderName: payload.title,
        unreadCount: data.unreadCount ? parseInt(data.unreadCount, 10) : undefined,
        dedupeKey: data.dedupeKey,
        notificationResponse: isNotificationResponse,
        openChatList: data.openChatList === "1",
      },
      router,
    );
  }
  // General notification
  else if (data.notificationId) {
    handleGeneralNotification(
      {
        notificationId: parseInt(data.notificationId, 10),
        title: payload.title,
        body: payload.body,
      },
      router,
    );
  }
}

/**
 * Handle incoming call notifications.
 * Since WebSocket and push notifications both deliver call_incoming,
 * the IncomingCallListener will handle navigation.
 * This handler just ensures we have the data available.
 */
function handleCallNotification(
  callData: {
    callId: number;
    conversationId: number;
    callerId: number;
    callType: "voice" | "video";
    callerName?: string;
    callerAvatar?: string;
    isGroup?: boolean;
    notificationAction?: string;
    meetingCode?: string;
  },
  router: any,
): void {
  console.log("Handling call notification:", callData);

  if (callData.notificationAction === "decline_call") {
    socket.send("call_reject", {
      callId: callData.callId,
      conversationId: callData.conversationId,
    });
    endCallNavigation();
    return;
  }

  // Group CALL (huddle): a `meetingCode` means the callee joins the n-way
  // meeting mesh, not the 1:1 p2p call screen. Claim navigation (so the WS path
  // doesn't double-push) and route straight to the meeting room.
  if (callData.meetingCode) {
    const isAcceptHuddle = callData.notificationAction === "accept_call";
    if (
      !beginCallNavigation(callData.callId, callData.conversationId) &&
      !isAcceptHuddle
    ) {
      return;
    }
    // Huddle auto-join (no meeting lobby) + audio-only for a voice call.
    const ct = callData.callType === "video" ? "video" : "voice";
    router.push(
      `/meeting/${callData.meetingCode}?huddle=1&callType=${ct}` as never,
    );
    return;
  }

  // Cross-path guard: IncomingCallListener (websocket) may also navigate for
  // this same call. Claim navigation so only ONE path pushes the /call screen —
  // a double push crashes React Native Fabric ("child already has a parent").
  // Exception: when the user tapped "Answer" we still want to ensure the screen
  // is shown, so only skip if it's already active for THIS call.
  const isAccept = callData.notificationAction === "accept_call";
  if (!beginCallNavigation(callData.callId, callData.conversationId) && !isAccept) {
    return;
  }

  router.push({
    pathname: "/call/[conversationId]",
    params: {
      conversationId: String(callData.conversationId),
      mode: "incoming",
      callType: callData.callType,
      callId: String(callData.callId),
      peerId: String(callData.callerId || ""),
      peerName: callData.callerName || "Incoming call",
      peerAvatar: callData.callerAvatar || "",
      isGroup: callData.isGroup ? "1" : "0",
      autoAnswer: callData.notificationAction === "accept_call" ? "1" : "0",
    },
  });
}

/**
 * Handle incoming message notifications.
 * Optionally navigate to the chat screen or just show the notification badge.
 */
function handleMessageNotification(
  messageData: {
    conversationId: string;
    messageId?: string;
    senderId: number;
    senderName: string;
    unreadCount?: number;
    dedupeKey?: string;
    notificationResponse?: boolean;
    openChatList?: boolean;
  },
  router: any,
): void {
  console.log("Handling message notification:", messageData);
  const convIdNum = Number(messageData.conversationId);

  // T032: Update unread manager with server-authoritative count if provided
  if (
    messageData.unreadCount !== undefined &&
    Number.isFinite(convIdNum) &&
    convIdNum > 0
  ) {
    chatUnreadManager.updateUnreadCount(convIdNum, messageData.unreadCount);
  }

  emitChatUnreadChanged();

  if (messageData.notificationResponse) {
    const route = buildPendingChatRouteFromMessageNotification(messageData);
    if (!route) {
      notificationLogger.warn("message_notification_tap_missing_route", {
        source: "PushNotificationListener",
        dedupeKey: messageData.dedupeKey,
        conversationId: messageData.conversationId,
        messageId: messageData.messageId,
      });
      return;
    }

    void persistPendingChat(route).catch((err) => {
      notificationLogger.warn("message_notification_tap_persist_failed", {
        source: "PushNotificationListener",
        dedupeKey: route.dedupeKey,
        conversationId: route.conversationId,
        messageId: route.messageId,
        metadata: { error: err instanceof Error ? err.message : String(err) },
      });
    });
    setPendingChat(route);
    notificationLogger.logStateTransition(
      route.dedupeKey ||
        (route.openChatList ? "chat:list" : `chat:${route.conversationId}`),
      route.conversationId,
      NotificationState.ROUTE_PERSISTED,
      {
        source: "PushNotificationListener",
        action: "expo_notification_response",
        target: route.openChatList ? "chat_list" : "chat_thread",
      },
    );
    return;
  }

  // For now, just log. The user will tap the notification in their
  // notification center to open the app and navigate.
}

function buildPendingChatRouteFromMessageNotification(messageData: {
  conversationId: string;
  messageId?: string;
  dedupeKey?: string;
  openChatList?: boolean;
}): PendingChatRoute | null {
  const conversationId = String(messageData.conversationId || "").trim();
  const openChatList = Boolean(messageData.openChatList);
  if (!conversationId && !openChatList) return null;

  const dedupeKey =
    messageData.dedupeKey ||
    (openChatList
      ? "chat:list"
      : messageData.messageId
        ? `msg:${messageData.messageId}`
        : `chat:${conversationId}`);

  return {
    conversationId: openChatList ? "" : conversationId,
    dedupeKey,
    messageId: messageData.messageId,
    ...(openChatList ? { openChatList: true } : {}),
  };
}

/**
 * Handle general app notifications.
 * Navigate to the notifications screen.
 */
function handleGeneralNotification(
  notificationData: {
    notificationId: number;
    title: string;
    body: string;
  },
  router: any,
): void {
  console.log("Handling general notification:", notificationData);

  // Navigate to notifications screen
  // Uncomment to navigate automatically:
  // router.push('/notifications');
}

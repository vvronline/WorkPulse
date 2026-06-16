/**
 * Global push notification listener for the WorkPulse app.
 * Handles incoming call notifications, message alerts, and general notifications.
 * Integrates with WebSocket listeners for consistent behavior whether online or backgrounded.
 */

import { useEffect } from "react";
import { useRouter } from "expo-router";
import { pushNotificationService, type NotificationPayload } from "../services/pushNotificationService";
import { socket } from "./socket";
import { emitChatUnreadChanged } from "./chatUnreadEvents";

/**
 * Root-level listener that handles all incoming push notifications.
 * Should be mounted once in the app root (_layout.tsx).
 */
export default function PushNotificationListener() {
  const router = useRouter();

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

      handlePushNotification(payload, router);
    });

    return unsubscribe;
  }, [router]);

  return null;
}

/**
 * Route the push notification to the appropriate handler based on type.
 */
function handlePushNotification(payload: NotificationPayload, router: any): void {
  const { data } = payload;
  if (!data) return;

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
      },
      router,
    );
  }
  // Message notification
  else if (data.conversationId && data.messageId && !data.callId) {
    handleMessageNotification(
      {
        conversationId: parseInt(data.conversationId, 10),
        messageId: parseInt(data.messageId, 10),
        senderId: data.senderId ? parseInt(data.senderId, 10) : 0,
        senderName: payload.title,
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
    notificationAction?: string;
  },
  router: any,
): void {
  console.log("Handling call notification:", callData);

  if (callData.notificationAction === "decline_call") {
    socket.send("call_reject", {
      callId: callData.callId,
      conversationId: callData.conversationId,
    });
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
    conversationId: number;
    messageId: number;
    senderId: number;
    senderName: string;
  },
  router: any,
): void {
  console.log("Handling message notification:", messageData);
  emitChatUnreadChanged();

  // Optionally auto-navigate to chat
  // Uncomment to navigate automatically on tap:
  // router.push({
  //   pathname: '/chat/[conversationId]',
  //   params: { conversationId: String(messageData.conversationId) },
  // });

  // For now, just log. The user will tap the notification in their
  // notification center to open the app and navigate.
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

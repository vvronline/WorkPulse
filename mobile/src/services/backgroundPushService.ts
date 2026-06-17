import { Platform } from "react-native";
import * as Notifications from "expo-notifications";
import { nativeCallService } from "./nativeCallService";
import type { NotificationPayload } from "./pushNotificationService";
import { buildNotificationPayload } from "./pushNotificationService";

type RemoteMessage = {
  notification?: {
    title?: string;
    body?: string;
  };
  data?: Record<string, unknown>;
};

class BackgroundPushService {
  private initialized = false;
  private messaging: any | null = null;

  /**
   * Registers the FCM background/terminated-state message handler.
   *
   * IMPORTANT: This MUST run at the JS entry top-level (see `mobile/index.js`),
   * NOT inside a React component lifecycle. When the app is killed, React Native
   * Firebase spawns a headless JS task — the React tree never mounts, so any
   * `useEffect`-based registration would be skipped and call/message pushes
   * would be silently dropped in the terminated state.
   */
  initialize() {
    if (this.initialized) return;
    this.messaging = this.resolveMessagingModule();
    if (this.messaging) {
      this.registerBackgroundHandlerSafely();
    }
    this.initialized = true;
  }

  private registerBackgroundHandlerSafely(): void {
    try {
      if (!this.hasDefaultFirebaseApp()) {
        console.warn("[BackgroundPushService] Firebase default app not available; background FCM handler disabled.");
        return;
      }

      this.messaging?.().setBackgroundMessageHandler(async (remoteMessage: RemoteMessage) => {
        await this.handleRemoteMessage(remoteMessage);
      });
    } catch (err) {
      console.warn("[BackgroundPushService] Failed to register background FCM handler:", err);
    }
  }

  private hasDefaultFirebaseApp(): boolean {
    try {
      const module = require("@react-native-firebase/app");
      const firebaseApp = module?.default || module;

      if (typeof firebaseApp?.app === "function") {
        firebaseApp.app();
        return true;
      }

      const apps = firebaseApp?.apps;
      return Array.isArray(apps) && apps.length > 0;
    } catch {
      return false;
    }
  }

  private resolveMessagingModule(): any | null {
    try {
      const module = require("@react-native-firebase/messaging");
      return module?.default || module;
    } catch {
      return null;
    }
  }

  private async handleRemoteMessage(remoteMessage: RemoteMessage): Promise<void> {
    const payload = buildNotificationPayload(
      remoteMessage.notification?.title,
      remoteMessage.notification?.body,
      remoteMessage.data || {},
    );
    await this.handleNotificationPayload(payload);
  }

  async handleNotificationPayload(payload: NotificationPayload): Promise<void> {
    const data = payload.data;
    if (!data) return;

    if (data.callId && data.conversationId) {
      // Incoming call: present the native call screen via CallKeep so the user
      // can answer without opening the app. Call pushes are data-only (no
      // `notification` block) so this handler is guaranteed to run on Android
      // even when the app is killed.
      await nativeCallService.reportIncomingCall(data);
      if (data.notificationAction === "accept_call") {
        await nativeCallService.handleAction("answer", data);
      } else if (data.notificationAction === "decline_call") {
        await nativeCallService.handleAction("reject", data);
      }
      return;
    }

    // Message / general notification: when delivered as a data-only message in
    // the background, the OS will NOT auto-render it, so we post a local
    // notification into the status bar ourselves.
    await this.presentDataNotification(payload);
  }

  /**
   * Presents a status-bar notification for non-call data messages received in
   * the background/terminated state. Ensures the Android channel exists before
   * posting so the notification is not dropped on first-run / killed delivery.
   */
  private async presentDataNotification(payload: NotificationPayload): Promise<void> {
    const data = payload.data || {};
    const title = payload.title || data.senderName || "New notification";
    const body = payload.body || "";
    if (!title && !body) return;

    try {
      const channelId = await this.resolveChannelId(data);
      await Notifications.scheduleNotificationAsync({
        content: {
          title,
          body,
          data,
          sound: "default",
          ...(Platform.OS === "android" ? { channelId } : {}),
        },
        trigger: null,
      });
    } catch (err) {
      console.warn("Failed to present background data notification:", err);
    }
  }

  /**
   * Ensures the target Android notification channel exists (channels created at
   * app launch may not exist yet during killed-state delivery) and returns the
   * channel id to post into.
   */
  private async resolveChannelId(data: Record<string, string | undefined>): Promise<string> {
    if (Platform.OS !== "android") return "default";
    const isMessage = Boolean(data.messageId || data.conversationId) || data.type === "chat_message" || data.type === "message";
    const channelId = isMessage ? "messages" : "default";
    try {
      if (channelId === "messages") {
        await Notifications.setNotificationChannelAsync("messages", {
          name: "Messages",
          description: "Chat message alerts",
          importance: Notifications.AndroidImportance.HIGH,
          sound: "default",
          lockscreenVisibility: Notifications.AndroidNotificationVisibility.PRIVATE,
          vibrationPattern: [0, 160, 80, 160],
          enableVibrate: true,
          enableLights: true,
          lightColor: "#FF6B6B",
        });
      } else {
        await Notifications.setNotificationChannelAsync("default", {
          name: "Default",
          description: "General alerts",
          importance: Notifications.AndroidImportance.HIGH,
          sound: "default",
          lockscreenVisibility: Notifications.AndroidNotificationVisibility.PRIVATE,
          vibrationPattern: [0, 160, 80, 160],
        });
      }
    } catch {
      return "default";
    }
    return channelId;
  }
}

export const backgroundPushService = new BackgroundPushService();

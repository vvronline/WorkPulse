/**
 * Push notification service for React Native (Expo).
 * Handles FCM registration, device token management, and notification handling.
 */

import { useState, useEffect } from "react";
import { Platform } from "react-native";
import * as Notifications from "expo-notifications";
import { API_BASE_URL } from "../config";
import { getToken } from "../auth/tokenStore";

export interface NotificationPayload {
  title: string;
  body: string;
  data?: {
    callId?: string;
    conversationId?: string;
    callType?: string;
    messageId?: string;
    senderId?: string;
    notificationId?: string;
    [key: string]: string | undefined;
  };
}

export function normalizeNotificationData(rawData: Record<string, unknown>): NotificationPayload["data"] {
  return Object.fromEntries(
    Object.entries(rawData).map(([k, v]) => [k, typeof v === "string" ? v : String(v ?? "")]),
  );
}

export function buildNotificationPayload(
  title: string | null | undefined,
  body: string | null | undefined,
  rawData: Record<string, unknown>,
): NotificationPayload {
  return {
    title: title || "",
    body: body || "",
    data: normalizeNotificationData(rawData),
  };
}

/**
 * Singleton service for managing push notifications via Firebase Cloud Messaging.
 * - Requests notification permissions on iOS/Android
 * - Registers FCM device token with backend
 * - Handles incoming notifications and deep links
 * - Manages notification channels (Android)
 */
class PushNotificationService {
  private initialized = false;
  private deviceToken: string | null = null;
  private lastRegisteredAuthToken: string | null = null;
  private listeners: ((notification: Notifications.Notification) => void)[] = [];
  private pendingNotifications: Notifications.Notification[] = [];
  private foregroundSubscription: Notifications.EventSubscription | null = null;
  private responseSubscription: Notifications.EventSubscription | null = null;

  async initialize(): Promise<void> {
    if (this.initialized) return;

    try {
      Notifications.setNotificationHandler({
        handleNotification: async (_notification) => ({
          shouldShowAlert: true,
          shouldPlaySound: true,
          shouldSetBadge: true,
          shouldShowBanner: true,
          shouldShowList: true,
        }),
      });

      if (Platform.OS === "android") {
        await this.setupAndroidChannels();
      }
      await this.setupNotificationCategories();

      // Request notification permissions
      const existingPermissions = await Notifications.getPermissionsAsync();
      const permissionResult =
        existingPermissions.status === "granted"
          ? existingPermissions
          : await Notifications.requestPermissionsAsync();
      const { status } = permissionResult;

      if (status !== "granted") {
        console.warn("Notification permissions not granted");
        return;
      }

      // Get the raw FCM/APNs device token (used directly with Firebase Admin SDK)
      const devicePushToken = await Notifications.getDevicePushTokenAsync();
      this.deviceToken = devicePushToken.data;

      console.log("Device Push Token type:", devicePushToken.type);

      // Set up notification handlers
      this.setupNotificationHandlers();

      // Handle cold start from a notification tap/action.
      const lastResponse = await Notifications.getLastNotificationResponseAsync();
      if (lastResponse) {
        this.handleNotificationResponse(lastResponse);
      }

      // Register device token with backend when a user token exists.
      await this.registerDeviceTokenForCurrentUser();

      this.initialized = true;
      console.log("Push notification service initialized");
    } catch (err) {
      console.error("Failed to initialize push notifications:", err);
    }
  }

  private async setupAndroidChannels(): Promise<void> {
    await Notifications.setNotificationChannelAsync("default", {
      name: "Default",
      description: "General alerts",
      importance: Notifications.AndroidImportance.HIGH,
      sound: "default",
      lockscreenVisibility: Notifications.AndroidNotificationVisibility.PRIVATE,
      vibrationPattern: [0, 160, 80, 160],
    });
    await Notifications.setNotificationChannelAsync("calls", {
      name: "Calls",
      description: "Incoming call alerts",
      importance: Notifications.AndroidImportance.MAX,
      sound: "default",
      lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
      vibrationPattern: [0, 200, 120, 200],
      bypassDnd: true,
    });
    // T027: Enhanced messages channel for status-bar notification visibility
    await Notifications.setNotificationChannelAsync("messages", {
      name: "Messages",
      description: "Chat message alerts",
      importance: Notifications.AndroidImportance.HIGH,
      sound: "default",
      lockscreenVisibility: Notifications.AndroidNotificationVisibility.PRIVATE,
      vibrationPattern: [0, 160, 80, 160],
      enableVibrate: true,
      enableLights: true,
      lightColor: "#FF6B6B", // Red notification light
    });
    await Notifications.setNotificationChannelAsync("notifications", {
      name: "Notifications",
      description: "General alerts",
      importance: Notifications.AndroidImportance.DEFAULT,
      sound: "default",
      lockscreenVisibility: Notifications.AndroidNotificationVisibility.PRIVATE,
    });
  }

  private async setupNotificationCategories(): Promise<void> {
    await Notifications.setNotificationCategoryAsync("incoming-call", [
      {
        identifier: "accept_call",
        buttonTitle: "Answer",
      },
      {
        identifier: "decline_call",
        buttonTitle: "Decline",
        options: { isDestructive: true },
      },
    ]);
  }

  private setupNotificationHandlers(): void {
    if (this.foregroundSubscription || this.responseSubscription) return;

    // Handle notifications received while app is in foreground
    this.foregroundSubscription = Notifications.addNotificationReceivedListener((notification) => {
      this.handleNotificationReceived(notification);
    });

    // Handle notification taps
    this.responseSubscription = Notifications.addNotificationResponseReceivedListener((response) => {
      this.handleNotificationResponse(response);
    });
  }

  private handleNotificationReceived(notification: Notifications.Notification): void {
    const { request } = notification;
    const { content } = request;

    console.log("Notification received:", content.title, content.body);

    // Trigger all registered listeners (or queue until listeners mount).
    if (this.listeners.length === 0) {
      this.pendingNotifications.push(notification);
      return;
    }
    this.listeners.forEach((listener) => {
      try {
        listener(notification);
      } catch (err) {
        console.error("Listener error:", err);
      }
    });
  }

  private handleNotificationResponse(response: Notifications.NotificationResponse): void {
    const { notification, actionIdentifier } = response;
    const { request } = notification;
    const { content } = request;
    const data = normalizeNotificationData((content.data || {}) as Record<string, unknown>);
    const enrichedData: Record<string, string | undefined> = {
      ...data,
      notificationAction:
        actionIdentifier && actionIdentifier !== Notifications.DEFAULT_ACTION_IDENTIFIER
          ? actionIdentifier
          : undefined,
    };

    console.log("Notification response:", enrichedData);

    // Handle deep links based on notification type
    if (enrichedData.callId) {
      // Incoming call notification
      console.log("Navigating to call:", enrichedData.conversationId);
      // Navigation handled by IncomingCallListener
    } else if (enrichedData.conversationId) {
      // Message notification
      console.log("Navigating to chat:", enrichedData.conversationId);
      // Navigation handled by the app
    } else if (enrichedData.notificationId) {
      // General notification
      console.log("Navigating to notifications");
    }

    // Trigger listeners (or queue until listeners mount).
    if (this.listeners.length === 0) {
      this.pendingNotifications.push({
        ...notification,
        request: {
          ...notification.request,
          content: {
            ...notification.request.content,
            data: enrichedData,
          },
        },
      });
      return;
    }
    this.listeners.forEach((listener) => {
      try {
        listener({
          ...notification,
          request: {
            ...notification.request,
            content: {
              ...notification.request.content,
              data: enrichedData,
            },
          },
        });
      } catch (err) {
        console.error("Listener error:", err);
      }
    });
  }

  async registerDeviceTokenForCurrentUser(force = false): Promise<void> {
    if (!this.deviceToken) {
    console.warn("No device token available for registration");
    return;
    }

    try {
      const userToken = await getToken();
      if (!userToken) {
        console.warn("User not authenticated — skipping device token registration");
        this.lastRegisteredAuthToken = null;
        return;
      }

      if (!force && this.lastRegisteredAuthToken === userToken) {
        return;
      }

      // Determine platform — backend accepts "ios" | "android" | "web" only
      const platform = Platform.OS === "ios" ? "ios" : Platform.OS === "android" ? "android" : "web";

      const response = await fetch(`${API_BASE_URL}/auth/device-token`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${userToken}`,
        },
        body: JSON.stringify({
          deviceToken: this.deviceToken,
          platform,
        }),
      });

      if (!response.ok) {
        console.error("Failed to register device token:", response.status);
        return;
      }

      this.lastRegisteredAuthToken = userToken;
      console.log("Device token registered successfully");
    } catch (err) {
      console.error("Error registering device token:", err);
    }
  }

  subscribe(listener: (notification: Notifications.Notification) => void): () => void {
    this.listeners.push(listener);
    if (this.pendingNotifications.length > 0) {
      const pending = [...this.pendingNotifications];
      this.pendingNotifications = [];
      pending.forEach((notification) => {
        try {
          listener(notification);
        } catch (err) {
          console.error("Listener error:", err);
        }
      });
    }
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  getDeviceToken(): string | null {
    return this.deviceToken;
  }

  /**
   * T027: Set application icon badge count (launcher badge).
   * Supports Android and iOS launcher badge display.
   */
  async setBadgeCount(count: number): Promise<void> {
    try {
      await Notifications.setBadgeCountAsync(count);
      console.log(`[PushNotificationService] Badge set to ${count}`);
    } catch (err) {
      console.error('[PushNotificationService] Failed to set badge count:', err);
    }
  }

  /**
   * T027: Get current application badge count.
   */
  async getBadgeCount(): Promise<number> {
    try {
      return await Notifications.getBadgeCountAsync();
    } catch (err) {
      console.error('[PushNotificationService] Failed to get badge count:', err);
      return 0;
    }
  }

  /**
   * T027: Clear application badge count (set to 0).
   */
  async clearBadge(): Promise<void> {
    await this.setBadgeCount(0);
  }
}

// Export singleton instance
export const pushNotificationService = new PushNotificationService();

/**
 * React hook for managing push notifications in components.
 * Automatically initializes the service and handles notification listeners.
 */
export function usePushNotifications(): {
  deviceToken: string | null;
  initialized: boolean;
} {
  const [deviceToken, setDeviceToken] = useState<string | null>(null);
  const [initialized, setInitialized] = useState(false);

  useEffect(() => {
    const initPushNotifications = async () => {
      try {
        await pushNotificationService.initialize();
        setDeviceToken(pushNotificationService.getDeviceToken());
        setInitialized(true);
      } catch (err) {
        console.error("Failed to initialize push notifications:", err);
      }
    };

    initPushNotifications();

    return () => {
      // Cleanup if needed
    };
  }, []);

  return { deviceToken, initialized };
}

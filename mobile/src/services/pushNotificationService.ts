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
  private listeners: ((notification: Notifications.Notification) => void)[] = [];

  async initialize(): Promise<void> {
    if (this.initialized) return;

    try {
      // Request notification permissions
      const { status } = await Notifications.requestPermissionsAsync();

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

      // Register device token with backend
      await this.registerDeviceToken();

      this.initialized = true;
      console.log("Push notification service initialized");
    } catch (err) {
      console.error("Failed to initialize push notifications:", err);
    }
  }

  private setupNotificationHandlers(): void {
    // Handle notifications received while app is in foreground
    const foregroundSubscription = Notifications.addNotificationReceivedListener((notification) => {
      this.handleNotificationReceived(notification);
    });

    // Handle notification taps
    const responseSubscription = Notifications.addNotificationResponseReceivedListener((response) => {
      this.handleNotificationResponse(response.notification);
    });

    // Set notification handler configuration
    Notifications.setNotificationHandler({
      handleNotification: async (_notification) => ({
        shouldShowAlert: true,
        shouldPlaySound: true,
        shouldSetBadge: true,
        shouldShowBanner: true,
        shouldShowList: true,
      }),
    });
  }

  private handleNotificationReceived(notification: Notifications.Notification): void {
    const { request } = notification;
    const { content } = request;

    console.log("Notification received:", content.title, content.body);

    // Trigger all registered listeners
    this.listeners.forEach((listener) => {
      try {
        listener(notification);
      } catch (err) {
        console.error("Listener error:", err);
      }
    });
  }

  private handleNotificationResponse(notification: Notifications.Notification): void {
    const { request } = notification;
    const { content } = request;
    const data = content.data || {};

    console.log("Notification response:", data);

    // Handle deep links based on notification type
    if (data.callId) {
      // Incoming call notification
      console.log("Navigating to call:", data.conversationId);
      // Navigation handled by IncomingCallListener
    } else if (data.conversationId) {
      // Message notification
      console.log("Navigating to chat:", data.conversationId);
      // Navigation handled by the app
    } else if (data.notificationId) {
      // General notification
      console.log("Navigating to notifications");
    }

    // Trigger listeners
    this.listeners.forEach((listener) => {
      try {
        listener(notification);
      } catch (err) {
        console.error("Listener error:", err);
      }
    });
  }

  private async registerDeviceToken(): Promise<void> {
    if (!this.deviceToken) {
      console.warn("No device token available for registration");
      return;
    }

    try {
      const userToken = await getToken();
      if (!userToken) {
        console.warn("User not authenticated — skipping device token registration");
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

      console.log("Device token registered successfully");
    } catch (err) {
      console.error("Error registering device token:", err);
    }
  }

  subscribe(listener: (notification: Notifications.Notification) => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  getDeviceToken(): string | null {
    return this.deviceToken;
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

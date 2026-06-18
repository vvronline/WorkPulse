import { AppState, Platform } from "react-native";
import * as Notifications from "expo-notifications";
import { nativeCallService } from "./nativeCallService";
import { notifeeService } from "./notifeeService";
import type { NotificationPayload } from "./pushNotificationService";
import { buildNotificationPayload, pushNotificationService } from "./pushNotificationService";

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
  private foregroundUnsub: (() => void) | null = null;

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
    // Register the Notifee background event handler (Answer/Decline taps from
    // the full-screen call notification) at the JS entry top-level too, so it
    // works in the terminated/headless state. Idempotent + safe if unavailable.
    notifeeService.registerBackgroundHandler();
    this.initialized = true;
  }

  /**
   * Registers the FCM FOREGROUND message handler (`messaging().onMessage`).
   *
   * CRITICAL: The server sends DATA-ONLY FCM payloads (no top-level
   * `notification` block) for calls AND messages so the background/headless
   * handler always runs. The side-effect is that when the app is in the
   * FOREGROUND, Android delivers these as data messages that DO NOT trigger any
   * system notification and DO NOT fire `expo-notifications`
   * `addNotificationReceivedListener`. Without an explicit `onMessage` handler,
   * foreground message/notification pushes are silently dropped (no status-bar
   * notification, no incoming-call UI). This wires that missing path through the
   * same `handleNotificationPayload` used by the background handler.
   *
   * Safe to call repeatedly; only registers once. No-ops if the native
   * messaging module / default Firebase app is unavailable (e.g. Expo Go).
   */
  registerForegroundHandler(): void {
    if (this.foregroundUnsub) return;
    try {
      this.messaging = this.messaging || this.resolveMessagingModule();
      if (!this.messaging) return;
      if (!this.hasDefaultFirebaseApp()) {
        console.warn("[BackgroundPushService] Firebase default app not available; foreground FCM handler disabled.");
        return;
      }
      const unsub = this.messaging?.().onMessage(async (remoteMessage: RemoteMessage) => {
        await this.handleRemoteMessage(remoteMessage);
      });
      this.foregroundUnsub = typeof unsub === "function" ? unsub : null;
    } catch (err) {
      console.warn("[BackgroundPushService] Failed to register foreground FCM handler:", err);
    }
  }

  /** Unsubscribes the foreground FCM message handler (if registered). */
  unregisterForegroundHandler(): void {
    try {
      this.foregroundUnsub?.();
    } catch {
      // ignore
    }
    this.foregroundUnsub = null;
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

    // Call lifecycle cancel events: clear any ringing call notification so it
    // stops ringing / disappears when the caller hangs up or it's handled
    // elsewhere. These may arrive as data pushes while backgrounded/terminated.
    if (
      data.type === "call_ended" ||
      data.type === "call_rejected" ||
      data.type === "call_cancelled" ||
      data.type === "call_handled_elsewhere"
    ) {
      await notifeeService.cancelCall(data.callId, data.conversationId);
      return;
    }

    if (data.callId && data.conversationId) {
      // Incoming call. On iOS, prefer the native CallKeep/CallKit UI. On Android
      // (where CallKeep is disabled) and any build without native call UI, render
      // a full-screen-intent incoming-call notification via Notifee — this is
      // what reliably surfaces the WhatsApp/Teams-style incoming-call screen
      // over the lock screen even when the app is terminated. expo-notifications
      // cannot do full-screen intent and is unreliable from the headless task,
      // which is why we use Notifee here.
      await nativeCallService.reportIncomingCall(data);

      // APP-STATE GATE (Android, no native CallKeep):
      //   • active     → the app is OPEN and visible. The in-app
      //     IncomingCallListener (websocket `call_incoming`) already renders the
      //     full-screen call UI. Posting a Notifee notification here too would
      //     DUPLICATE it (full-screen UI + a status-bar incoming-call entry), so
      //     we SKIP the notification and let the in-app UI own the ring.
      //   • background/inactive → the user is on another app or the screen is
      //     locked/killed. Notifee renders the heads-up status-bar incoming call
      //     (other app in use) or the full-screen-intent call screen over the
      //     lock screen / when no app is foregrounded (killed/headless). This is
      //     the ONLY surface in that state, so we MUST post it.
      const appIsForeground = AppState.currentState === "active";

      if (!nativeCallService.isNativeAvailable() && !appIsForeground) {
        if (notifeeService.isAvailable()) {
          await notifeeService.displayIncomingCall(data);
        } else {
          // Last-resort fallback (e.g. Expo Go) — heads-up sound notification.
          await this.presentCallNotification(payload);
        }
      }

      if (data.notificationAction === "accept_call") {
        await nativeCallService.handleAction("answer", data);
      } else if (data.notificationAction === "decline_call") {
        await nativeCallService.handleAction("reject", data);
      }
      return;
    }

    // Message / general notification. Use Notifee for reliable status-bar
    // delivery in the background/terminated state (expo-notifications is
    // unreliable from a headless task). Fall back to expo-notifications only
    // when Notifee is unavailable. This single branch handles BOTH chat
    // messages (type=chat_message) AND general alerts (type=notification:
    // leave approved, task assigned, mentions, …) — both now arrive DATA-ONLY
    // from the server so they reach here in every app state, including
    // foreground (where RN Firebase's onMessage does not auto-display them).
    if (notifeeService.isAvailable()) {
      await notifeeService.displayMessage(payload);
    } else {
      await this.presentDataNotification(payload);
    }

    // Launcher badge: the server sends the authoritative total in
    // `badgeCount` (falling back to `unreadCount`). Reflect it on the app icon
    // so e.g. 3 unread messages show "3". A 0/absent value clears the badge.
    const badgeRaw = data.badgeCount ?? data.unreadCount;
    if (badgeRaw != null) {
      const badge = Number(badgeRaw);
      if (Number.isFinite(badge)) {
        await pushNotificationService.setBadgeCount(Math.max(0, badge));
      }
    }
  }

  /**
   * Presents a high-importance incoming-call notification in the status bar /
   * lock screen for the case where native CallKeep UI is unavailable. Uses the
   * `calls` channel (MAX importance) and the `incoming-call` category so the OS
   * renders Answer/Decline actions. Ensures the channel exists first so the
   * notification is not dropped during first-run / killed-state delivery.
   */
  private async presentCallNotification(payload: NotificationPayload): Promise<void> {
    const data = payload.data || {};
    const title =
      payload.title ||
      data.title ||
      (data.callType === "video" ? "Incoming Video Call" : "Incoming Voice Call");
    const body = payload.body || data.body || `${data.callerName || "Someone"} is calling...`;

    try {
      await this.ensureCallChannel();
      await Notifications.scheduleNotificationAsync({
        content: {
          title,
          body,
          data,
          sound: "default",
          categoryIdentifier: "incoming-call",
          ...(Platform.OS === "android" ? { channelId: "calls" } : {}),
        },
        trigger: null,
      });
    } catch (err) {
      console.warn("Failed to present background call notification:", err);
    }
  }

  /**
   * Ensures the high-importance `calls` Android channel exists. Channels created
   * at app launch may not exist yet during killed-state delivery, so we (re)create
   * it here before posting a call notification.
   */
  private async ensureCallChannel(): Promise<void> {
    if (Platform.OS !== "android") return;
    try {
      await Notifications.setNotificationChannelAsync("calls", {
        name: "Calls",
        description: "Incoming call alerts",
        importance: Notifications.AndroidImportance.MAX,
        sound: "default",
        lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
        vibrationPattern: [0, 200, 120, 200],
        bypassDnd: true,
        enableVibrate: true,
        enableLights: true,
      });
    } catch (err) {
      console.warn("Failed to ensure calls notification channel:", err);
    }
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

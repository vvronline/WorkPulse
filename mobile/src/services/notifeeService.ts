/**
 * Notifee wrapper for background/terminated-state call & message notifications.
 *
 * WHY NOTIFEE (and not expo-notifications) FOR BACKGROUND DELIVERY:
 * - On Android, when the app is terminated, FCM spawns a *headless* JS task
 *   (see `mobile/index.js`) — the React tree never mounts. `expo-notifications`
 *   relies on its handler/channels being configured during React init, so its
 *   `scheduleNotificationAsync` is unreliable (often silently no-ops) from a
 *   headless background task.
 * - Notifee is purpose-built to run from `setBackgroundMessageHandler` and is
 *   the standard way to render a **full-screen-intent** incoming-call screen
 *   over the lock screen even when the app is killed, plus reliable status-bar
 *   message notifications in the terminated state.
 *
 * This module is defensive: every call resolves the native module via `require`
 * and no-ops if it is unavailable (e.g. Expo Go / web), so importing it never
 * crashes the JS bundle.
 */

import { Platform } from "react-native";
import * as Linking from "expo-linking";
import { nativeCallService } from "./nativeCallService";
import type { NotificationPayload } from "./pushNotificationService";
import {
  setPendingCall,
  pendingCallFromData,
  persistPendingCall,
  clearPersistedPendingCall,
} from "../realtime/pendingCall";

// Versioned channel IDs. Android notification channels are IMMUTABLE after
// creation — recreating a channel with the same ID does NOT update its
// importance/sound/visibility. If a device created "calls"/"messages" under an
// earlier build with weaker settings, those stale settings would persist and
// silently downgrade our call/message notifications. Bumping the ID forces the
// OS to create a fresh channel with the corrected high-importance settings.
// (Mirrors Signal-Android's `calls_v3` versioned-channel pattern.)
const CALL_CHANNEL_ID = "calls_v2";
const MESSAGE_CHANNEL_ID = "messages_v2";

type NotifeeModule = any;
type AndroidImportanceEnum = Record<string, number>;
type AndroidCategoryEnum = Record<string, string>;
type AndroidVisibilityEnum = Record<string, number>;
type EventTypeEnum = Record<string, number>;
type AndroidNotificationSettingEnum = Record<string, number>;

function callNotificationId(callId: string, conversationId: string): string {
  return `wp-call-${conversationId}-${callId}`;
}

function messageNotificationId(messageId: string): string {
  return `wp-msg-${messageId}`;
}

class NotifeeService {
  private notifee: NotifeeModule | null = null;
  private AndroidImportance: AndroidImportanceEnum = {};
  private AndroidCategory: AndroidCategoryEnum = {};
  private AndroidVisibility: AndroidVisibilityEnum = {};
  private EventType: EventTypeEnum = {};
  private AndroidNotificationSetting: AndroidNotificationSettingEnum = {};
  private resolved = false;
  private channelsEnsured = false;
  private fsiPermissionChecked = false;

  private resolve(): NotifeeModule | null {
    if (this.resolved) return this.notifee;
    this.resolved = true;
    try {
      const mod = require("@notifee/react-native");
      this.notifee = mod?.default || mod;
      this.AndroidImportance = mod?.AndroidImportance || {};
      this.AndroidCategory = mod?.AndroidCategory || {};
      this.AndroidVisibility = mod?.AndroidVisibility || {};
      this.EventType = mod?.EventType || {};
      this.AndroidNotificationSetting = mod?.AndroidNotificationSetting || {};
    } catch {
      this.notifee = null;
      console.warn("[NotifeeService] @notifee/react-native unavailable; background call/message UI disabled.");
    }
    return this.notifee;
  }

  isAvailable(): boolean {
    return this.resolve() != null;
  }

  /**
   * Creates the Android notification channels Notifee will post into. Safe to
   * call repeatedly; only does work once per process. Channels must exist before
   * displaying notifications, including during killed-state delivery.
   */
  async ensureChannels(): Promise<void> {
    const notifee = this.resolve();
    if (!notifee || Platform.OS !== "android") return;
    if (this.channelsEnsured) return;
    try {
      await notifee.createChannel({
        id: CALL_CHANNEL_ID,
        name: "Calls",
        description: "Incoming call alerts",
        importance: this.AndroidImportance.HIGH ?? 4,
        sound: "default",
        vibration: true,
        vibrationPattern: [300, 500, 300, 500],
        bypassDnd: true,
        lights: true,
      });
      await notifee.createChannel({
        id: MESSAGE_CHANNEL_ID,
        name: "Messages",
        description: "Chat message alerts",
        importance: this.AndroidImportance.HIGH ?? 4,
        sound: "default",
        vibration: true,
        vibrationPattern: [160, 80, 160],
        lights: true,
        lightColor: "#FF6B6B",
      });
      this.channelsEnsured = true;
    } catch (err) {
      console.warn("[NotifeeService] Failed to create channels:", err);
    }
  }

  /**
   * Requests the runtime notification permission through Notifee as well as
   * expo-notifications. Data-only FCM pushes can reach the app, but Android 13+
   * will still block the visible Notifee call/message UI if POST_NOTIFICATIONS
   * has not been granted to the native notification library.
   */
  async requestNotificationPermission(): Promise<boolean> {
    const notifee = this.resolve();
    if (!notifee) return false;
    try {
      if (typeof notifee.requestPermission !== "function") return true;
      const settings = await notifee.requestPermission();
      const authorizationStatus = settings?.authorizationStatus;
      const DENIED = 0;
      return authorizationStatus === undefined || authorizationStatus > DENIED;
    } catch (err) {
      console.warn("[NotifeeService] Failed to request notification permission:", err);
      return false;
    }
  }

  /**
   * Ensures the Android 14+ (API 34) USE_FULL_SCREEN_INTENT permission is
   * granted. On Android 14+, this permission is auto-revoked for apps that are
   * NOT the default phone/alarm app, which DOWNGRADES our incoming-call
   * notification: the looping ring sound still plays, but the full-screen
   * Answer/Decline screen NEVER surfaces over the lock screen — the user is
   * forced to open the app manually. This is the #1 cause of "only ringing, can't
   * answer from the lock screen".
   *
   * Notifee exposes the current setting via `getNotificationSettings()`. When it
   * is not ENABLED we deep-link the user to the dedicated system settings page
   * (`android.settings.MANAGE_APP_USE_FULL_SCREEN_INTENT`) so they can grant it.
   * No-ops on iOS / older Android and when Notifee is unavailable. Only prompts
   * once per process to avoid nagging.
   */
  async ensureFullScreenIntentPermission(): Promise<void> {
    const notifee = this.resolve();
    if (!notifee || Platform.OS !== "android") return;
    if (this.fsiPermissionChecked) return;
    this.fsiPermissionChecked = true;

    try {
      if (typeof notifee.getNotificationSettings !== "function") return;
      const settings = await notifee.getNotificationSettings();
      const fsi = settings?.android?.fullScreenAction;

      const ENABLED = this.AndroidNotificationSetting.ENABLED ?? 1;
      const NOT_SUPPORTED = this.AndroidNotificationSetting.NOT_SUPPORTED ?? -1;

      // Already granted, or the OS version predates the runtime FSI permission.
      if (fsi === undefined || fsi === ENABLED || fsi === NOT_SUPPORTED) return;

      // Prefer Notifee's helper that opens the exact FSI settings page.
      if (typeof notifee.openSystemSettings === "function") {
        // Some Notifee versions accept no args and open the app notification
        // settings; the dedicated FSI intent below is more precise.
      }

      try {
        await Linking.sendIntent(
          "android.settings.MANAGE_APP_USE_FULL_SCREEN_INTENT",
        );
      } catch {
        // Fallback: open the app's notification settings so the user can find
        // the "Full screen notifications" toggle manually.
        await Linking.openSettings().catch(() => {});
      }
    } catch (err) {
      console.warn("[NotifeeService] Failed to ensure full-screen-intent permission:", err);
    }
  }

  /**
   * Displays a full-screen-intent incoming-call notification on Android. This is
   * what surfaces the WhatsApp/Teams-style incoming-call screen over the lock
   * screen even when the app is terminated. Includes Answer/Decline actions
   * handled by the background/foreground event handlers below.
   */
  async displayIncomingCall(data: NotificationPayload["data"]): Promise<void> {
    const notifee = this.resolve();
    if (!notifee || !data?.callId || !data?.conversationId) return;

    await this.ensureChannels();

    const title =
      data.title ||
      (data.callType === "video" ? "Incoming Video Call" : "Incoming Voice Call");
    const body = data.body || `${data.callerName || "Someone"} is calling...`;
    const id = callNotificationId(data.callId, data.conversationId);

    try {
      await notifee.displayNotification({
        id,
        title,
        body,
        data: { ...data } as Record<string, string>,
        android: {
          channelId: CALL_CHANNEL_ID,
          category: this.AndroidCategory.CALL ?? "call",
          importance: this.AndroidImportance.HIGH ?? 4,
          visibility: this.AndroidVisibility.PUBLIC ?? 1,
          // Full-screen intent: launches the app's main activity full-screen
          // over the lock screen even when terminated.
          fullScreenAction: {
            id: "default",
            launchActivity: "default",
          },
          pressAction: {
            id: "default",
            launchActivity: "default",
          },
          // Persistent + looping sound so it rings like a real call.
          ongoing: true,
          autoCancel: false,
          loopSound: true,
          sound: "default",
          actions: [
            {
              title: "Answer",
              pressAction: { id: "answer", launchActivity: "default" },
            },
            {
              title: "Decline",
              pressAction: { id: "decline" },
            },
          ],
          timeoutAfter: 45000,
        },
      });

      // Persist the call route so a LOCKED + KILLED device — where the
      // full-screen-intent AUTO-launches MainActivity in a brand-new process
      // (not a notification tap, so getInitialNotification() is null) — can
      // still route to the incoming-call screen instead of the dashboard. The
      // in-memory pending route does not survive that process death; SecureStore
      // does. PendingCallNavigator loads + consumes it (if still fresh) on mount.
      const route = pendingCallFromData(data);
      if (route) await persistPendingCall(route);
    } catch (err) {
      console.warn("[NotifeeService] Failed to display incoming call:", err);
    }
  }

  /**
   * Displays a standard status-bar message notification. Reliable in
   * background/terminated state, unlike expo-notifications from a headless task.
   */
  async displayMessage(payload: NotificationPayload): Promise<void> {
    const notifee = this.resolve();
    if (!notifee) return;
    const data = payload.data || {};
    const title = payload.title || data.title || data.senderName || "New message";
    const body = payload.body || data.body || "";
    if (!title && !body) return;

    await this.ensureChannels();

    const id = data.messageId ? messageNotificationId(data.messageId) : undefined;
    // Server-authoritative launcher/app-icon badge total (e.g. "3" unread).
    const badgeCount = Number(data.badgeCount ?? data.unreadCount);
    const hasBadge = Number.isFinite(badgeCount) && badgeCount >= 0;
    try {
      await notifee.displayNotification({
        ...(id ? { id } : {}),
        title,
        body,
        data: { ...data } as Record<string, string>,
        android: {
          channelId: MESSAGE_CHANNEL_ID,
          importance: this.AndroidImportance.HIGH ?? 4,
          visibility: this.AndroidVisibility.PRIVATE ?? 0,
          pressAction: { id: "default", launchActivity: "default" },
          sound: "default",
          // Drive the launcher dot/count from the running total.
          ...(hasBadge ? { badgeCount } : {}),
          // No custom `smallIcon` — Notifee falls back to the app's launcher
          // icon. We deliberately avoid generating a dedicated notification
          // drawable via expo-notifications `icon`/`color` because those inject
          // FCM default-notification meta-data that collides with
          // @react-native-firebase/messaging and fails the manifest merge.
        },
      });
    } catch (err) {
      // Retry once without any extra android options as a last-ditch fallback.
      try {
        await notifee.displayNotification({
          ...(id ? { id } : {}),
          title,
          body,
          data: { ...data } as Record<string, string>,
          android: {
            channelId: MESSAGE_CHANNEL_ID,
            importance: this.AndroidImportance.HIGH ?? 4,
            pressAction: { id: "default", launchActivity: "default" },
            sound: "default",
          },
        });
      } catch (err2) {
        console.warn("[NotifeeService] Failed to display message:", err2);
      }
    }
  }

  /** Cancels a previously-displayed incoming-call notification (call ended/handled). */
  async cancelCall(callId?: string, conversationId?: string): Promise<void> {
    // Drop any persisted pending-call route so a future cold start never routes
    // to a call that has already ended / been handled (avoids "ghost" call
    // screens). Done regardless of Notifee availability.
    await clearPersistedPendingCall();
    const notifee = this.resolve();
    if (!notifee || !callId || !conversationId) return;
    try {
      await notifee.cancelNotification(callNotificationId(callId, conversationId));
    } catch (err) {
      console.warn("[NotifeeService] Failed to cancel call notification:", err);
    }
  }

  /**
   * Handles a Notifee event (press / action press) for an incoming call.
   * Returns true if the event was a call event it handled. Used by both the
   * foreground and background event handlers.
   */
  async handleCallEvent(type: number, detail: any): Promise<boolean> {
    const notifee = this.resolve();
    if (!notifee) return false;

    const pressActionId: string | undefined =
      detail?.pressAction?.id || detail?.notification?.android?.pressAction?.id;
    const data = (detail?.notification?.data || {}) as Record<string, string>;
    if (!data.callId || !data.conversationId) return false;

    const isPress = type === (this.EventType.PRESS ?? 1);
    const isAction = type === (this.EventType.ACTION_PRESS ?? 2);
    if (!isPress && !isAction) return false;

    // Always clear the ringing notification once acted upon.
    await this.cancelCall(data.callId, data.conversationId);

    if (pressActionId === "decline") {
      // Stash a pending "decline" route so a cold-started app still reconciles
      // (the call screen auto-rejects on mount). nativeCallService also sends
      // the raw reject for the genuinely-killed case.
      const route = pendingCallFromData({ ...data, notificationAction: "decline_call" });
      if (route) setPendingCall(route);
      await nativeCallService.handleAction("reject", data);
      return true;
    }

    if (pressActionId === "answer") {
      // Stash a pending "answer" route so that when the app is launched COLD by
      // this tap (Linking deep link is lost before expo-router mounts), the
      // root layout still navigates to the call screen with autoAnswer=1.
      const route = pendingCallFromData({ ...data, notificationAction: "accept_call" });
      if (route) setPendingCall(route);
      await nativeCallService.handleAction("answer", data);
      return true;
    }

    // Body press → open the call screen in incoming mode without auto-answer.
    // Stash a pending route too, so a cold start still reaches the call screen.
    const route = pendingCallFromData(data);
    if (route) setPendingCall(route);
    try {
      const href = `/call/${data.conversationId}?mode=incoming&callId=${data.callId}&callType=${data.callType || "voice"}&peerId=${data.callerId || ""}`;
      await Linking.openURL(Linking.createURL(href));
    } catch (err) {
      console.warn("[NotifeeService] Failed to route answer:", err);
    }
    return true;
  }

  /**
   * Reads Notifee's initial notification (the call notification that COLD-
   * launched the app) and returns a pending call route for it, or null. Called
   * once at app startup from the root layout so a killed-state notification tap
   * / Answer action routes to the call screen even though the headless deep
   * link was lost before the router mounted.
   */
  async captureInitialCallRoute(): Promise<void> {
    const notifee = this.resolve();
    if (!notifee || typeof notifee.getInitialNotification !== "function") return;
    try {
      const initial = await notifee.getInitialNotification();
      if (!initial) return;
      const data = (initial.notification?.data || {}) as Record<string, string>;
      if (!data.callId || !data.conversationId) return;
      const pressActionId: string | undefined = initial.pressAction?.id;
      const action =
        pressActionId === "answer"
          ? "accept_call"
          : pressActionId === "decline"
            ? "decline_call"
            : undefined;
      const route = pendingCallFromData({ ...data, notificationAction: action });
      if (route) setPendingCall(route);
    } catch (err) {
      console.warn("[NotifeeService] Failed to read initial notification:", err);
    }
  }

  /**
   * Registers the Notifee background event handler. MUST be called at the JS
   * entry top-level (see `mobile/index.js`) so Answer/Decline work when the app
   * is killed. Idempotent and safe if Notifee is unavailable.
   */
  registerBackgroundHandler(): void {
    const notifee = this.resolve();
    if (!notifee) return;
    try {
      notifee.onBackgroundEvent(async ({ type, detail }: { type: number; detail: any }) => {
        await this.handleCallEvent(type, detail);
      });
    } catch (err) {
      console.warn("[NotifeeService] Failed to register background event handler:", err);
    }
  }

  /**
   * Registers the foreground event handler (call answer/decline while app is
   * alive). Returns an unsubscribe function.
   */
  registerForegroundHandler(): () => void {
    const notifee = this.resolve();
    if (!notifee) return () => {};
    try {
      const unsub = notifee.onForegroundEvent(async ({ type, detail }: { type: number; detail: any }) => {
        await this.handleCallEvent(type, detail);
      });
      return typeof unsub === "function" ? unsub : () => {};
    } catch (err) {
      console.warn("[NotifeeService] Failed to register foreground event handler:", err);
      return () => {};
    }
  }
}

export const notifeeService = new NotifeeService();
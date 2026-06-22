import * as Linking from "expo-linking";
import { Platform } from "react-native";
import { ANDROID_NATIVE_CALL_UI } from "../config";
import { socket } from "../realtime/socket";
import type { NotificationPayload } from "./pushNotificationService";
import { setPendingCall, pendingCallFromData } from "../realtime/pendingCall";
import { beginCallNavigation, isCallActive } from "../realtime/callRouting";
import { emitAnswerIntent } from "../realtime/callAnswerIntent";
import { rejectCallHttp } from "../features";

type NativeAction = "answer" | "reject" | "end";
type ActionHandler = (params: {
  action: NativeAction;
  callId: number;
  conversationId: number;
}) => void | Promise<void>;

type CallKeepEvent = { callUUID?: string };
type CallKeepModule = {
  setup: (options: Record<string, unknown>) => Promise<void>;
  setAvailable?: (available: boolean) => void;
  displayIncomingCall: (
    uuid: string,
    handle: string,
    localizedCallerName?: string,
    handleType?: "number" | "email" | "generic",
    hasVideo?: boolean,
  ) => void;
  endCall?: (uuid: string) => void;
  addEventListener: (event: string, listener: (event: CallKeepEvent) => void) => void;
  removeEventListener?: (event: string) => void;
};

function toInt(value?: string): number | null {
  if (!value) return null;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : null;
}

// CallKeep events we bind to. Centralised so teardown removes EXACTLY what
// configureCallKeep added (no stale listeners left bound after logout/re-login,
// which on iOS caused the answer/end handler to fire multiple times per tap).
const CALLKEEP_EVENTS = ["answerCall", "endCall"] as const;

class NativeCallService {
  private initialized = false;
  private actionHandlers = new Set<ActionHandler>();
  private callKeep: CallKeepModule | null = null;
  private payloadByUuid = new Map<string, NotificationPayload["data"]>();
  private nativeEnabled = false;
  private warnedUnavailable = false;
  // Tracks whether CallKeep event listeners are currently bound so we never
  // double-bind on a re-init and can cleanly remove them in teardown().
  private listenersBound = false;

  initialize() {
    if (this.initialized) return;
    this.callKeep = this.resolveCallKeepModule();
    if (this.callKeep) {
      this.configureCallKeep(this.callKeep).catch((err) => {
        console.warn("Failed to configure native call integration:", err);
      });
    }
    this.initialized = true;
  }

  /**
   * Tear the native call integration down. Called on logout so a subsequent
   * login (possibly as a DIFFERENT user) re-initializes from a clean slate
   * instead of stacking a second set of CallKeep event listeners on top of the
   * first — the iOS bug where one "answer"/"end" tap fired the handler N times
   * (once per accumulated login). Safe to call when never initialized.
   */
  teardown() {
    if (this.callKeep && this.listenersBound) {
      for (const event of CALLKEEP_EVENTS) {
        try {
          this.callKeep.removeEventListener?.(event);
        } catch (err) {
          console.warn(`[nativeCallService] failed to remove ${event} listener:`, err);
        }
      }
    }
    try {
      this.callKeep?.setAvailable?.(false);
    } catch {
      /* ignore */
    }
    this.listenersBound = false;
    this.nativeEnabled = false;
    this.payloadByUuid.clear();
    this.initialized = false;
    // Keep `actionHandlers` intact — those are owned by mounted React
    // components which manage their own subscribe/unsubscribe lifecycle.
  }

  onAction(handler: ActionHandler): () => void {
    this.actionHandlers.add(handler);
    return () => {
      this.actionHandlers.delete(handler);
    };
  }

  /**
   * Whether native (CallKeep) incoming-call UI is available and configured.
   * Returns false on Android UNLESS the P3.15 `ANDROID_NATIVE_CALL_UI` feature
   * flag is enabled (the react-native-callkeep ConnectionService/CallStyle
   * surface is opt-in there because some builds crash at startup), and false in
   * builds where the native module is unavailable (e.g. Expo Go). Callers should
   * fall back to a heads-up status-bar notification when this is false so
   * incoming calls are never silently dropped while the app is
   * backgrounded/terminated.
   */
  isNativeAvailable(): boolean {
    return this.nativeEnabled && this.callKeep != null;
  }

  async reportIncomingCall(payload: NotificationPayload["data"]): Promise<void> {
    const callId = toInt(payload?.callId);
    const conversationId = toInt(payload?.conversationId);
    if (!callId || !conversationId) return;
    const uuid = this.callUuid(callId, conversationId);
    this.payloadByUuid.set(uuid, payload);
    if (!this.callKeep || !this.nativeEnabled) return;
    this.callKeep.displayIncomingCall(
      uuid,
      payload?.callerName || "Incoming call",
      payload?.callerName || "Incoming call",
      "generic",
      payload?.callType === "video",
    );
  }

  async handleAction(
    action: NativeAction,
    payload: NotificationPayload["data"],
  ): Promise<void> {
    const callId = toInt(payload?.callId);
    const conversationId = toInt(payload?.conversationId);
    if (!callId || !conversationId) return;

    // Notify any mounted action handlers (app alive). These handle
    // reject/end over the websocket; for "answer" they are intentionally a
    // no-op now (the call screen's acceptIncoming owns the accept — see below).
    let handledByMountedApp = false;
    for (const handler of this.actionHandlers) {
      handledByMountedApp = true;
      await handler({ action, callId, conversationId });
    }

    if (action === "answer") {
      // SINGLE ACCEPT PATH: the call screen's acceptIncoming() is the ONE place
      // that sends `call_accept`, flips status→connecting, sets acceptedRef and
      // acquires camera/mic. We do NOT send a raw socket accept here (that was
      // the old double-accept bug that desynced the screen's state machine —
      // "UI shows but never connects"). Instead we navigate to the call screen
      // with autoAnswer=1 and let it own the accept.
      //
      // CASE A — the call screen is ALREADY MOUNTED for this call (e.g. the
      // websocket IncomingCallListener pushed it the moment `call_incoming`
      // arrived, and it is sitting in the ringing state). In that case there is
      // nothing to navigate to: instead we EMIT an answer intent that the
      // mounted screen consumes to run acceptIncoming(). Without this the
      // navigation guard correctly refused to re-navigate but nobody told the
      // screen to accept — so the user kept staring at the ringing UI after
      // tapping Answer (the "opens incoming UI instead of connecting" bug).
      if (isCallActive(callId, conversationId)) {
        emitAnswerIntent(callId, conversationId);
        return;
      }

      const route = pendingCallFromData({
        ...payload,
        notificationAction: "accept_call",
      });
      if (route) setPendingCall(route);

      // Claim navigation. If the claim SUCCEEDS, this is the first path to
      // surface this call. We BOTH stash the pending route (so a COLD-started
      // app routed by app/index.tsx / PendingCallNavigator reaches /call) AND
      // fire the deep link so a WARM, alive app navigates immediately — the
      // cold-start consumers only run their effects at mount, so in a warm app
      // nobody else would navigate (the second half of the "Answer does
      // nothing" bug). The navigation guard + autoAnswer pending route prevent
      // a double-mount/double-accept if both paths somehow run.
      beginCallNavigation(callId, conversationId);
      try {
        // Include peerName/peerAvatar so the call screen shows the caller's
        // name (not the generic "Call" fallback) on this deep-link path.
        const peerName = encodeURIComponent(payload?.callerName || "");
        const peerAvatar = encodeURIComponent(payload?.callerAvatar || "");
        const href = `/call/${conversationId}?mode=incoming&callId=${callId}&callType=${payload?.callType || "voice"}&peerId=${payload?.callerId || ""}&peerName=${peerName}&peerAvatar=${peerAvatar}&autoAnswer=1`;
        await Linking.openURL(Linking.createURL(href));
      } catch (err) {
        console.warn("[nativeCallService] Failed to open call screen on answer:", err);
      }
      return;
    }

    // reject / end: when the app is KILLED no mounted handler exists, so send
    // the action straight from this service so ringing stops everywhere even in
    // the headless state.
    if (!handledByMountedApp) {
      const socketAction = action === "reject" ? "reject" : "end";
      // Confirm the realtime channel actually comes up before relying on it.
      // From a killed/headless task the WS is often slow to authenticate; if it
      // is NOT live within the window we fall back to the HTTP endpoint so the
      // caller ALWAYS stops ringing (fixes "declined but caller still rings").
      const connected = await socket.waitUntilConnected(2500);
      let sent = false;
      if (connected) {
        sent = await socket.sendCallActionWithRetry(
          socketAction,
          { callId, conversationId },
          { timeoutMs: 3000, initialBackoffMs: 120, maxBackoffMs: 1000 },
        );
      }
      if (!sent && action === "reject") {
        try {
          await rejectCallHttp(callId, conversationId);
        } catch (err) {
          console.warn("[nativeCallService] HTTP reject fallback failed:", err);
        }
      }
    }
  }

  private resolveCallKeepModule(): CallKeepModule | null {
    // P3.15 — Android native incoming-call surface (react-native-callkeep
    // ConnectionService / CallStyle UI) is gated behind the
    // `ANDROID_NATIVE_CALL_UI` feature flag. When the flag is OFF (default) we
    // keep the previous safeguard of NOT loading the module on Android, because
    // some react-native-callkeep builds crash at startup on certain RN versions
    // (duplicate exported method names). Enabling the flag opts a verified build
    // into the native surface; when OFF the app falls back to the Notifee
    // CallStyle status-bar notification + CallRinger foreground service.
    if (Platform.OS === "android" && !ANDROID_NATIVE_CALL_UI) {
      if (!this.warnedUnavailable) {
        this.warnedUnavailable = true;
        console.warn(
          "react-native-callkeep disabled on Android (ANDROID_NATIVE_CALL_UI flag off); using Notifee fallback",
        );
      }
      return null;
    }

    try {
      const module = require("react-native-callkeep");
      return (module?.default || module) as CallKeepModule;
    } catch {
      if (!this.warnedUnavailable) {
        this.warnedUnavailable = true;
        console.warn("react-native-callkeep unavailable in this build; native incoming call UI disabled");
      }
      return null;
    }
  }

  private async configureCallKeep(callKeep: CallKeepModule): Promise<void> {
    await callKeep.setup({
      ios: {
        appName: "WorkPulse",
        supportsVideo: true,
        includesCallsInRecents: false,
      },
      android: {
        alertTitle: "Phone account permission",
        alertDescription:
          "Allow WorkPulse to show incoming call screen and call controls from system UI.",
        cancelButton: "Cancel",
        okButton: "Enable",
        imageName: "ic_launcher",
        additionalPermissions: [],
        selfManaged: false,
      },
    });
    callKeep.setAvailable?.(true);
    this.nativeEnabled = true;

    // Defensive: drop any previously-bound listeners before adding, so a
    // re-init (e.g. logout without teardown, then login) can never leave two
    // sets bound — which made one native tap fire the handler twice.
    if (this.listenersBound) {
      for (const event of CALLKEEP_EVENTS) {
        try {
          callKeep.removeEventListener?.(event);
        } catch {
          /* ignore */
        }
      }
      this.listenersBound = false;
    }

    callKeep.addEventListener("answerCall", (event: CallKeepEvent) => {
      this.onNativeCallAction("answer", event);
    });
    callKeep.addEventListener("endCall", (event: CallKeepEvent) => {
      this.onNativeCallAction("reject", event);
    });
    this.listenersBound = true;
  }

  private async onNativeCallAction(action: NativeAction, event: CallKeepEvent): Promise<void> {
    const uuid = event.callUUID || "";
    const payload = this.payloadByUuid.get(uuid);
    if (!payload) return;
    await this.handleAction(action, payload);
    this.payloadByUuid.delete(uuid);
    this.callKeep?.endCall?.(uuid);
  }

  private callUuid(callId: number, conversationId: number): string {
    return `wp-call-${conversationId}-${callId}`;
  }
}

export const nativeCallService = new NativeCallService();

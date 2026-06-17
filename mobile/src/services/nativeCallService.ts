import * as Linking from "expo-linking";
import { Platform } from "react-native";
import { socket } from "../realtime/socket";
import type { NotificationPayload } from "./pushNotificationService";

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

class NativeCallService {
  private initialized = false;
  private actionHandlers = new Set<ActionHandler>();
  private callKeep: CallKeepModule | null = null;
  private payloadByUuid = new Map<string, NotificationPayload["data"]>();
  private nativeEnabled = false;
  private warnedUnavailable = false;

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

  onAction(handler: ActionHandler): () => void {
    this.actionHandlers.add(handler);
    return () => {
      this.actionHandlers.delete(handler);
    };
  }

  /**
   * Whether native (CallKeep) incoming-call UI is available and configured.
   * Returns false on Android (CallKeep is currently disabled to avoid a
   * startup crash) and in builds where the native module is unavailable
   * (e.g. Expo Go). Callers should fall back to a heads-up status-bar
   * notification when this is false so incoming calls are never silently
   * dropped while the app is backgrounded/terminated.
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

    let handledByMountedApp = false;
    for (const handler of this.actionHandlers) {
      handledByMountedApp = true;
      await handler({ action, callId, conversationId });
    }

    // When Answer/Decline is tapped from a Notifee background event while the app
    // is killed, React components are not mounted, so PushNotificationInitializer
    // has not registered an action handler. Send the websocket action directly
    // from this service so the caller is notified and ringing stops everywhere.
    if (!handledByMountedApp) {
      const socketAction = action === "answer" ? "accept" : action === "reject" ? "reject" : "end";
      await socket.connect();
      await socket.sendCallActionWithRetry(
        socketAction,
        { callId, conversationId },
        { timeoutMs: action === "answer" ? 6000 : 3000, initialBackoffMs: 120, maxBackoffMs: 1000 },
      );
    }

    if (action === "answer") {
      const href = `/call/${conversationId}?mode=incoming&callId=${callId}&callType=${payload?.callType || "voice"}&peerId=${payload?.callerId || ""}&autoAnswer=1`;
      await Linking.openURL(Linking.createURL(href));
    }
  }

  private resolveCallKeepModule(): CallKeepModule | null {
    // Temporary Android safeguard: current react-native-callkeep build crashes
    // at startup on some RN versions due to duplicate exported method names.
    if (Platform.OS === "android") {
      if (!this.warnedUnavailable) {
        this.warnedUnavailable = true;
        console.warn("react-native-callkeep disabled on Android to avoid startup crash");
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

    callKeep.addEventListener("answerCall", (event: CallKeepEvent) => {
      this.onNativeCallAction("answer", event);
    });
    callKeep.addEventListener("endCall", (event: CallKeepEvent) => {
      this.onNativeCallAction("reject", event);
    });
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

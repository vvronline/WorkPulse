/**
 * SINGLE SOURCE OF TRUTH for classifying an inbound call event as a
 * 1:1 (p2p) call vs a GROUP call (huddle → n-way meeting mesh).
 *
 * WHY THIS EXISTS:
 * Before this module, FOUR independent entry points each re-derived the
 * call kind with their own `if (d.meetingCode)` branch:
 *   • IncomingCallListener   (websocket `call_incoming`)
 *   • PushNotificationListener (FCM/expo notification payloads)
 *   • PendingCallNavigator   (cold-start pending route fallback)
 *   • app/index.tsx          (cold-start root redirect)
 * Divergence between those branches was a direct cause of the 1:1-call
 * regressions introduced by the group-call overhaul: a group event that one
 * path classified differently from another could route into the 1:1 call
 * screen (or vice versa), double-mount surfaces, or tear down the wrong call.
 *
 * The discriminated union returned here makes cross-contamination
 * STRUCTURALLY impossible: a `GroupCallEvent` has no shape that the 1:1
 * code can consume, and TypeScript forces every consumer to narrow on
 * `kind` before touching kind-specific fields.
 */

/** A 1:1 (peer-to-peer) call event. */
export type P2pCallEvent = {
  kind: "p2p";
  callId: string;
  conversationId: string;
  callType: "voice" | "video";
  peerId: string;
  peerName: string;
  peerAvatar: string;
  /** True when the conversation is a group chat rung as a 1:1-style call. */
  isGroupConversation: boolean;
};

/** A GROUP call (huddle) event — the callee joins the n-way meeting mesh. */
export type GroupCallEvent = {
  kind: "group";
  callId: string;
  conversationId: string;
  callType: "voice" | "video";
  /** Meeting join code — the defining discriminator of a group call. */
  meetingCode: string;
  meetingId: string;
  callerName: string;
  callerAvatar: string;
  groupName: string;
};

export type CallEvent = P2pCallEvent | GroupCallEvent;

/**
 * Classify a raw `call_incoming` websocket frame's `data` payload.
 * Returns null when the payload is not a valid call event.
 */
export function classifyIncomingCall(
  d: Record<string, unknown> | null | undefined,
): CallEvent | null {
  if (!d || d.callId == null || d.conversationId == null) return null;
  const callId = String(d.callId);
  const conversationId = String(d.conversationId);
  const callType = d.callType === "video" ? "video" : "voice";

  const meetingCode =
    d.meetingCode != null && String(d.meetingCode).length > 0
      ? String(d.meetingCode)
      : null;

  if (meetingCode) {
    return {
      kind: "group",
      callId,
      conversationId,
      callType,
      meetingCode,
      meetingId: d.meetingId != null ? String(d.meetingId) : callId,
      callerName: d.callerName ? String(d.callerName) : "",
      callerAvatar: d.callerAvatar ? String(d.callerAvatar) : "",
      groupName: d.groupName ? String(d.groupName) : "",
    };
  }

  return {
    kind: "p2p",
    callId,
    conversationId,
    callType,
    peerId: d.callerId != null ? String(d.callerId) : "",
    peerName: d.callerName ? String(d.callerName) : "Incoming call",
    peerAvatar: d.callerAvatar ? String(d.callerAvatar) : "",
    isGroupConversation: d.isGroup === true || d.isGroup === "1" || d.isGroup === "true",
  };
}

/**
 * Classify a push-notification data payload (FCM / expo-notifications /
 * Notifee — all normalise to string-valued records).
 * Returns null when the payload is not a call.
 */
export function classifyPushCallData(
  data: Record<string, string | undefined> | null | undefined,
): CallEvent | null {
  if (!data?.callId || !data?.conversationId) return null;
  return classifyIncomingCall({
    callId: data.callId,
    conversationId: data.conversationId,
    callType: data.callType,
    callerId: data.callerId ?? data.senderId,
    callerName: data.callerName,
    callerAvatar: data.callerAvatar,
    isGroup: data.isGroup,
    meetingCode: data.meetingCode,
    meetingId: data.meetingId,
    groupName: data.groupName,
  });
}

/**
 * Classify a PendingCallRoute-shaped object (cold-start persisted routes).
 * The route type keeps `meetingCode?` for wire/storage compat; this is the
 * one place that interprets it.
 */
export function classifyPendingRoute(route: {
  callId: string;
  conversationId: string;
  callType: string;
  peerId?: string;
  peerName?: string;
  peerAvatar?: string;
  isGroup?: string;
  meetingCode?: string;
}): CallEvent {
  const callType = route.callType === "video" ? "video" : "voice";
  if (route.meetingCode) {
    return {
      kind: "group",
      callId: route.callId,
      conversationId: route.conversationId,
      callType,
      meetingCode: route.meetingCode,
      meetingId: route.callId,
      callerName: route.peerName || "",
      callerAvatar: route.peerAvatar || "",
      groupName: "",
    };
  }
  return {
    kind: "p2p",
    callId: route.callId,
    conversationId: route.conversationId,
    callType,
    peerId: route.peerId || "",
    peerName: route.peerName || "Incoming call",
    peerAvatar: route.peerAvatar || "",
    isGroupConversation: route.isGroup === "1",
  };
}
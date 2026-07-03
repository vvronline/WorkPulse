/**
 * GROUP-CALL navigation builders — the single place that knows HOW to route a
 * classified GroupCallEvent into the app's group-call surfaces.
 *
 * Before this module the meeting deep link (`/meeting/<code>?huddle=1&…`) and
 * the ring-screen params were rebuilt inline at FOUR call-sites
 * (IncomingCallListener, PushNotificationListener, PendingCallNavigator,
 * app/index.tsx). Any drift between those copies re-opens the classification
 * divergence bug class this refactor eliminates; now they all call here.
 *
 * BOUNDARY: this module may import from `../shared` only — never from
 * `../p2p` (enforced by src/calls/__tests__/moduleBoundaries.test.ts).
 */

import type { GroupCallEvent } from "../shared/classifier";

/**
 * Href that joins the n-way meeting mesh for a group call (huddle):
 * auto-join (no lobby) + audio-only when the call is a voice call.
 */
export function meetingHrefForGroupCall(event: {
  meetingCode: string;
  callType: "voice" | "video";
}): string {
  return `/meeting/${event.meetingCode}?huddle=1&callType=${event.callType}`;
}

/** Route params for the full-screen incoming group-call ring screen. */
export function groupRingParams(
  event: GroupCallEvent,
): Record<string, string> {
  return {
    meetingCode: event.meetingCode,
    callId: event.callId,
    meetingId: event.meetingId,
    conversationId: event.conversationId,
    callType: event.callType,
    callerName: event.callerName,
    callerAvatar: event.callerAvatar,
    groupName: event.groupName,
  };
}

/** Pathname of the incoming group-call ring screen. */
export const GROUP_RING_PATHNAME = "/group-call/ring";
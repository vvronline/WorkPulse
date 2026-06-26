/**
 * Active conversation tracker.
 *
 * The push-notification handler (backgroundPushService.handleNotificationPayload)
 * needs to know whether the user is CURRENTLY looking at a given conversation so
 * it can suppress the status-bar banner for messages that belong to the chat
 * already on screen (WhatsApp/Signal/Teams parity — you never get a banner for
 * the conversation you're actively reading).
 *
 * The server cannot know which screen the recipient is on, so it always sends a
 * message push (which is correct — it guarantees delivery for backgrounded /
 * offline devices). This tiny module-level flag lets the CLIENT make the smart
 * "don't show a banner, I'm already here" decision.
 *
 * Lives at module scope (not React state) so the FCM `onMessage` foreground
 * handler — which runs outside the React tree — can read it synchronously.
 */

let activeConversationId: number | null = null;

/**
 * Records the conversation the user is currently viewing. Call with the
 * conversation id on screen focus, and `null` on blur/unmount.
 */
export function setActiveConversation(conversationId: number | null): void {
  activeConversationId = conversationId == null ? null : Number(conversationId);
}

/** Returns the conversation id currently on screen, or null if none. */
export function getActiveConversation(): number | null {
  return activeConversationId;
}

/**
 * Convenience predicate: is the given conversation id the one currently open?
 * Tolerates string ids (push payloads carry everything as strings).
 */
export function isConversationActive(conversationId: number | string | null | undefined): boolean {
  if (conversationId == null) return false;
  if (activeConversationId == null) return false;
  return Number(conversationId) === activeConversationId;
}
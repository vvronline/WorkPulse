/**
 * In-memory "answer intent" bus for incoming calls.
 *
 * WHY THIS EXISTS:
 * When the user taps "Answer" on the status-bar / full-screen call notification,
 * the call screen may ALREADY be mounted in "ringing" mode (e.g. the websocket
 * `IncomingCallListener` pushed it the moment `call_incoming` arrived). In that
 * case the cross-path navigation guard (`beginCallNavigation`) correctly refuses
 * to navigate again — but nothing tells the mounted screen to actually ACCEPT.
 * The result is the user staring at the ringing UI even though they tapped
 * Answer (the "opens incoming UI instead of connecting" bug).
 *
 * This tiny event bus bridges that gap: the Answer handler emits an intent for a
 * specific call, and the mounted call screen — which subscribes for ITS call —
 * runs `acceptIncoming()` in response. It also LATCHES the most recent intent so
 * a screen that mounts a tick AFTER the intent was emitted (race on warm launch)
 * still picks it up via `consumeAnswerIntent()`.
 */

type AnswerIntent = { callId: number; conversationId: number };
type Listener = (intent: AnswerIntent) => void;

const listeners = new Set<Listener>();
// Latched most-recent intent so a screen mounting slightly later still sees it.
let latched: AnswerIntent | null = null;

function sameCall(
  a: AnswerIntent,
  callId: number,
  conversationId: number,
): boolean {
  return a.callId === callId && a.conversationId === conversationId;
}

/**
 * Emit an answer intent for a call. Notifies any currently-subscribed listeners
 * AND latches it so a listener that subscribes immediately afterwards (warm
 * navigation race) can still consume it.
 */
export function emitAnswerIntent(callId: number, conversationId: number): void {
  const intent: AnswerIntent = { callId, conversationId };
  latched = intent;
  for (const listener of listeners) {
    try {
      listener(intent);
    } catch {
      /* never let a listener error break the answer flow */
    }
  }
}

/**
 * Subscribe to answer intents. Returns an unsubscribe function. On subscribe we
 * synchronously deliver any latched intent that matches the caller's call so a
 * late-mounting screen still auto-accepts.
 */
export function subscribeAnswerIntent(
  callId: number,
  conversationId: number,
  listener: Listener,
): () => void {
  const wrapped: Listener = (intent) => {
    if (sameCall(intent, callId, conversationId)) listener(intent);
  };
  listeners.add(wrapped);
  // Deliver a latched intent for this exact call immediately (then clear it so
  // it can't double-fire for a future remount of the same call screen).
  if (latched && sameCall(latched, callId, conversationId)) {
    const intent = latched;
    latched = null;
    try {
      listener(intent);
    } catch {
      /* ignore */
    }
  }
  return () => {
    listeners.delete(wrapped);
  };
}

/**
 * Consume (read + clear) a latched answer intent for a specific call without
 * subscribing. Used by the call screen on mount as a belt-and-suspenders check
 * in case the intent was emitted before the subscription was wired.
 */
export function consumeAnswerIntent(
  callId: number,
  conversationId: number,
): boolean {
  if (latched && sameCall(latched, callId, conversationId)) {
    latched = null;
    return true;
  }
  return false;
}

/** Clear any latched answer intent (e.g. call ended/handled before accept). */
export function clearAnswerIntent(): void {
  latched = null;
}
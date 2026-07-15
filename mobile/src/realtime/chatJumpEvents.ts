/**
 * Chat jump-to-message event bus.
 *
 * The in-conversation search screen lives on a SEPARATE route from the chat
 * thread (Signal opens search as its own screen). When the user taps a search
 * result we pop back to the thread and need it to scroll to that message — but
 * the thread screen is already mounted, so router params alone won't re-trigger
 * a jump reliably. This tiny pub/sub lets the search screen emit a
 * (conversationId, messageId) pair that the thread's useChatThread hook
 * subscribes to and acts on once it regains focus.
 */

type JumpListener = (conversationId: number, messageId: number) => void;

const listeners = new Set<JumpListener>();

// Retain the most-recent jump so it survives a thread REMOUNT. Under the
// Signal single-active-conversation model the thread body is unmounted while a
// sub-screen (search / saved / pinned) is on top, so it has no live subscriber
// at the instant that screen emits the jump and pops back. The thread then
// remounts on focus and consumes this pending jump — see consumePendingChatJump.
// A short TTL prevents a stale jump from firing on an unrelated later open.
type PendingJump = { conversationId: number; messageId: number; ts: number };
let pending: PendingJump | null = null;
const PENDING_TTL_MS = 4000;

export function emitChatJump(conversationId: number, messageId: number): void {
  pending = { conversationId, messageId, ts: Date.now() };
  listeners.forEach((l) => {
    try {
      l(conversationId, messageId);
    } catch {
      /* keep the bus resilient */
    }
  });
}

/**
 * Return (and clear) a recent pending jump for this conversation, if any. Called
 * by the thread when it (re)gains focus so a jump emitted while it was unmounted
 * (search/saved sub-screen on top) still scrolls to the target on return.
 */
export function consumePendingChatJump(conversationId: number): number | null {
  if (!pending) return null;
  if (pending.conversationId !== conversationId) return null;
  if (Date.now() - pending.ts > PENDING_TTL_MS) {
    pending = null;
    return null;
  }
  const messageId = pending.messageId;
  pending = null;
  return messageId;
}

export function subscribeChatJump(listener: JumpListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

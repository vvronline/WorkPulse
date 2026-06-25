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

export function emitChatJump(conversationId: number, messageId: number): void {
  listeners.forEach((l) => {
    try {
      l(conversationId, messageId);
    } catch {
      /* keep the bus resilient */
    }
  });
}

export function subscribeChatJump(listener: JumpListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
type Listener = () => void;

const listeners = new Set<Listener>();

export function emitChatUnreadChanged(): void {
  listeners.forEach((listener) => {
    try {
      listener();
    } catch {
      // Keep notifier resilient; one bad listener must not break others.
    }
  });
}

export function subscribeChatUnreadChanged(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

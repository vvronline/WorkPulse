/**
 * Tiny module-level "app is ready" signal used to hand off from the
 * AnimatedSplash overlay to the real UI the moment the root route has been
 * decided — instead of holding the splash for a fixed timer.
 *
 * WHY (Signal-Android parity): Signal hides its splash the instant the first
 * frame of real UI is ready. Our previous splash held for a fixed ~1.8s
 * (560ms fade-in + 1400ms hold + 420ms fade-out) even when the app was ready
 * in 300ms. app/index.tsx calls `markAppReady()` as soon as it renders its
 * redirect (route decision made); AnimatedSplash subscribes and starts its
 * fade-out immediately (subject to a small minimum-display time so the brand
 * mark never flickers).
 */

let ready = false;
const listeners = new Set<() => void>();

/** Mark the app as ready to be revealed. Idempotent. */
export function markAppReady(): void {
  if (ready) return;
  ready = true;
  for (const l of listeners) {
    try {
      l();
    } catch {
      /* ignore */
    }
  }
  listeners.clear();
}

/** Whether the app has signalled readiness. */
export function isAppReady(): boolean {
  return ready;
}

/**
 * Subscribe to the ready signal. Fires immediately (sync) if already ready.
 * Returns an unsubscribe function.
 */
export function onAppReady(listener: () => void): () => void {
  if (ready) {
    listener();
    return () => {};
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
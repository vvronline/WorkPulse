/**
 * Tiny module-level "app is ready" signal used to hide the NATIVE splash
 * screen the moment the root route has been decided — instead of holding the
 * splash for a fixed timer.
 *
 * WHY (Signal-Android parity): Signal hides its splash the instant the first
 * frame of real UI is ready. app/index.tsx calls `markAppReady()` as soon as
 * it renders its redirect (route decision made); app/_layout.tsx subscribes
 * and calls SplashScreen.hideAsync() immediately (with a hard safety cap so
 * the splash can never wedge on-screen).
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
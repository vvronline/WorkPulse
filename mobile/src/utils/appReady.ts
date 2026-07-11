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

// COLD-START TIMING: the earliest JS timestamp we can capture. `mobile/index.js`
// calls `markJsStart()` on its very first line so this reflects the moment the
// JS bundle began evaluating. `markAppReady()` logs the delta to first-frame so
// each cold-start optimization can be quantified from a single `adb logcat`
// capture (grep `[WP-COLDSTART] first-frame`). Falls back to the module-eval
// time if markJsStart() is somehow not called first.
let jsStartMs = Date.now();
let jsStartMarked = false;

/**
 * Record the JS bundle start time. Call this ONCE from the very top of
 * `mobile/index.js`, before any other work, so the cold-start timing measures
 * the full "JS eval start → first frame ready" window. Idempotent.
 */
export function markJsStart(): void {
  if (jsStartMarked) return;
  jsStartMarked = true;
  jsStartMs = Date.now();
}

/** Mark the app as ready to be revealed. Idempotent. */
export function markAppReady(): void {
  if (ready) return;
  ready = true;
  // Always-on cold-start timing trace (survives release builds). Grep
  // `[WP-COLDSTART] first-frame` in `adb logcat` to see the JS-eval→first-frame
  // duration for each launch.
  try {
    console.log(
      `[WP-COLDSTART] first-frame ready in ${Date.now() - jsStartMs}ms ` +
        `(JS eval → route decided)`,
    );
  } catch {
    /* ignore */
  }
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
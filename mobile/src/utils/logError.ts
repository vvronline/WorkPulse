/**
 * Central error sink.
 *
 * The codebase had ~195 empty `catch {}` blocks. Each one was a deliberate
 * "this must not crash the app" decision — which is correct — but the effect
 * was that genuine failures vanished silently, making "it just doesn't work
 * and there's no error" the single hardest class of bug to diagnose here.
 *
 * `logError` keeps the non-throwing behaviour while making the failure
 * OBSERVABLE. It is intentionally dependency-free and never throws, so it is
 * safe to call from any catch block — including inside other error handlers.
 *
 * There is no crash reporter wired up yet (no Sentry/Crashlytics dependency).
 * `setErrorReporter()` is the single seam to add one later without touching
 * the ~195 call sites.
 */

export type ErrorContext = Record<string, unknown>;

type Reporter = (
  scope: string,
  error: unknown,
  context?: ErrorContext,
) => void;

let reporter: Reporter | null = null;

/**
 * Install a crash-reporting backend (e.g. Sentry.captureException). Call once
 * at startup, before the first `logError`. Passing null removes it.
 */
export function setErrorReporter(fn: Reporter | null): void {
  reporter = fn;
}

/** Normalize any thrown value into a readable message. */
function describe(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

/**
 * Record a non-fatal error.
 *
 * @param scope Stable dot-delimited identifier for the failing operation,
 *              e.g. "auth.logout.pushToken" — used to group reports.
 * @param error The caught value (may be anything, not just Error).
 * @param context Optional structured metadata (ids, status codes, …).
 *                Never include tokens, passwords, or message bodies.
 */
export function logError(
  scope: string,
  error: unknown,
  context?: ErrorContext,
): void {
  try {
    if (__DEV__) {
      console.warn(`[${scope}] ${describe(error)}`, context ?? "");
    }
    reporter?.(scope, error, context);
  } catch {
    // A logging failure must never escalate into an app failure.
  }
}

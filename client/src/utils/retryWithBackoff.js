/**
 * retryWithBackoff(fn, opts) — retry an async function with exponential
 * backoff + jitter, abortable via AbortSignal.
 *
 * Why this exists
 * ───────────────
 * Several places in the meeting code do "fetch ICE servers / upload file /
 * call /:code/messages" with a single attempt, then either silently swallow
 * the failure (chat hydration) or surface "join failed" to the user (ICE
 * config fetch). On flaky networks one transient HTTP failure kicks the
 * user out of the meeting unnecessarily. This util gives every caller a
 * uniform "try, back off, give up cleanly" loop without taking on a new
 * dependency.
 *
 * Semantics
 *   - Calls `fn({ attempt, signal })` repeatedly until success, abort, or
 *     `maxAttempts` exhausted.
 *   - Delay schedule: min(maxDelayMs, baseDelayMs * 2^(attempt-1)) with
 *     ±25% full jitter so a thundering herd of clients on a flaky link
 *     doesn't reconnect in lock-step.
 *   - If `shouldRetry(err, attempt)` returns false the loop exits early
 *     with the error (e.g. caller can suppress retries on 4xx errors).
 *   - `signal` (AbortSignal): on abort the loop rejects immediately with
 *     the abort reason, even mid-sleep.
 *
 * Returns the resolved value of `fn`. Throws the LAST attempt's error if
 * every retry fails (or the abort reason if cancelled).
 */
export async function retryWithBackoff(fn, opts = {}) {
    const {
        maxAttempts = 4,
        baseDelayMs = 300,
        maxDelayMs = 5_000,
        jitter = 0.25,
        signal,
        shouldRetry = () => true,
    } = opts;

    let lastErr;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        if (signal?.aborted) throw signal.reason || new Error('aborted');
        try {
            return await fn({ attempt, signal });
        } catch (err) {
            lastErr = err;
            if (attempt >= maxAttempts) break;
            if (!shouldRetry(err, attempt)) break;
            // Exponential with capped + jittered backoff. We use full-jitter
            // ( ±jitter * delay ) which spreads retries more evenly than a
            // pure exponential and is the AWS-recommended default.
            const exp = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, attempt - 1));
            const jitterMs = exp * jitter * (Math.random() * 2 - 1);
            const delay = Math.max(0, Math.round(exp + jitterMs));
            await new Promise((resolve, reject) => {
                if (signal?.aborted) return reject(signal.reason || new Error('aborted'));
                const t = setTimeout(() => {
                    signal?.removeEventListener?.('abort', onAbort);
                    resolve();
                }, delay);
                const onAbort = () => {
                    clearTimeout(t);
                    reject(signal.reason || new Error('aborted'));
                };
                signal?.addEventListener?.('abort', onAbort, { once: true });
            });
        }
    }
    throw lastErr;
}

/**
 * Wrap any promise-returning fn so its result is aborted after `ms`
 * milliseconds. Uses `AbortSignal.timeout` where available (Chromium 103+,
 * Firefox 100+, Safari 16+, Node 17.3+, modern Electron) with a manual
 * AbortController fallback for older environments and the test runner.
 */
export function withTimeout(ms, fn) {
    let ctrl;
    let signal;
    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
        signal = AbortSignal.timeout(ms);
    } else {
        ctrl = new AbortController();
        signal = ctrl.signal;
        setTimeout(() => ctrl.abort(new DOMException('Timeout', 'TimeoutError')), ms);
    }
    return fn(signal);
}
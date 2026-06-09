import { describe, it, expect, vi } from "vitest";
import { retryWithBackoff, withTimeout } from "../utils/retryWithBackoff";

describe("retryWithBackoff", () => {
    it("returns immediately on first success without sleeping", async () => {
        const fn = vi.fn().mockResolvedValue("ok");
        const t0 = Date.now();
        const out = await retryWithBackoff(fn, { maxAttempts: 3, baseDelayMs: 100 });
        expect(out).toBe("ok");
        expect(fn).toHaveBeenCalledTimes(1);
        expect(Date.now() - t0).toBeLessThan(50);
    });

    it("retries up to maxAttempts then throws the last error", async () => {
        const err = new Error("boom");
        const fn = vi.fn().mockRejectedValue(err);
        await expect(
            retryWithBackoff(fn, { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 2, jitter: 0 })
        ).rejects.toBe(err);
        expect(fn).toHaveBeenCalledTimes(3);
    });

    it("exits early when shouldRetry returns false", async () => {
        const err = new Error("4xx");
        const fn = vi.fn().mockRejectedValue(err);
        await expect(
            retryWithBackoff(fn, {
                maxAttempts: 5,
                baseDelayMs: 1,
                shouldRetry: () => false,
            })
        ).rejects.toBe(err);
        expect(fn).toHaveBeenCalledTimes(1);
    });

    it("honours AbortSignal mid-sleep", async () => {
        const ctrl = new AbortController();
        const fn = vi.fn().mockRejectedValue(new Error("still failing"));
        // Abort almost immediately so we land in the sleep phase.
        setTimeout(() => ctrl.abort(new Error("user-cancel")), 5);
        const p = retryWithBackoff(fn, {
            maxAttempts: 5,
            baseDelayMs: 200,
            maxDelayMs: 500,
            jitter: 0,
            signal: ctrl.signal,
        });
        await expect(p).rejects.toMatchObject({ message: "user-cancel" });
        // We should have given up well before exhausting the retry budget.
        expect(fn.mock.calls.length).toBeLessThanOrEqual(2);
    });
});

describe("withTimeout", () => {
    it("passes through a resolved promise unchanged", async () => {
        const out = await withTimeout(50, async (signal) => {
            expect(signal).toBeDefined();
            return 42;
        });
        expect(out).toBe(42);
    });

    it("aborts the inner function when the timeout fires", async () => {
        const captured = await withTimeout(
            20,
            (signal) =>
                new Promise((resolve) => {
                    // The signal is what we want to assert is aborted — we don't
                    // throw here to avoid masking the actual aborted-state check.
                    setTimeout(() => resolve(signal.aborted), 60);
                })
        );
        expect(captured).toBe(true);
    });
});
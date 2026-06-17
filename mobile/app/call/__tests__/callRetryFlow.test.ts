/**
 * Unit tests for retry/backoff planning used by call signaling sends.
 */

import { buildRetryBackoffPlan } from "../../../src/realtime/socket";

describe("call retry/backoff plan", () => {
  test("builds the requested number of retry delays", () => {
    const delays = buildRetryBackoffPlan({
      maxAttempts: 4,
      initialDelayMs: 100,
      maxDelayMs: 1000,
      jitterRatio: 0,
    });
    expect(delays).toHaveLength(4);
    expect(delays).toEqual([100, 200, 400, 800]);
  });

  test("caps exponential growth at maxDelayMs", () => {
    const delays = buildRetryBackoffPlan({
      maxAttempts: 6,
      initialDelayMs: 250,
      maxDelayMs: 700,
      jitterRatio: 0,
    });
    expect(delays).toEqual([250, 500, 700, 700, 700, 700]);
  });

  test("never produces non-positive delays", () => {
    const delays = buildRetryBackoffPlan({
      maxAttempts: 5,
      initialDelayMs: 1,
      maxDelayMs: 2,
      jitterRatio: 0,
    });
    expect(delays.every((d) => d > 0)).toBe(true);
  });
});

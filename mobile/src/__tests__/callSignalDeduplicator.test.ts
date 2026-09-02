import {
  forgetInboundSignal,
  rememberInboundSignal,
} from "../calls/p2p/callSignalDeduplicator";

describe("call signal deduplication", () => {
  test("applies an identified signal once while accepting legacy signals", () => {
    const seen = new Set<string>();
    expect(rememberInboundSignal({}, seen)).toBe(true);
    expect(rememberInboundSignal({ signalId: "offer-1" }, seen)).toBe(true);
    expect(rememberInboundSignal({ signalId: "offer-1" }, seen)).toBe(false);
  });

  test("forgets a failed signal so replay can recover it", () => {
    const seen = new Set<string>();
    const signal = { signalId: "offer-1" };
    expect(rememberInboundSignal(signal, seen)).toBe(true);
    forgetInboundSignal(signal, seen);
    expect(rememberInboundSignal(signal, seen)).toBe(true);
  });
});

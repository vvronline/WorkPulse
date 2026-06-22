/// <reference types="jest" />
/**
 * Test: P3.14 consolidated mobile call state machine.
 * File: mobile/src/realtime/__tests__/callStateMachine.test.ts
 *
 * Purpose: Verify the explicit reducer's transitions and — most importantly —
 * that the terminal phases (`ended`, `rejected`) are ABSORBING so a late event
 * (e.g. a peer connection reaching "connected" a beat after the call already
 * ended) can never revive a torn-down call. This is the core effect-race fix.
 */

import {
  callStateReducer,
  initialCallPhase,
  isTerminal,
  type CallPhase,
  type CallEvent,
} from "../callStateMachine";

describe("callStateMachine — P3.14 reducer", () => {
  test("initial phase is ringing for a normal call", () => {
    expect(initialCallPhase(false)).toBe("ringing");
  });

  test("initial phase is reconnecting for a reconnect-mode launch", () => {
    expect(initialCallPhase(true)).toBe("reconnecting");
  });

  test("ACCEPT moves ringing → connecting (callee answers)", () => {
    expect(callStateReducer("ringing", { type: "ACCEPT" })).toBe("connecting");
  });

  test("PEER_ACCEPTED moves ringing → connecting (caller side)", () => {
    expect(callStateReducer("ringing", { type: "PEER_ACCEPTED" })).toBe(
      "connecting",
    );
  });

  test("PC_CONNECTED moves connecting → connected", () => {
    expect(callStateReducer("connecting", { type: "PC_CONNECTED" })).toBe(
      "connected",
    );
  });

  test("PC_RECONNECTING moves connected → connecting (relay-only rebuild)", () => {
    expect(callStateReducer("connected", { type: "PC_RECONNECTING" })).toBe(
      "connecting",
    );
  });

  test("PEER_RECONNECT moves reconnecting → connecting", () => {
    expect(callStateReducer("reconnecting", { type: "PEER_RECONNECT" })).toBe(
      "connecting",
    );
  });

  test("RING_TIMEOUT moves ringing → ended", () => {
    expect(callStateReducer("ringing", { type: "RING_TIMEOUT" })).toBe("ended");
  });

  test("REMOTE_ENDED moves connected → ended", () => {
    expect(callStateReducer("connected", { type: "REMOTE_ENDED" })).toBe(
      "ended",
    );
  });

  test("REMOTE_BUSY moves ringing → ended", () => {
    expect(callStateReducer("ringing", { type: "REMOTE_BUSY" })).toBe("ended");
  });

  test("REMOTE_REJECTED moves ringing → rejected", () => {
    expect(callStateReducer("ringing", { type: "REMOTE_REJECTED" })).toBe(
      "rejected",
    );
  });

  describe("terminal phases are absorbing (the effect-race fix)", () => {
    const allEvents: CallEvent[] = [
      { type: "ACCEPT" },
      { type: "PEER_ACCEPTED" },
      { type: "PEER_RECONNECT" },
      { type: "PC_CONNECTED" },
      { type: "PC_RECONNECTING" },
      { type: "RING_TIMEOUT" },
      { type: "REMOTE_ENDED" },
      { type: "REMOTE_REJECTED" },
      { type: "REMOTE_BUSY" },
    ];

    test("no event can revive an ended call", () => {
      for (const event of allEvents) {
        expect(callStateReducer("ended", event)).toBe("ended");
      }
    });

    test("no event can revive a rejected call", () => {
      for (const event of allEvents) {
        expect(callStateReducer("rejected", event)).toBe("rejected");
      }
    });

    test("a late PC_CONNECTED after REMOTE_ENDED never flips back to connected", () => {
      // Simulate the exact race: call ends, then a peer connection that was
      // already mid-negotiation reaches "connected" a beat later.
      let phase: CallPhase = "connecting";
      phase = callStateReducer(phase, { type: "REMOTE_ENDED" });
      expect(phase).toBe("ended");
      phase = callStateReducer(phase, { type: "PC_CONNECTED" });
      expect(phase).toBe("ended");
    });

    test("isTerminal reflects ended/rejected only", () => {
      expect(isTerminal("ended")).toBe(true);
      expect(isTerminal("rejected")).toBe(true);
      expect(isTerminal("ringing")).toBe(false);
      expect(isTerminal("connecting")).toBe(false);
      expect(isTerminal("connected")).toBe(false);
      expect(isTerminal("reconnecting")).toBe(false);
    });
  });

  test("a full happy-path outgoing call sequence", () => {
    let phase = initialCallPhase(false); // ringing
    phase = callStateReducer(phase, { type: "PEER_ACCEPTED" }); // connecting
    expect(phase).toBe("connecting");
    phase = callStateReducer(phase, { type: "PC_CONNECTED" }); // connected
    expect(phase).toBe("connected");
    phase = callStateReducer(phase, { type: "REMOTE_ENDED" }); // ended
    expect(phase).toBe("ended");
  });
});
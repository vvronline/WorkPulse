/// <reference types="jest" />
/**
 * Phase 5.1 — Per-peer connection reducer tests (mobile mesh).
 * File: mobile/src/meeting/__tests__/peerConnectionMachine.test.ts
 *
 * Purpose: Verify the pure reducer's transitions and — most importantly — that
 * the terminal phase (`closed`) is ABSORBING so a late event (e.g. a peer
 * connection reaching "connected" a beat after the peer already left / the
 * meeting was torn down) can never revive a removed peer. This is the mesh
 * analogue of the 1:1 P3.14 effect-race fix. Mirrors the web suite exactly.
 */

import {
  peerConnectionReducer,
  initialPeerPhase,
  isPeerTerminal,
  type PeerPhase,
  type PeerEvent,
} from "../peerConnectionMachine";

describe("peerConnectionMachine — Phase 5.1 per-peer reducer", () => {
  test("initial phase is connecting", () => {
    expect(initialPeerPhase()).toBe("connecting");
  });

  test("CONNECTED moves connecting → connected", () => {
    expect(peerConnectionReducer("connecting", { type: "CONNECTED" })).toBe(
      "connected",
    );
  });

  test("RECONNECTING moves connected → reconnecting (ICE blip / relay rebuild)", () => {
    expect(peerConnectionReducer("connected", { type: "RECONNECTING" })).toBe(
      "reconnecting",
    );
  });

  test("CONNECTED moves reconnecting → connected (recovery succeeded)", () => {
    expect(peerConnectionReducer("reconnecting", { type: "CONNECTED" })).toBe(
      "connected",
    );
  });

  test("FAILED moves connecting → failed (30s connect timeout / PC failed)", () => {
    expect(peerConnectionReducer("connecting", { type: "FAILED" })).toBe(
      "failed",
    );
  });

  test("RETRY moves failed → connecting (manual per-peer rebuild)", () => {
    expect(peerConnectionReducer("failed", { type: "RETRY" })).toBe(
      "connecting",
    );
  });

  test("CLOSED moves any live phase → closed", () => {
    const live: PeerPhase[] = [
      "connecting",
      "connected",
      "reconnecting",
      "failed",
    ];
    for (const phase of live) {
      expect(peerConnectionReducer(phase, { type: "CLOSED" })).toBe("closed");
    }
  });

  describe("terminal phase is absorbing (the effect-race fix)", () => {
    const allEvents: PeerEvent[] = [
      { type: "CONNECTING" },
      { type: "CONNECTED" },
      { type: "RECONNECTING" },
      { type: "FAILED" },
      { type: "RETRY" },
      { type: "CLOSED" },
    ];

    test("no event can revive a closed peer", () => {
      for (const event of allEvents) {
        expect(peerConnectionReducer("closed", event)).toBe("closed");
      }
    });

    test("a late CONNECTED after CLOSED never flips back to connected", () => {
      // Simulate the exact race: the peer leaves (participant_left →
      // closePeer), then its RTCPeerConnection — already mid-negotiation —
      // reaches "connected" a beat later. The tile must stay dead.
      let phase: PeerPhase = "connecting";
      phase = peerConnectionReducer(phase, { type: "CLOSED" });
      expect(phase).toBe("closed");
      phase = peerConnectionReducer(phase, { type: "CONNECTED" });
      expect(phase).toBe("closed");
    });

    test("isPeerTerminal reflects closed only", () => {
      expect(isPeerTerminal("closed")).toBe(true);
      expect(isPeerTerminal("connecting")).toBe(false);
      expect(isPeerTerminal("connected")).toBe(false);
      expect(isPeerTerminal("reconnecting")).toBe(false);
      // `failed` is recoverable via RETRY, so it is NOT terminal.
      expect(isPeerTerminal("failed")).toBe(false);
    });
  });

  test("a full happy-path peer lifecycle", () => {
    let phase = initialPeerPhase(); // connecting
    phase = peerConnectionReducer(phase, { type: "CONNECTED" }); // connected
    expect(phase).toBe("connected");
    phase = peerConnectionReducer(phase, { type: "RECONNECTING" }); // ICE blip
    expect(phase).toBe("reconnecting");
    phase = peerConnectionReducer(phase, { type: "CONNECTED" }); // recovered
    expect(phase).toBe("connected");
    phase = peerConnectionReducer(phase, { type: "CLOSED" }); // peer left
    expect(phase).toBe("closed");
  });

  test("a failed peer recovers via RETRY then connects", () => {
    let phase: PeerPhase = "connecting";
    phase = peerConnectionReducer(phase, { type: "FAILED" }); // timeout
    expect(phase).toBe("failed");
    phase = peerConnectionReducer(phase, { type: "RETRY" }); // user taps Retry
    expect(phase).toBe("connecting");
    phase = peerConnectionReducer(phase, { type: "CONNECTED" });
    expect(phase).toBe("connected");
  });
});
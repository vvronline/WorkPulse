/**
 * Phase 5.1 — Per-peer connection reducer for the WebRTC mesh (mobile).
 *
 * Mesh equivalent of the 1:1 call state machine (`../realtime/callStateMachine`)
 * and the exact mirror of web `client/src/pages/meeting/peerConnectionMachine.ts`.
 * In a mesh, EACH remote peer has its own long-lived `RTCPeerConnection` whose
 * lifecycle is driven from several racing sources: the
 * `onconnectionstatechange` callback (connected / disconnected / failed), the
 * relay-first fast-retry rebuild (Phase 3.1), the 30s connect-timeout
 * (Phase 3.2), ICE restarts (Phase 3.3), the manual `retryPeer`, and the
 * teardown paths (`meeting_participant_left`, `closePeer`, `leave`). Because
 * those fire from long-lived listeners / timers that can race teardown, a LATE
 * `connected` (a peer connection that reached "connected" a beat after the peer
 * already left / the call ended) could re-`upsert` a participant tile that was
 * just removed — reviving a torn-down peer. This is the mesh analogue of the
 * 1:1 P3.14 effect race.
 *
 * This module is a pure reducer whose single most important invariant is that
 * the TERMINAL phase (`closed`) is ABSORBING: once a peer is closed (it left, or
 * we tore the meeting down), NO subsequent event — including a late `CONNECTED`
 * from a peer connection that is being closed — can move it back to a live
 * phase. The WebRTC primitives are unchanged; only the phase bookkeeping is
 * centralised here so the "is this peer still alive?" decision is deterministic
 * and independently testable.
 *
 * NOTE: `failed` is NOT terminal — a `RETRY` (the manual per-peer rebuild from
 * Phase 3.2's "Couldn't connect — Retry" button) moves it back to `connecting`.
 * Only `closed` is absorbing.
 */

export type PeerPhase =
  | "connecting"
  | "connected"
  | "reconnecting"
  | "failed"
  | "closed";

/**
 * Every event that can move a peer between phases. Each maps to a real mesh
 * call site so the guard is behaviour-preserving apart from terminal absorption.
 */
export type PeerEvent =
  // A fresh PC is being negotiated (createPeer / initial offer/answer).
  | { type: "CONNECTING" }
  // The RTCPeerConnection reached "connected".
  | { type: "CONNECTED" }
  // Recovery in flight: ICE disconnected grace, ICE restart, or relay-only
  // rebuild (Phase 3.1/3.3) — we're re-establishing a previously live peer.
  | { type: "RECONNECTING" }
  // The 30s connect timeout fired, or connectionState hit "failed" — the tile
  // shows "Couldn't connect — Retry" (Phase 3.2). Recoverable via RETRY.
  | { type: "FAILED" }
  // Manual per-peer rebuild (retryPeer) → start a fresh connect attempt.
  | { type: "RETRY" }
  // TERMINAL: the peer left (`meeting_participant_left`) or we tore the peer /
  // meeting down (`closePeer` / `leave`). Absorbing.
  | { type: "CLOSED" };

export const TERMINAL_PEER_PHASES: ReadonlySet<PeerPhase> = new Set<PeerPhase>([
  "closed",
]);

export function isPeerTerminal(phase: PeerPhase): boolean {
  return TERMINAL_PEER_PHASES.has(phase);
}

/**
 * Pure transition function. The terminal phase is absorbing (the Phase 5.1 race
 * fix): once a peer has been closed, NO subsequent event — including a late
 * `CONNECTED` from a peer connection that is being torn down — can move it back
 * to a live phase, so a removed participant tile can never be resurrected.
 */
export function peerConnectionReducer(
  state: PeerPhase,
  event: PeerEvent,
): PeerPhase {
  if (isPeerTerminal(state)) return state;

  switch (event.type) {
    case "CONNECTING":
    case "RETRY":
      return "connecting";
    case "CONNECTED":
      return "connected";
    case "RECONNECTING":
      return "reconnecting";
    case "FAILED":
      return "failed";
    case "CLOSED":
      return "closed";
    default:
      return state;
  }
}

/** Initial phase for a freshly-created peer connection. */
export function initialPeerPhase(): PeerPhase {
  return "connecting";
}
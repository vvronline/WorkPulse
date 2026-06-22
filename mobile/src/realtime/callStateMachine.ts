/**
 * P3.14 — Consolidated mobile call state machine.
 *
 * The native call screen (`mobile/app/call/[conversationId].tsx`) historically
 * drove its lifecycle with a single `useState<CallStatus>` mutated from NINE
 * different places: async WS signal handlers (`call_accepted`, `call_reconnect`,
 * `call_ended`, `call_rejected`, `call_busy`), the RTCPeerConnection
 * `onconnectionstatechange` callback (connected / relay-only rebuild), the
 * outgoing ring-timeout effect, and `acceptIncoming()`. Because several of those
 * fire from long-lived listeners / timers that can race teardown, a LATE
 * `setStatus("connected")` (e.g. a peer connection that reached "connected" a
 * beat after `call_ended` arrived) could flip the UI back to a live call after
 * it had already ended — a classic effect race.
 *
 * This module replaces that ad-hoc `setStatus` with an explicit, pure reducer:
 *   idle/ringing → connecting → (re)connecting → connected → ended/rejected
 * The single most important invariant is that the TERMINAL phases (`ended`,
 * `rejected`) are ABSORBING: once a call is torn down, no later event can revive
 * it. The WebRTC primitives (peer connection, media, ICE) are unchanged — only
 * the phase bookkeeping is centralised here so transitions are deterministic and
 * independently testable.
 */

export type CallPhase =
  | "ringing"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "ended"
  | "rejected";

/**
 * Every event that can move the call between phases. Each maps 1:1 to a former
 * `setStatus(...)` call site so the refactor is behaviour-preserving apart from
 * the new terminal-absorption guard.
 */
export type CallEvent =
  // Local user accepted an INCOMING call (acceptIncoming).
  | { type: "ACCEPT" }
  // CALLER side: the callee accepted (`call_accepted`) → start negotiating.
  | { type: "PEER_ACCEPTED" }
  // The peer rejoined a still-active call (`call_reconnect`) → we re-offer.
  | { type: "PEER_RECONNECT" }
  // The RTCPeerConnection reached "connected".
  | { type: "PC_CONNECTED" }
  // ICE failed and we are rebuilding the PC relay-only (back to connecting).
  | { type: "PC_RECONNECTING" }
  // Outgoing call rang with no answer (ring timeout) → ended.
  | { type: "RING_TIMEOUT" }
  // Peer/server ended the call (`call_ended`) → ended.
  | { type: "REMOTE_ENDED" }
  // Peer declined (`call_rejected`) → rejected.
  | { type: "REMOTE_REJECTED" }
  // Callee was on another call (`call_busy`) → ended.
  | { type: "REMOTE_BUSY" };

export const TERMINAL_PHASES: ReadonlySet<CallPhase> = new Set<CallPhase>([
  "ended",
  "rejected",
]);

export function isTerminal(phase: CallPhase): boolean {
  return TERMINAL_PHASES.has(phase);
}

/**
 * Pure transition function. Terminal phases are absorbing (the P3.14 race fix):
 * once the call has ended or been rejected, NO subsequent event — including a
 * late PC_CONNECTED from a peer connection that is being torn down, or a
 * delayed PEER_ACCEPTED — can move it back to a live phase.
 */
export function callStateReducer(
  state: CallPhase,
  event: CallEvent,
): CallPhase {
  if (isTerminal(state)) return state;

  switch (event.type) {
    case "ACCEPT":
    case "PEER_ACCEPTED":
    case "PEER_RECONNECT":
    case "PC_RECONNECTING":
      return "connecting";
    case "PC_CONNECTED":
      return "connected";
    case "RING_TIMEOUT":
    case "REMOTE_ENDED":
    case "REMOTE_BUSY":
      return "ended";
    case "REMOTE_REJECTED":
      return "rejected";
    default:
      return state;
  }
}

/**
 * Initial phase for `useReducer`. A reconnect-mode launch (rejoining a still
 * active call) starts in `reconnecting`; everything else starts `ringing`.
 */
export function initialCallPhase(isReconnect: boolean): CallPhase {
  return isReconnect ? "reconnecting" : "ringing";
}
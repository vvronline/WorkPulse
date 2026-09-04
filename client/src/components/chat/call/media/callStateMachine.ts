/**
 * Absorbing web call state machine + lifecycle event serializer.
 *
 * The overlay historically drove `status` with a bare `useState` written from
 * a dozen async places (websocket handlers, ring/connect timers, peer
 * connection callbacks). With an SFU in the picture there are now MORE async
 * writers — `RoomEvent.Connected`, `Reconnecting`, `Reconnected` and
 * `Disconnected` all fire from a socket the SDK owns and tears down on its own
 * schedule. A `Connected` callback that lands a beat AFTER the peer hung up
 * would otherwise flip a dead call back to "connected".
 *
 * Two mechanisms prevent that:
 *   1. TERMINAL phases (`ended`, `rejected`) are ABSORBING — no event moves the
 *      call out of them. This mirrors `mobile/src/calls/p2p/callStateMachine.ts`.
 *   2. Every lifecycle/media event is pushed through a serial queue, so an
 *      async handler can never interleave with the teardown it races.
 */

export type WebCallPhase =
  | "incoming"
  | "ringing"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "ended"
  | "rejected";

export type WebCallEvent =
  /** Local user pressed Accept on an incoming call. */
  | { type: "LOCAL_ACCEPT" }
  /** `call_accepted` — the callee picked up; the caller starts negotiating. */
  | { type: "PEER_ACCEPTED" }
  /** `call_reconnect` — the peer rejoined a still-active call. */
  | { type: "PEER_RECONNECT" }
  /** Media transport reached a usable state (PC connected / Room connected). */
  | { type: "MEDIA_CONNECTED" }
  /** Media transport is re-establishing itself (ICE restart / Room reconnecting). */
  | { type: "MEDIA_RECONNECTING" }
  /**
   * Media transport dropped. Deliberately NOT terminal: only WorkPulse ends a
   * call, so a dropped SFU socket shows "reconnecting", never "ended".
   */
  | { type: "MEDIA_DISCONNECTED" }
  /** Outgoing call rang out. */
  | { type: "RING_TIMEOUT" }
  /** `call_ended` from the server. */
  | { type: "REMOTE_ENDED" }
  /** `call_rejected` from the server. */
  | { type: "REMOTE_REJECTED" }
  /** `call_busy` / `call_cancelled` from the server. */
  | { type: "REMOTE_BUSY" }
  /** Local user hung up. */
  | { type: "LOCAL_END" }
  /** Local user declined. */
  | { type: "LOCAL_REJECT" }
  /**
   * The server-side media negotiation could not produce a transport (bounded
   * retries exhausted). The client is not allowed to guess one, so the call
   * cannot be set up — terminal, and reported as ended.
   */
  | { type: "SETUP_FAILED" };

export const TERMINAL_PHASES: ReadonlySet<WebCallPhase> = new Set<WebCallPhase>([
  "ended",
  "rejected",
]);

export function isTerminalPhase(phase: WebCallPhase): boolean {
  return TERMINAL_PHASES.has(phase);
}

/**
 * Pure transition function. Terminal phases absorb every subsequent event,
 * including a late `MEDIA_CONNECTED` from a Room that is still finishing its
 * handshake while we tear the call down.
 */
export function webCallReducer(state: WebCallPhase, event: WebCallEvent): WebCallPhase {
  if (isTerminalPhase(state)) return state;

  switch (event.type) {
    case "LOCAL_ACCEPT":
    case "PEER_ACCEPTED":
    case "PEER_RECONNECT":
      return "connecting";
    case "MEDIA_CONNECTED":
      return "connected";
    case "MEDIA_RECONNECTING":
    case "MEDIA_DISCONNECTED":
      // Only a call that had media can "re-"connect; a drop while still
      // ringing/connecting leaves the phase where it is.
      return state === "connected" ? "reconnecting" : state;
    case "RING_TIMEOUT":
    case "REMOTE_ENDED":
    case "REMOTE_BUSY":
    case "LOCAL_END":
    case "SETUP_FAILED":
      return "ended";
    case "REMOTE_REJECTED":
    case "LOCAL_REJECT":
      return "rejected";
    default:
      return state;
  }
}

export function initialWebCallPhase(opts: {
  isReconnect?: boolean;
  isPreAccepted?: boolean;
  isIncoming?: boolean;
}): WebCallPhase {
  if (opts.isReconnect) return "reconnecting";
  if (opts.isPreAccepted) return "connecting";
  return opts.isIncoming ? "incoming" : "ringing";
}

/**
 * A tiny mutable machine so non-React callers (the LiveKit engine bindings,
 * durable teardown helpers) can consult and advance the same phase the overlay
 * renders, without prop-drilling a reducer.
 */
export interface CallStateMachine {
  getPhase(): WebCallPhase;
  isTerminal(): boolean;
  /** Applies the event and returns the (possibly unchanged) resulting phase. */
  dispatch(event: WebCallEvent): WebCallPhase;
  subscribe(listener: (phase: WebCallPhase, event: WebCallEvent) => void): () => void;
}

export function createCallStateMachine(initial: WebCallPhase): CallStateMachine {
  let phase = initial;
  const listeners = new Set<(phase: WebCallPhase, event: WebCallEvent) => void>();

  return {
    getPhase: () => phase,
    isTerminal: () => isTerminalPhase(phase),
    dispatch(event) {
      const next = webCallReducer(phase, event);
      if (next !== phase) {
        phase = next;
        for (const listener of listeners) {
          try {
            listener(phase, event);
          } catch {
            /* a bad subscriber must not break the machine */
          }
        }
      }
      return phase;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/**
 * Serial task queue. Lifecycle and media events are enqueued rather than run
 * inline so two async handlers (say `RoomEvent.Reconnected` and the websocket
 * `call_ended`) can never interleave their awaits and land out of order.
 */
export interface SerialQueue {
  enqueue(task: () => void | Promise<void>): Promise<void>;
  /** Number of tasks queued but not yet started (excludes the running one). */
  readonly pending: number;
}

export function createSerialQueue(
  onError: (err: unknown) => void = () => {},
): SerialQueue {
  let tail: Promise<void> = Promise.resolve();
  let pending = 0;

  return {
    enqueue(task) {
      pending += 1;
      tail = tail.then(async () => {
        pending -= 1;
        try {
          await task();
        } catch (err) {
          onError(err);
        }
      });
      return tail;
    },
    get pending() {
      return pending;
    },
  };
}

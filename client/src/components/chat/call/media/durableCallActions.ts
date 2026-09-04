/**
 * Durable LOCAL terminal call actions (reject / end).
 *
 * The websocket emit is the fast path but it is fire-and-forget: the browser
 * transport queue is bounded and the server never echoes `call_ended` /
 * `call_rejected` back to the sender, so "I clicked Decline" has no
 * acknowledgement of its own. That is exactly the "declined but the caller
 * keeps ringing" failure mobile already fixed in
 * `mobile/src/services/nativeCallService.ts`, with:
 *
 *   1. an acknowledged retry — re-emit with exponential backoff + jitter until
 *      the transport accepts the frame, and
 *   2. an idempotent HTTP confirmation — `POST /chat/calls/:id/reject|end`,
 *      which the server treats as success when the call is already terminal.
 *
 * Both emits carry the same `clientMsgId`, which the server's
 * `withIdempotentCallAction` uses to collapse duplicates, so the retry and the
 * confirmation can never double-apply a transition.
 */
import { endCallHttp, rejectCallHttp } from "../../../../api";

export type TerminalCallAction = "reject" | "end";

export interface DurableCallActionOptions {
  action: TerminalCallAction;
  callId: number | string | null | undefined;
  conversationId: number | string | null | undefined;
  wsSend: (type: string, payload: unknown) => void;
  /** Optional transport-liveness probe; when absent we assume the socket is up. */
  isSocketLive?: () => boolean;
  /** Total budget for the socket retry loop. */
  timeoutMs?: number;
  maxAttempts?: number;
  initialBackoffMs?: number;
  maxBackoffMs?: number;
  jitterRatio?: number;
  /** Injected in tests. */
  httpConfirm?: (
    action: TerminalCallAction,
    callId: number | string,
    conversationId: number | string,
  ) => Promise<unknown>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /**
   * When false the websocket emit is skipped entirely and only the idempotent
   * HTTP confirmation runs. Used by the legacy p2p path, where `useWebRTC` has
   * already emitted `call_end` / `call_reject` itself — re-emitting here would
   * double-send the frame, while the confirmation is what was missing.
   */
  emitSocket?: boolean;
}

export interface DurableCallActionResult {
  socketDelivered: boolean;
  httpConfirmed: boolean;
  clientMsgId: string;
  /** True when this action was collapsed into an already-running one. */
  deduped: boolean;
}

const inFlight = new Map<string, Promise<DurableCallActionResult>>();

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function defaultHttpConfirm(
  action: TerminalCallAction,
  callId: number | string,
  conversationId: number | string,
): Promise<unknown> {
  return action === "reject"
    ? rejectCallHttp(callId, conversationId)
    : endCallHttp(callId, conversationId);
}

function buildBackoffPlan(
  maxAttempts: number,
  initialDelayMs: number,
  maxDelayMs: number,
  jitterRatio: number,
): number[] {
  const plan: number[] = [];
  let delay = Math.max(1, initialDelayMs);
  for (let i = 0; i < Math.max(0, maxAttempts); i++) {
    const jitter = delay * jitterRatio * (Math.random() * 2 - 1);
    plan.push(Math.max(1, Math.round(delay + jitter)));
    delay = Math.min(maxDelayMs, delay * 2);
  }
  return plan;
}

/**
 * Emit + confirm one local terminal action. Never throws: a call the user has
 * hung up must tear down locally whatever the network does.
 */
export async function sendDurableCallAction(
  options: DurableCallActionOptions,
): Promise<DurableCallActionResult> {
  const {
    action,
    callId,
    conversationId,
    wsSend,
    isSocketLive,
    timeoutMs = 6000,
    maxAttempts = 7,
    initialBackoffMs = 120,
    maxBackoffMs = 1000,
    jitterRatio = 0.12,
    httpConfirm = defaultHttpConfirm,
    sleep = defaultSleep,
    now = Date.now,
    emitSocket = true,
  } = options;

  const clientMsgId = `web:${action}:${callId}:${conversationId}:${now()}`;

  if (callId == null || conversationId == null) {
    // Nothing durable to do — an outgoing call that never got its id back.
    if (emitSocket) {
      try {
        wsSend(`call_${action}`, { callId, conversationId, clientMsgId });
      } catch {
        /* ignore */
      }
    }
    return {
      socketDelivered: false,
      httpConfirmed: false,
      clientMsgId,
      deduped: false,
    };
  }

  const key = `${action}:${callId}:${conversationId}`;
  const existing = inFlight.get(key);
  if (existing) {
    const result = await existing;
    return { ...result, deduped: true };
  }

  const run = (async (): Promise<DurableCallActionResult> => {
    const payload = { callId, conversationId, clientMsgId };
    const deadline = now() + Math.max(1, timeoutMs);
    let socketDelivered = false;

    const attempt = (): boolean => {
      if (isSocketLive && !isSocketLive()) return false;
      try {
        wsSend(`call_${action}`, payload);
        return true;
      } catch {
        return false;
      }
    };

    socketDelivered = emitSocket ? attempt() : false;
    if (emitSocket && !socketDelivered) {
      const plan = buildBackoffPlan(
        Math.max(0, maxAttempts - 1),
        initialBackoffMs,
        maxBackoffMs,
        jitterRatio,
      );
      for (const delay of plan) {
        const remaining = deadline - now();
        if (remaining <= 0) break;
        await sleep(Math.min(delay, remaining));
        socketDelivered = attempt();
        if (socketDelivered) break;
      }
    }

    // The confirmation runs even when the frame was handed to a live socket:
    // the server never acks call actions to their sender, so an HTTP 2xx is
    // the only acknowledgement this client can actually observe. It is
    // idempotent by `clientMsgId` and by the route's already-terminal check.
    let httpConfirmed = false;
    try {
      await httpConfirm(action, callId, conversationId);
      httpConfirmed = true;
    } catch (err: unknown) {
      const status = (err as { response?: { status?: number } })?.response?.status;
      // 404 = the server has no record of the call; nothing left to confirm.
      if (status === 404) httpConfirmed = true;
      else {
        console.warn(
          `[call-media] durable ${action} HTTP confirmation failed:`,
          (err as { message?: string })?.message || err,
        );
      }
    }

    return { socketDelivered, httpConfirmed, clientMsgId, deduped: false };
  })();

  inFlight.set(key, run);
  try {
    return await run;
  } finally {
    inFlight.delete(key);
  }
}

/** Test helper — drops the in-flight dedupe table. */
export function resetDurableCallActions(): void {
  inFlight.clear();
}

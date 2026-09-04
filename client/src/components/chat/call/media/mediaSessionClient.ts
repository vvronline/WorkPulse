/**
 * Media-session client — the ONE place that talks to
 * `GET /chat/calls/:callId/media-session`.
 *
 * Design rules baked in here:
 *
 *  • The transport is chosen by the SERVER, once per call. Only an explicit
 *    `backend: "p2p"` selects the legacy peer-to-peer engine. There is no
 *    client-side default and no local degrade: if this client guessed p2p while
 *    the server had already placed the other peer in an SFU room, the call
 *    would look connected and carry no media. Failing setup is strictly better
 *    than a silent split-brain call.
 *
 *  • Every failure mode — timeout, transport error, 4xx (including 404), 5xx,
 *    405/501 from a deployment that never shipped the route, or a 2xx body that
 *    is not a usable verdict — is retried a BOUNDED number of times and then
 *    fails call setup. None of them pick a transport.
 *
 *  • A successful verdict is memoised per call so a remount of the overlay
 *    (PiP hand-off, StrictMode double-mount, reconnect after refresh) can never
 *    flip a live call between transports. Failures are not memoised; the caller
 *    ends the call on the first one, so there is nothing left to cache.
 */
import { getCallMediaSession } from "../../../../api";
import type {
  CallMediaBackend,
  CallMediaFailure,
  CallMediaSession,
  CallMediaSessionResult,
  LiveKitCredentials,
} from "./types";

/** How long a single attempt may delay call setup. */
export const MEDIA_SESSION_TIMEOUT_MS = 4000;
/** Bounded retry budget. Worst case is `attempts * timeout` before we give up. */
export const MEDIA_SESSION_ATTEMPTS = 3;
/** Backoff between attempts. Short: this is on the critical path of a ringing call. */
export const MEDIA_SESSION_RETRY_DELAY_MS = 250;

const resolvedByCall = new Map<string, CallMediaSession>();
const inFlightByCall = new Map<string, Promise<CallMediaSessionResult>>();

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function parseLiveKit(raw: unknown): LiveKitCredentials | null {
  if (!raw || typeof raw !== "object") return null;
  const { serverUrl, token, roomName } = raw as Record<string, unknown>;
  if (!isNonEmptyString(serverUrl) || !isNonEmptyString(token) || !isNonEmptyString(roomName)) {
    return null;
  }
  return { serverUrl, token, roomName };
}

/**
 * Normalise a raw response body into a `CallMediaSession`, or `null` when the
 * body does not carry a usable server verdict. Exported so the parsing rules
 * (which decide whether a call goes to the SFU) are unit testable without any
 * HTTP or React involved.
 *
 * `null` means "unusable", NOT "p2p" — a `livekit` verdict whose credentials
 * are missing is a broken server response, not permission to run p2p.
 */
export function parseCallMediaSession(
  raw: unknown,
  fallbackCallId: number | string | null = null,
  fallbackConversationId: number | string | null = null,
): CallMediaSession | null {
  if (!raw || typeof raw !== "object") return null;
  const body = raw as Record<string, unknown>;
  const callId = (body.callId as number | string | undefined) ?? fallbackCallId;
  const conversationId =
    (body.conversationId as number | string | undefined) ?? fallbackConversationId;
  const backend = body.backend as CallMediaBackend | undefined;

  if (backend === "livekit") {
    const livekit = parseLiveKit(body.livekit);
    if (!livekit) return null;
    return { backend: "livekit", callId, conversationId, livekit };
  }
  if (backend === "p2p") {
    return { backend: "p2p", callId, conversationId };
  }
  return null;
}

function cacheKey(callId: number | string, conversationId: number | string): string {
  return `${callId}:${conversationId}`;
}

export interface FetchMediaSessionOptions {
  timeoutMs?: number;
  attempts?: number;
  retryDelayMs?: number;
  /** Injected in tests. Defaults to the shared axios chat client. */
  request?: typeof getCallMediaSession;
}

type AttemptOutcome =
  | { ok: true; session: CallMediaSession }
  | { ok: false; reason: CallMediaFailure["reason"]; status?: number; message: string };

/** One attempt. Never throws. */
async function attemptMediaSession(
  callId: number | string,
  conversationId: number | string,
  request: typeof getCallMediaSession,
  timeoutMs: number,
): Promise<AttemptOutcome> {
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => {
        try {
          controller?.abort();
        } catch {
          /* ignore */
        }
        resolve(null);
      }, timeoutMs);
    });
    const response = await Promise.race([
      request(callId, conversationId, controller ? { signal: controller.signal } : undefined),
      timeout,
    ]);
    if (!response) {
      return { ok: false, reason: "timeout", message: `timed out after ${timeoutMs}ms` };
    }
    const session = parseCallMediaSession(
      (response as { data?: unknown }).data,
      callId,
      conversationId,
    );
    if (!session) {
      return {
        ok: false,
        reason: "malformed",
        message: "server returned no usable media backend",
      };
    }
    return { ok: true, session };
  } catch (err: unknown) {
    const status = (err as { response?: { status?: number } })?.response?.status;
    const message = (err as { message?: string })?.message || "media-session request failed";
    if (status != null) return { ok: false, reason: "http", status, message };
    return { ok: false, reason: "network", message };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const sleep = (ms: number) =>
  ms > 0 ? new Promise<void>((resolve) => setTimeout(resolve, ms)) : Promise.resolve();

/**
 * Resolve the media backend for a call. Never rejects, and never invents a
 * verdict: the result is either the server's choice or an explicit failure the
 * caller turns into a failed call setup.
 */
export async function fetchCallMediaSession(
  callId: number | string,
  conversationId: number | string,
  options: FetchMediaSessionOptions = {},
): Promise<CallMediaSessionResult> {
  const {
    timeoutMs = MEDIA_SESSION_TIMEOUT_MS,
    attempts = MEDIA_SESSION_ATTEMPTS,
    retryDelayMs = MEDIA_SESSION_RETRY_DELAY_MS,
    request = getCallMediaSession,
  } = options;

  const key = cacheKey(callId, conversationId);
  const already = resolvedByCall.get(key);
  if (already) return { ok: true, session: already };
  const pending = inFlightByCall.get(key);
  if (pending) return pending;

  const budget = Math.max(1, attempts);
  const run = (async (): Promise<CallMediaSessionResult> => {
    let last: AttemptOutcome = {
      ok: false,
      reason: "network",
      message: "media-session was never attempted",
    };
    for (let attempt = 1; attempt <= budget; attempt++) {
      last = await attemptMediaSession(callId, conversationId, request, timeoutMs);
      if (last.ok) {
        resolvedByCall.set(key, last.session);
        return { ok: true, session: last.session };
      }
      if (attempt < budget) await sleep(retryDelayMs);
    }
    return {
      ok: false,
      failure: {
        reason: last.reason,
        status: last.status,
        message: last.message,
        attempts: budget,
      },
    };
  })();

  const guarded = run.then((result) => {
    inFlightByCall.delete(key);
    return result;
  });
  inFlightByCall.set(key, guarded);
  return guarded;
}

/** Drop the memoised verdict for a finished call (and for tests). */
export function forgetCallMediaSession(
  callId?: number | string,
  conversationId?: number | string,
): void {
  if (callId == null || conversationId == null) {
    resolvedByCall.clear();
    inFlightByCall.clear();
    return;
  }
  const key = cacheKey(callId, conversationId);
  resolvedByCall.delete(key);
  inFlightByCall.delete(key);
}

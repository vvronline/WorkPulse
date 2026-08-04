import axios, { AxiosError } from "axios";

/**
 * Normalizes anything thrown by an API call into one predictable shape.
 *
 * PROBLEM: error handling was ad-hoc at every call site. The backend can
 * signal a failure in at least four different shapes —
 *
 *     { error: "Not allowed" }            // standard envelope
 *     { message: "Not allowed" }          // some newer routes
 *     { errors: { email: ["taken"] } }    // validation responses
 *     "Not allowed"                       // plain-text 500s / proxy errors
 *
 * — and on top of that a request can fail with NO response at all (offline,
 * DNS failure, or the 60s timeout). Screens that only read
 * `err.response.data.error` therefore showed "undefined" or a blank toast for
 * most real failures, which is a large part of why so many catch blocks ended
 * up empty.
 *
 * `toApiError` collapses all of that into an `ApiError` whose `message` is
 * always non-empty and always safe to display.
 */

/** Coarse failure category — lets UI react without string-matching messages. */
export type ApiErrorKind =
  | "network" // no response: offline, DNS, connection refused
  | "timeout" // request exceeded the client timeout
  | "canceled" // aborted by us (unmount, new search keystroke)
  | "unauthorized" // 401 — token missing/expired
  | "forbidden" // 403 — authenticated but not permitted
  | "notFound" // 404
  | "validation" // 400/422 with field errors
  | "conflict" // 409
  | "rateLimited" // 429
  | "server" // 5xx
  | "client" // other 4xx
  | "unknown";

export type ApiError = {
  /** Human-readable, always non-empty, safe to show in a toast. */
  message: string;
  kind: ApiErrorKind;
  /** HTTP status when the server responded. */
  status?: number;
  /** Per-field messages from a validation response. */
  fieldErrors?: Record<string, string[]>;
  /** True when retrying the same request could plausibly succeed. */
  retryable: boolean;
  /** The original thrown value, for logging. Never render this. */
  cause: unknown;
};

const DEFAULT_MESSAGE = "Something went wrong. Please try again.";

const MESSAGE_BY_KIND: Record<ApiErrorKind, string> = {
  network: "No internet connection. Check your network and try again.",
  timeout: "The request took too long. Please try again.",
  canceled: "Request canceled.",
  unauthorized: "Your session has expired. Please sign in again.",
  forbidden: "You don't have permission to do that.",
  notFound: "We couldn't find what you were looking for.",
  validation: "Please check the highlighted fields and try again.",
  conflict: "That conflicts with existing data. Refresh and try again.",
  rateLimited: "Too many requests. Please wait a moment and try again.",
  server: "The server ran into a problem. Please try again shortly.",
  client: DEFAULT_MESSAGE,
  unknown: DEFAULT_MESSAGE,
};

function kindFromStatus(status: number): ApiErrorKind {
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) return "notFound";
  if (status === 409) return "conflict";
  if (status === 422 || status === 400) return "validation";
  if (status === 429) return "rateLimited";
  if (status >= 500) return "server";
  if (status >= 400) return "client";
  return "unknown";
}

/** Pull the most specific message the payload offers, if any. */
function extractMessage(payload: unknown): string | null {
  if (typeof payload === "string") {
    const trimmed = payload.trim();
    // Guard against an HTML error page being rendered into a toast.
    if (!trimmed || trimmed.startsWith("<")) return null;
    return trimmed;
  }
  if (!payload || typeof payload !== "object") return null;
  const body = payload as Record<string, unknown>;
  for (const field of ["error", "message", "detail", "title"]) {
    const value = body[field];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

/** Normalize a validation payload into `{ field: [messages] }`. */
function extractFieldErrors(
  payload: unknown,
): Record<string, string[]> | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const raw = (payload as Record<string, unknown>).errors;
  if (!raw || typeof raw !== "object") return undefined;

  const result: Record<string, string[]> = {};
  for (const [field, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === "string") result[field] = [value];
    else if (Array.isArray(value)) {
      const messages = value.filter((v): v is string => typeof v === "string");
      if (messages.length) result[field] = messages;
    }
  }
  return Object.keys(result).length ? result : undefined;
}

/** Convert any thrown value into a displayable `ApiError`. */
export function toApiError(error: unknown): ApiError {
  if (axios.isCancel?.(error)) {
    return {
      message: MESSAGE_BY_KIND.canceled,
      kind: "canceled",
      retryable: false,
      cause: error,
    };
  }

  if (axios.isAxiosError(error)) {
    const axiosError = error as AxiosError;
    const response = axiosError.response;

    // No response → the request never completed.
    if (!response) {
      const isTimeout =
        axiosError.code === "ECONNABORTED" ||
        axiosError.code === "ETIMEDOUT" ||
        /timeout/i.test(axiosError.message ?? "");
      const kind: ApiErrorKind = isTimeout ? "timeout" : "network";
      return {
        message: MESSAGE_BY_KIND[kind],
        kind,
        retryable: true,
        cause: error,
      };
    }

    const status = response.status;
    const kind = kindFromStatus(status);
    const fieldErrors = extractFieldErrors(response.data);
    // Prefer the server's own wording — it is the most specific — and fall
    // back to our generic copy for that category.
    const message =
      extractMessage(response.data) ?? MESSAGE_BY_KIND[kind] ?? DEFAULT_MESSAGE;

    return {
      message,
      kind,
      status,
      fieldErrors,
      // Only transient failures are worth retrying automatically: a 4xx will
      // fail identically no matter how many times it is repeated.
      retryable: kind === "server" || kind === "rateLimited",
      cause: error,
    };
  }

  if (error instanceof Error) {
    return {
      message: error.message?.trim() || DEFAULT_MESSAGE,
      kind: "unknown",
      retryable: false,
      cause: error,
    };
  }

  return {
    message: DEFAULT_MESSAGE,
    kind: "unknown",
    retryable: false,
    cause: error,
  };
}

/**
 * Shorthand for the common `catch (e) { toast(getErrorMessage(e)) }` case.
 * Always returns a non-empty, user-safe string.
 */
export function getErrorMessage(error: unknown): string {
  return toApiError(error).message;
}

/** True when the failure was purely a connectivity problem. */
export function isOffline(error: unknown): boolean {
  return toApiError(error).kind === "network";
}

/**
 * Shared React Query `retry` predicate.
 *
 * The default retries EVERYTHING three times — including 401/403/404, where
 * every attempt is guaranteed to fail. On a flaky mobile connection that turns
 * one instant "not found" into ~3 minutes of spinner (each attempt can burn
 * the full 60s timeout). This retries only genuinely transient failures.
 */
export function shouldRetryRequest(failureCount: number, error: unknown) {
  if (failureCount >= 3) return false;
  return toApiError(error).retryable;
}


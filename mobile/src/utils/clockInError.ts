/**
 * Maps the server's clock-in verification error (code + message) into a
 * user-facing { kind, title, message } triple so the UI can render a clear,
 * specific reason — "Location Mismatch" vs "Face Mismatch" — instead of a
 * single flat "Clock-in failed" string.
 *
 * The backend (server/routes/tracker.ts, POST /tracker/clock-in) returns a
 * structured body like { error: "...", code: "OUTSIDE_GEOFENCE" }. We key off
 * the stable `code` (falling back to keyword sniffing on the message when the
 * code is missing, e.g. older servers) and always preserve the server's exact
 * detail text (distance/radius, lighting hint, etc.).
 */

export type ClockInErrorKind = "location" | "face" | "generic";

export interface ClockInErrorInfo {
  kind: ClockInErrorKind;
  title: string;
  message: string;
}

const LOCATION_CODES = new Set([
  "OUTSIDE_GEOFENCE",
  "LOCATION_REQUIRED",
  "OFFICE_LOCATION_NOT_CONFIGURED",
  "LOCATION_TOO_COARSE",
]);

const FACE_CODES = new Set([
  "FACE_MISMATCH",
  "FACE_NOT_ENROLLED",
  "FACE_REQUIRED",
  "FACE_REPLAY",
  "FACE_ATTEMPTS_LOCKED",
]);

/**
 * Pull the most specific error info available from an axios error (or any
 * thrown value). Handles the common backend shapes:
 *   - { error: string, code?: string }
 *   - plain string body
 * and the no-response (transport/timeout) case.
 */
export function clockInErrorInfo(err: unknown): ClockInErrorInfo {
  const e = err as {
    response?: { data?: { error?: string; code?: string } | string };
    message?: string;
    code?: string;
  };

  const data = e?.response?.data;
  let serverMessage: string | undefined;
  let code: string | undefined;

  if (typeof data === "string") {
    serverMessage = data;
  } else if (data && typeof data === "object") {
    serverMessage = data.error || undefined;
    code = data.code || undefined;
  }

  // Transport-level failure (no HTTP response at all): network drop / timeout.
  if (!e?.response) {
    return {
      kind: "generic",
      title: "Login Failed",
      message:
        "Couldn't reach the server. Check your connection and try again.",
    };
  }

  const msg = serverMessage || "Login failed. Please try again.";

  // Prefer the stable code; fall back to sniffing the message text.
  const lower = msg.toLowerCase();
  const isLocation =
    (code && LOCATION_CODES.has(code)) ||
    (!code &&
      (lower.includes("office") ||
        lower.includes("geofence") ||
        lower.includes("location") ||
        lower.includes(" m from")));
  const isFace =
    (code && FACE_CODES.has(code)) ||
    (!code && lower.includes("face"));

  if (isLocation) {
    return { kind: "location", title: "Location Mismatch", message: msg };
  }
  if (isFace) {
    return { kind: "face", title: "Face Mismatch", message: msg };
  }
  return { kind: "generic", title: "Login Failed", message: msg };
}
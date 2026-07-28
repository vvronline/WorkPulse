import Constants from "expo-constants";

type Extra = {
  API_BASE_URL?: string;
  WS_BASE_URL?: string;
  TENOR_API_KEY?: string;
  TENOR_CLIENT_KEY?: string;
  // App version string surfaced from package.json (used by the in-app updater).
  APP_VERSION?: string;
  // Feature flags (string "true"/"false" or boolean — coerced below).
  ANDROID_NATIVE_CALL_UI?: boolean | string;
};

const extra = (Constants.expoConfig?.extra ?? {}) as Extra;

/** Coerce an extra value that may arrive as a boolean OR a string into bool. */
function asBool(value: boolean | string | undefined): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return value.toLowerCase() === "true";
  return false;
}

/**
 * P3.15 — Feature flag gating the Android native incoming-call surface
 * (react-native-callkeep ConnectionService / CallStyle UI). DEFAULT OFF: the
 * current react-native-callkeep build can crash at startup on some RN versions
 * (duplicate exported method names), so the native surface stays opt-in until a
 * build is verified. Enable per-build via `EXPO_PUBLIC_ANDROID_NATIVE_CALL_UI=true`.
 * iOS always uses CallKit (this flag only gates the Android branch).
 */
export const ANDROID_NATIVE_CALL_UI = asBool(extra.ANDROID_NATIVE_CALL_UI);

/**
 * REST API base, e.g. https://www.aino.org.in/api
 *
 * Must be the `www.` host: the apex `aino.org.in` is a registrar redirect and
 * is NOT served by Railway (it 404s on /api). This default only applies when
 * `extra` is missing (it is populated from app.config.ts at build time).
 */
export const API_BASE_URL =
  extra.API_BASE_URL ?? "https://www.aino.org.in/api";

/** WebSocket base, e.g. wss://www.aino.org.in */
export const WS_BASE_URL = extra.WS_BASE_URL ?? "wss://www.aino.org.in";

export const TENOR_API_KEY = extra.TENOR_API_KEY ?? "";
export const TENOR_CLIENT_KEY = extra.TENOR_CLIENT_KEY ?? "workpulse-chat";

/** Full WebSocket endpoint (server listens on /ws). */
export function wsUrl(token: string): string {
  return `${WS_BASE_URL}/ws?token=${encodeURIComponent(token)}`;
}

/** Server origin (without the trailing /api), e.g. https://host */
export const SERVER_ORIGIN = API_BASE_URL.replace(/\/api\/?$/, "");

/** Resolve a stored upload path (e.g. /uploads/...) to an absolute URL. */
export function uploadUrl(path?: string | null): string | null {
  if (!path) return null;
  if (/^(file|content|data|blob):/i.test(path)) return path;
  if (/^https?:\/\//.test(path)) return path;
  return `${SERVER_ORIGIN}${path.startsWith("/") ? "" : "/"}${path}`;
}

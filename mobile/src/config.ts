import Constants from "expo-constants";

type Extra = {
  API_BASE_URL?: string;
  WS_BASE_URL?: string;
};

const extra = (Constants.expoConfig?.extra ?? {}) as Extra;

/** REST API base, e.g. https://workpulse-prod.up.railway.app/api */
export const API_BASE_URL =
  extra.API_BASE_URL ?? "https://workpulse-prod.up.railway.app/api";

/** WebSocket base, e.g. wss://workpulse-prod.up.railway.app */
export const WS_BASE_URL =
  extra.WS_BASE_URL ?? "wss://workpulse-prod.up.railway.app";

/** Full WebSocket endpoint (server listens on /ws). */
export function wsUrl(token: string): string {
  return `${WS_BASE_URL}/ws?token=${encodeURIComponent(token)}`;
}

/** Server origin (without the trailing /api), e.g. https://host */
export const SERVER_ORIGIN = API_BASE_URL.replace(/\/api\/?$/, "");

/** Resolve a stored upload path (e.g. /uploads/...) to an absolute URL. */
export function uploadUrl(path?: string | null): string | null {
  if (!path) return null;
  if (/^https?:\/\//.test(path)) return path;
  return `${SERVER_ORIGIN}${path.startsWith("/") ? "" : "/"}${path}`;
}

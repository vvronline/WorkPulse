import axios, { AxiosError, AxiosInstance } from "axios";
import { API_BASE_URL } from "./config";
import { getToken } from "./auth/tokenStore";

/**
 * Callback invoked when the API returns 401. AuthContext registers this so a
 * stale/expired token forces a sign-out + redirect to the login screen.
 */
let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(fn: (() => void) | null): void {
  onUnauthorized = fn;
}

export const api: AxiosInstance = axios.create({
  baseURL: API_BASE_URL,
  // Tenant DB pools spin up lazily on Railway, so the first write after an idle
  // period can take well over 20s. A too-aggressive timeout aborted the client
  // while the server still committed the row, surfacing false "failed to
  // create" warnings. 60s tolerates cold-start writes without hanging forever.
  timeout: 60000,
});

api.interceptors.request.use(async (config) => {
  const token = await getToken();
  if (token) {
    config.headers.set("Authorization", `Bearer ${token}`);
  }
  // Mirror the web client's contract.
  config.headers.set("X-Requested-With", "WorkPulse");
  config.headers.set("x-timezone-offset", String(new Date().getTimezoneOffset()));
  return config;
});

api.interceptors.response.use(
  (res) => res,
  (error: AxiosError) => {
    if (error.response?.status === 401) {
      onUnauthorized?.();
    }
    return Promise.reject(error);
  },
);

/** Standard backend envelope returned by most endpoints. */
export type ApiEnvelope<T> = {
  data?: T;
  error?: string | null;
  total?: number;
  page?: number;
  perPage?: number;
};

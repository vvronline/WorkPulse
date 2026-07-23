import { api } from "./api";

export type WorkState = "logged_out" | "on_floor" | "on_break";

export type TrackerStatus = {
  state: WorkState;
  floorMinutes: number;
  breakMinutes: number;
  targetMinutes: number;
  dailyTargetMet: boolean;
  isWeekend: boolean;
  workMode: "office" | "remote";
  breakCount?: number;
  autoLoggedOut?: boolean;
};

export function getTrackerStatus() {
  return api.get<TrackerStatus>("/tracker/status");
}

export type ClockInPayload = {
  work_mode?: "office" | "remote" | "hybrid";
  face_descriptor?: number[];
  latitude?: number;
  longitude?: number;
  accuracy?: number;
  wifi_bssid?: string;
  // Device-biometric (fingerprint / OS auth) fallback used when the face scan
  // fails. The server only honours this when the office location/wifi check
  // has ALSO passed - a fingerprint alone cannot clock in remotely.
  fingerprint_verified?: boolean;
};

// Clock-out may carry office-presence proof (location / wifi) because
// verification-enabled orgs restrict clock-out to the office.
export type ClockOutPayload = {
  latitude?: number;
  longitude?: number;
  accuracy?: number;
  wifi_bssid?: string;
  face_descriptor?: number[];
  // Device-biometric (fingerprint / OS auth) fallback used when the face scan
  // fails. The server only honours this when the office location/wifi check
  // has ALSO passed - a fingerprint alone cannot clock out remotely.
  fingerprint_verified?: boolean;
};

export function clockIn(
  workModeOrPayload: "office" | "remote" | ClockInPayload = "office",
) {
  // Back-compat: callers may pass just a work-mode string (verification-off
  // orgs) or a full payload (verification-on orgs).
  const body: ClockInPayload =
    typeof workModeOrPayload === "string"
      ? { work_mode: workModeOrPayload }
      : workModeOrPayload;
  return api.post("/tracker/clock-in", body);
}

export function breakStart() {
  return api.post("/tracker/break-start");
}

export function breakEnd() {
  return api.post("/tracker/break-end");
}

export function clockOut(payload?: ClockOutPayload) {
  return api.post("/tracker/clock-out", payload ?? {});
}

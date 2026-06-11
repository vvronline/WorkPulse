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

export function clockOut() {
  return api.post("/tracker/clock-out");
}

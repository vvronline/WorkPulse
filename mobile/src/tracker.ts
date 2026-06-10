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

export function clockIn(workMode: "office" | "remote" = "office") {
  return api.post("/tracker/clock-in", { work_mode: workMode });
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

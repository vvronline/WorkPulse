/**
 * Shared time computation utilities.
 * Used by tracker.js, manager.js, and any route that needs floor/break time calculations.
 */

import type { TimeEntry, DaySummary, AttendanceState } from "../types/domain";

/**
 * Parse a timestamp (string or Date) into epoch milliseconds.
 */
function tsToMs(timestamp: string | Date): number {
    if (timestamp instanceof Date) return timestamp.getTime();
    const s = String(timestamp).trim();
    // Already has timezone info (Z, +HH:MM, -HH:MM) — parse directly
    if (/[Zz]$/.test(s) || /[+-]\d{2}:\d{2}$/.test(s) || /[+-]\d{4}$/.test(s)) {
        return new Date(s.replace(" ", "T")).getTime();
    }
    // No timezone — assume UTC
    return new Date(s.replace(" ", "T") + "Z").getTime();
}

/**
 * Epoch ms for the end (23:59:59.999) of the local calendar day that the given
 * YYYY-MM-DD string represents, where `offsetMin` is JS `getTimezoneOffset()`
 * (minutes; positive = west of UTC, negative = east — e.g. IST = -330).
 *
 * Used by historical reads to cap an open/unterminated session at the end of
 * its own local day so a never-clocked-out (or wrongly auto-clocked-out)
 * overnight session is still credited for that day instead of counting as 0.
 */
function endOfLocalDayMs(dateStr: string, offsetMin = 0): number {
    const [y, m, d] = dateStr.split("-").map(Number);
    // Local 23:59:59.999 expressed as UTC: subtract the offset (offsetMin is
    // west-positive, so local = UTC - offset → UTC = local + offset).
    return Date.UTC(y, (m || 1) - 1, d || 1, 23, 59, 59, 999) + offsetMin * 60000;
}

/**
 * Compute total floor (work) milliseconds from a sorted array of time entries.
 * @param entries - sorted time entries for a single day
 * @param isLive - if true, count an open (unterminated) session up to `capMs`
 * @param capMs - the timestamp (epoch ms) to count an open session up to when
 *   `isLive` is set. Defaults to `Date.now()`. Historical reads pass the
 *   end-of-local-day boundary (see `endOfLocalDayMs`) so a session that was
 *   never clocked out — or whose nightly auto-clock-out landed in the wrong
 *   day bucket because of a stale timezone offset — is still credited for that
 *   day. Previously such a day silently counted as 0 floor minutes and flipped
 *   to "Absent" even though the live timer showed a full shift.
 * @returns floor milliseconds
 */
function computeFloorMs(entries: TimeEntry[], isLive = false, capMs: number = Date.now()): number {
    let floorMs = 0;
    let clockInTime: number | null = null;
    for (const e of entries) {
        const t = tsToMs(e.timestamp);
        switch (e.entry_type) {
            case "clock_in": clockInTime = t; break;
            case "break_start": if (clockInTime) { floorMs += t - clockInTime; clockInTime = null; } break;
            case "break_end": clockInTime = t; break;
            case "clock_out":
                if (clockInTime) { floorMs += t - clockInTime; clockInTime = null; }
                break;
        }
    }
    // Count a dangling open session up to the cap, but never go backwards if the
    // cap precedes the open clock-in (clock skew / bad offset) — guarded below.
    if (isLive && clockInTime && capMs > clockInTime) floorMs += capMs - clockInTime;
    return Math.max(0, floorMs);
}

/**
 * Compute total break milliseconds from a sorted array of time entries.
 * @param entries - sorted time entries for a single day
 * @param isLive - if true, count an open break up to `capMs`
 * @param capMs - timestamp (epoch ms) to count an open break up to. Defaults to now.
 * @returns break milliseconds
 */
function computeBreakMs(entries: TimeEntry[], isLive = false, capMs: number = Date.now()): number {
    let breakMs = 0;
    let breakStartTime: number | null = null;
    for (const e of entries) {
        const t = tsToMs(e.timestamp);
        switch (e.entry_type) {
            case "break_start": breakStartTime = t; break;
            case "break_end": if (breakStartTime) { breakMs += t - breakStartTime; breakStartTime = null; } break;
            case "clock_out": if (breakStartTime) { breakMs += t - breakStartTime; breakStartTime = null; } break;
        }
    }
    if (isLive && breakStartTime && capMs > breakStartTime) breakMs += capMs - breakStartTime;
    return Math.max(0, breakMs);
}

/**
 * Compute a full day summary from sorted time entries.
 * @param entries - sorted time entries for a single day
 * @param isLive - if true, count an open session up to `capMs`
 * @param capMs - timestamp (epoch ms) to cap an open session at. Defaults to now.
 */
function computeDaySummary(entries: TimeEntry[], isLive = false, capMs: number = Date.now()): DaySummary {
    const floorMs = computeFloorMs(entries, isLive, capMs);
    const breakMs = computeBreakMs(entries, isLive, capMs);
    const clockInEntry = entries.find(e => e.entry_type === "clock_in");
    return {
        floorMinutes: Math.round(floorMs / 60000),
        breakMinutes: Math.round(breakMs / 60000),
        totalMinutes: Math.round((floorMs + breakMs) / 60000),
        workMode: clockInEntry?.work_mode || "office",
        entries,
    };
}

interface StatusResult extends Partial<DaySummary> {
    state: AttendanceState;
    floorMinutes: number;
    breakMinutes: number;
    entries: TimeEntry[];
}

/**
 * Compute the current state from entries.
 * @param entries - sorted time entries for a single day
 */
function computeStatus(entries: TimeEntry[]): StatusResult {
    if (entries.length === 0) {
        return { state: "logged_out", floorMinutes: 0, breakMinutes: 0, entries: [] };
    }
    const last = entries[entries.length - 1];
    let state: AttendanceState = "logged_out";
    if (last.entry_type === "clock_in" || last.entry_type === "break_end") state = "on_floor";
    else if (last.entry_type === "break_start") state = "on_break";
    const summary = computeDaySummary(entries, true);
    return { state, ...summary, entries };
}

export { tsToMs, endOfLocalDayMs, computeFloorMs, computeBreakMs, computeDaySummary, computeStatus };
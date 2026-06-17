"use strict";
/**
 * Shared time computation utilities.
 * Used by tracker.js, manager.js, and any route that needs floor/break time calculations.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.tsToMs = tsToMs;
exports.computeFloorMs = computeFloorMs;
exports.computeBreakMs = computeBreakMs;
exports.computeDaySummary = computeDaySummary;
exports.computeStatus = computeStatus;
/**
 * Parse a timestamp (string or Date) into epoch milliseconds.
 */
function tsToMs(timestamp) {
    if (timestamp instanceof Date)
        return timestamp.getTime();
    const s = String(timestamp).trim();
    // Already has timezone info (Z, +HH:MM, -HH:MM) — parse directly
    if (/[Zz]$/.test(s) || /[+-]\d{2}:\d{2}$/.test(s) || /[+-]\d{4}$/.test(s)) {
        return new Date(s.replace(" ", "T")).getTime();
    }
    // No timezone — assume UTC
    return new Date(s.replace(" ", "T") + "Z").getTime();
}
/**
 * Compute total floor (work) milliseconds from a sorted array of time entries.
 * @param entries - sorted time entries for a single day
 * @param isLive - if true, count up to Date.now() for open sessions
 * @returns floor milliseconds
 */
function computeFloorMs(entries, isLive = false) {
    let floorMs = 0;
    let clockInTime = null;
    for (const e of entries) {
        const t = tsToMs(e.timestamp);
        switch (e.entry_type) {
            case "clock_in":
                clockInTime = t;
                break;
            case "break_start":
                if (clockInTime) {
                    floorMs += t - clockInTime;
                    clockInTime = null;
                }
                break;
            case "break_end":
                clockInTime = t;
                break;
            case "clock_out":
                if (clockInTime) {
                    floorMs += t - clockInTime;
                    clockInTime = null;
                }
                break;
        }
    }
    if (isLive && clockInTime)
        floorMs += Date.now() - clockInTime;
    return Math.max(0, floorMs);
}
/**
 * Compute total break milliseconds from a sorted array of time entries.
 * @param entries - sorted time entries for a single day
 * @param isLive - if true, count up to Date.now() for open breaks
 * @returns break milliseconds
 */
function computeBreakMs(entries, isLive = false) {
    let breakMs = 0;
    let breakStartTime = null;
    for (const e of entries) {
        const t = tsToMs(e.timestamp);
        switch (e.entry_type) {
            case "break_start":
                breakStartTime = t;
                break;
            case "break_end":
                if (breakStartTime) {
                    breakMs += t - breakStartTime;
                    breakStartTime = null;
                }
                break;
            case "clock_out":
                if (breakStartTime) {
                    breakMs += t - breakStartTime;
                    breakStartTime = null;
                }
                break;
        }
    }
    if (isLive && breakStartTime)
        breakMs += Date.now() - breakStartTime;
    return Math.max(0, breakMs);
}
/**
 * Compute a full day summary from sorted time entries.
 * @param entries - sorted time entries for a single day
 * @param isLive - if true, count up to Date.now()
 */
function computeDaySummary(entries, isLive = false) {
    const floorMs = computeFloorMs(entries, isLive);
    const breakMs = computeBreakMs(entries, isLive);
    const clockInEntry = entries.find(e => e.entry_type === "clock_in");
    return {
        floorMinutes: Math.round(floorMs / 60000),
        breakMinutes: Math.round(breakMs / 60000),
        totalMinutes: Math.round((floorMs + breakMs) / 60000),
        workMode: clockInEntry?.work_mode || "office",
        entries,
    };
}
/**
 * Compute the current state from entries.
 * @param entries - sorted time entries for a single day
 */
function computeStatus(entries) {
    if (entries.length === 0) {
        return { state: "logged_out", floorMinutes: 0, breakMinutes: 0, entries: [] };
    }
    const last = entries[entries.length - 1];
    let state = "logged_out";
    if (last.entry_type === "clock_in" || last.entry_type === "break_end")
        state = "on_floor";
    else if (last.entry_type === "break_start")
        state = "on_break";
    const summary = computeDaySummary(entries, true);
    return { state, ...summary, entries };
}
//# sourceMappingURL=timeCalc.js.map
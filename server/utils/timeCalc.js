/**
 * Shared time computation utilities.
 * Used by tracker.js, manager.js, and any route that needs floor/break time calculations.
 */

/**
 * Parse a timestamp string into epoch milliseconds.
 */
function tsToMs(timestamp) {
    return new Date(timestamp.replace(' ', 'T') + 'Z').getTime();
}

/**
 * Compute total floor (work) milliseconds from a sorted array of time entries.
 * @param {Array} entries - sorted time entries for a single day
 * @param {boolean} isLive - if true, count up to Date.now() for open sessions
 * @returns {number} floor milliseconds
 */
function computeFloorMs(entries, isLive = false) {
    let floorMs = 0, clockInTime = null;
    for (const e of entries) {
        const t = tsToMs(e.timestamp);
        switch (e.entry_type) {
            case 'clock_in': clockInTime = t; break;
            case 'break_start': if (clockInTime) { floorMs += t - clockInTime; clockInTime = null; } break;
            case 'break_end': clockInTime = t; break;
            case 'clock_out':
                if (clockInTime) { floorMs += t - clockInTime; clockInTime = null; }
                break;
        }
    }
    if (isLive && clockInTime) floorMs += Date.now() - clockInTime;
    return Math.max(0, floorMs);
}

/**
 * Compute total break milliseconds from a sorted array of time entries.
 * @param {Array} entries - sorted time entries for a single day
 * @param {boolean} isLive - if true, count up to Date.now() for open breaks
 * @returns {number} break milliseconds
 */
function computeBreakMs(entries, isLive = false) {
    let breakMs = 0, breakStartTime = null;
    for (const e of entries) {
        const t = tsToMs(e.timestamp);
        switch (e.entry_type) {
            case 'break_start': breakStartTime = t; break;
            case 'break_end': if (breakStartTime) { breakMs += t - breakStartTime; breakStartTime = null; } break;
            case 'clock_out': if (breakStartTime) { breakMs += t - breakStartTime; breakStartTime = null; } break;
        }
    }
    if (isLive && breakStartTime) breakMs += Date.now() - breakStartTime;
    return Math.max(0, breakMs);
}

/**
 * Compute a full day summary from sorted time entries.
 * @param {Array} entries - sorted time entries for a single day
 * @param {boolean} isLive - if true, count up to Date.now()
 * @returns {{ floorMinutes, breakMinutes, totalMinutes, workMode, entries }}
 */
function computeDaySummary(entries, isLive = false) {
    const floorMs = computeFloorMs(entries, isLive);
    const breakMs = computeBreakMs(entries, isLive);
    const clockInEntry = entries.find(e => e.entry_type === 'clock_in');
    return {
        floorMinutes: Math.round(floorMs / 60000),
        breakMinutes: Math.round(breakMs / 60000),
        totalMinutes: Math.round((floorMs + breakMs) / 60000),
        workMode: clockInEntry?.work_mode || 'office',
        entries
    };
}

/**
 * Compute the current state from entries.
 * @param {Array} entries - sorted time entries for a single day
 * @returns {{ state, ...daySummary }}
 */
function computeStatus(entries) {
    if (entries.length === 0) {
        return { state: 'logged_out', floorMinutes: 0, breakMinutes: 0, entries: [] };
    }
    const last = entries[entries.length - 1];
    let state = 'logged_out';
    if (last.entry_type === 'clock_in' || last.entry_type === 'break_end') state = 'on_floor';
    else if (last.entry_type === 'break_start') state = 'on_break';
    const summary = computeDaySummary(entries, true);
    return { state, ...summary, entries };
}

module.exports = { tsToMs, computeFloorMs, computeBreakMs, computeDaySummary, computeStatus };

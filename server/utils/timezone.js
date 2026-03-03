/**
 * Shared timezone utility helpers for server routes.
 * Extracts the client's timezone offset from the `x-timezone-offset` header
 * (value of Date.getTimezoneOffset() in minutes, e.g. -330 for IST).
 */

// Clamp offset to valid range: UTC-12 (-720) to UTC+14 (+840)
function clampOffset(raw) {
    const n = parseInt(raw);
    if (isNaN(n)) return 0;
    return Math.max(-720, Math.min(840, n));
}

// Get "today" in the client's local timezone as YYYY-MM-DD
function getLocalToday(req) {
    const offsetMin = clampOffset(req.headers['x-timezone-offset']);
    const now = new Date(Date.now() - offsetMin * 60000);
    return now.toISOString().slice(0, 10);
}

// Get "yesterday" in the client's local timezone as YYYY-MM-DD
function getLocalYesterday(req) {
    const offsetMin = clampOffset(req.headers['x-timezone-offset']);
    const now = new Date(Date.now() - offsetMin * 60000 - 86400000);
    return now.toISOString().slice(0, 10);
}

// Get the day-of-week (0=Sun, 6=Sat) in the client's local timezone
function getLocalDow(req) {
    const offsetMin = clampOffset(req.headers['x-timezone-offset']);
    const now = new Date(Date.now() - offsetMin * 60000);
    return now.getUTCDay();
}

// SQLite modifier to convert UTC timestamps to client local time
// e.g. for IST (offset=-330): returns '+330 minutes'
function getTzModifier(req) {
    const offsetMin = clampOffset(req.headers['x-timezone-offset']);
    const shift = -offsetMin;
    return `${shift >= 0 ? '+' : ''}${shift} minutes`;
}

// Convert a UTC timestamp string to local date string using client offset
function getLocalDateFromTs(timestamp, req) {
    const offsetMin = clampOffset(req.headers['x-timezone-offset']);
    const utcMs = new Date(timestamp.replace(' ', 'T') + 'Z').getTime();
    return new Date(utcMs - offsetMin * 60000).toISOString().slice(0, 10);
}

// Convenience: extract and clamp offset from request headers
function getOffsetMin(req) {
    return clampOffset(req.headers['x-timezone-offset']);
}

module.exports = {
    clampOffset,
    getOffsetMin,
    getLocalToday,
    getLocalYesterday,
    getLocalDow,
    getTzModifier,
    getLocalDateFromTs,
};

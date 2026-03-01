/**
 * Shared timezone utility helpers for server routes.
 * Extracts the client's timezone offset from the `x-timezone-offset` header
 * (value of Date.getTimezoneOffset() in minutes, e.g. -330 for IST).
 */

// Get "today" in the client's local timezone as YYYY-MM-DD
function getLocalToday(req) {
    const offsetMin = parseInt(req.headers['x-timezone-offset']);
    if (!isNaN(offsetMin)) {
        const now = new Date(Date.now() - offsetMin * 60000);
        return now.toISOString().slice(0, 10);
    }
    return new Date().toISOString().slice(0, 10);
}

// Get "yesterday" in the client's local timezone as YYYY-MM-DD
function getLocalYesterday(req) {
    const offsetMin = parseInt(req.headers['x-timezone-offset']);
    if (!isNaN(offsetMin)) {
        const now = new Date(Date.now() - offsetMin * 60000 - 86400000);
        return now.toISOString().slice(0, 10);
    }
    return new Date(Date.now() - 86400000).toISOString().slice(0, 10);
}

// Get the day-of-week (0=Sun, 6=Sat) in the client's local timezone
function getLocalDow(req) {
    const offsetMin = parseInt(req.headers['x-timezone-offset']);
    if (!isNaN(offsetMin)) {
        const now = new Date(Date.now() - offsetMin * 60000);
        return now.getUTCDay();
    }
    return new Date().getUTCDay();
}

// SQLite modifier to convert UTC timestamps to client local time
// e.g. for IST (offset=-330): returns '+330 minutes'
function getTzModifier(req) {
    const offsetMin = parseInt(req.headers['x-timezone-offset']);
    if (!isNaN(offsetMin)) {
        const shift = -offsetMin;
        return `${shift >= 0 ? '+' : ''}${shift} minutes`;
    }
    return '+0 minutes';
}

// Convert a UTC timestamp string to local date string using client offset
function getLocalDateFromTs(timestamp, req) {
    const offsetMin = parseInt(req.headers['x-timezone-offset']);
    if (!isNaN(offsetMin)) {
        const utcMs = new Date(timestamp.replace(' ', 'T') + 'Z').getTime();
        return new Date(utcMs - offsetMin * 60000).toISOString().slice(0, 10);
    }
    return timestamp.slice(0, 10);
}

module.exports = {
    getLocalToday,
    getLocalYesterday,
    getLocalDow,
    getTzModifier,
    getLocalDateFromTs,
};

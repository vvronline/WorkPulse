/**
 * Shared timezone utility helpers for server routes.
 * Extracts the client's timezone offset from the `x-timezone-offset` header
 * (value of Date.getTimezoneOffset() in minutes, e.g. -330 for IST).
 */

import type { Request } from "express";
import { logger } from "./logger";

// Clamp offset to valid range.
// JS getTimezoneOffset() returns minutes: positive = west of UTC, negative = east.
// Valid range: UTC-12 (720) to UTC+14 (-840).
function clampOffset(raw: unknown): number | null {
    const n = parseInt(String(raw));
    if (isNaN(n)) {
        logger.warn({ raw }, "Invalid timezone offset received — not a number");
        return 0;
    }
    if (n < -840 || n > 720) {
        logger.warn({ offset: n }, "Timezone offset out of valid range (-840 to 720), rejecting");
        return null;
    }
    return n;
}

// Get "today" in the client's local timezone as YYYY-MM-DD
function getLocalToday(req: Request): string {
    const offsetMin = clampOffset(req.headers["x-timezone-offset"]) ?? 0;
    const now = new Date(Date.now() - offsetMin * 60000);
    return now.toISOString().slice(0, 10);
}

// Get "yesterday" in the client's local timezone as YYYY-MM-DD
function getLocalYesterday(req: Request): string {
    const offsetMin = clampOffset(req.headers["x-timezone-offset"]) ?? 0;
    const now = new Date(Date.now() - offsetMin * 60000 - 86400000);
    return now.toISOString().slice(0, 10);
}

// Get the day-of-week (0=Sun, 6=Sat) in the client's local timezone
function getLocalDow(req: Request): number {
    const offsetMin = clampOffset(req.headers["x-timezone-offset"]) ?? 0;
    const now = new Date(Date.now() - offsetMin * 60000);
    return now.getUTCDay();
}

// PostgreSQL INTERVAL literal (in minutes) used to shift UTC timestamps to
// the client's local time. e.g. for IST (offset=-330) this returns
// "+330 minutes" — added to a `timestamptz` column so that
// `(ts + INTERVAL '+330 minutes')::date` reflects the user's local day.
//
// (Note: the original comment said "SQLite" — that was a leftover from
// before the project migrated to PostgreSQL.)
function getTzModifier(req: Request): string {
    const offsetMin = clampOffset(req.headers["x-timezone-offset"]) ?? 0;
    const shift = -offsetMin;
    return `${shift >= 0 ? "+" : ""}${shift} minutes`;
}

// Convert a UTC timestamp (string or Date) to local date string using client offset
function getLocalDateFromTs(timestamp: string | Date, req: Request): string {
    const offsetMin = clampOffset(req.headers["x-timezone-offset"]) ?? 0;
    const utcMs = timestamp instanceof Date
        ? timestamp.getTime()
        : new Date(timestamp.replace(" ", "T") + (timestamp.endsWith("Z") ? "" : "Z")).getTime();
    return new Date(utcMs - offsetMin * 60000).toISOString().slice(0, 10);
}

// Convenience: extract and clamp offset from request headers
function getOffsetMin(req: Request): number {
    return clampOffset(req.headers["x-timezone-offset"]) ?? 0;
}

export {
    clampOffset,
    getOffsetMin,
    getLocalToday,
    getLocalYesterday,
    getLocalDow,
    getTzModifier,
    getLocalDateFromTs,
};
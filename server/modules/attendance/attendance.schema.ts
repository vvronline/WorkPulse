import { AttendanceError } from "./attendance.types";
import type { CreateOvertimeInput, ManualEntryInput, Theme } from "./attendance.types";

/** Validate the HTTP body before it reaches domain/service code. */
export function parseCreateOvertime(body: unknown): CreateOvertimeInput {
    const value = (body || {}) as Record<string, unknown>;
    const date = value.date;
    const reason = value.reason;
    const hours = typeof value.hours === "number"
        ? value.hours
        : parseFloat(String(value.hours ?? ""));

    if (!date || !value.hours || !reason) {
        throw new AttendanceError("Date, hours, and reason are required");
    }
    if (typeof reason !== "string" || reason.length > 500) {
        throw new AttendanceError("Reason must be 500 characters or less");
    }
    if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        throw new AttendanceError("Invalid date format");
    }
    if (!Number.isFinite(hours) || hours <= 0 || hours > 24) {
        throw new AttendanceError("Hours must be between 0 and 24");
    }
    return { date, hours, reason };
}

export function parseTheme(body: unknown): Theme {
    const theme = (body as { theme?: unknown } | null)?.theme;
    if (theme !== "dark" && theme !== "light") {
        throw new AttendanceError("Invalid theme");
    }
    return theme;
}

export function parseDateParam(value: unknown): string {
    const date = String(value || "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new AttendanceError("Invalid date format");
    return date;
}

function isValidTime(value: unknown): value is string {
    if (typeof value !== "string" || !/^\d{2}:\d{2}$/.test(value)) return false;
    const [hour, minute] = value.split(":").map(Number);
    return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59;
}

/** Shared validation for manual-entry create and edit. */
export function parseManualEntry(
    body: unknown,
    options: { date?: string; today: string; edit?: boolean },
): ManualEntryInput {
    const raw = (body || {}) as Record<string, unknown>;
    const date = options.date || String(raw.date || "");
    const clockIn = raw.clock_in;
    const clockOut = raw.clock_out ? String(raw.clock_out) : null;

    if (!date || !clockIn) throw new AttendanceError("Date and login time are required");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        throw new AttendanceError("Invalid date format. Use YYYY-MM-DD");
    }
    if (date > options.today) {
        throw new AttendanceError(
            options.edit
                ? "Cannot set a manual entry for a future date"
                : "Cannot add a manual entry for a future date",
        );
    }
    if (!isValidTime(clockIn) || (clockOut && !isValidTime(clockOut))) {
        throw new AttendanceError("Invalid time format. Use HH:MM (00:00–23:59)");
    }
    if (clockOut && clockOut <= clockIn) {
        throw new AttendanceError("Logout time must be after login time");
    }

    const timezoneOffset = typeof raw.timezoneOffset === "number" ? raw.timezoneOffset : 0;
    if (timezoneOffset < -840 || timezoneOffset > 720) {
        throw new AttendanceError("Invalid timezone offset");
    }

    const breaks = Array.isArray(raw.breaks) ? raw.breaks.map((item) => ({
        start: String(item?.start || ""),
        end: String(item?.end || ""),
    })).sort((a, b) => a.start.localeCompare(b.start)) : [];
    if (breaks.length > 20) throw new AttendanceError("Maximum 20 breaks allowed per day");

    for (let index = 0; index < breaks.length; index++) {
        const brk = breaks[index];
        if (!isValidTime(brk.start) || !isValidTime(brk.end)) {
            throw new AttendanceError("Each break must have valid start and end times (HH:MM, 00:00–23:59)");
        }
        if (brk.end <= brk.start) throw new AttendanceError("Break end time must be after break start time");
        if (brk.start < clockIn || (clockOut && brk.end > clockOut)) {
            throw new AttendanceError("Break times must be within clock-in and clock-out times");
        }
        if (index < breaks.length - 1 && brk.end > breaks[index + 1].start) {
            throw new AttendanceError("Break times must not overlap");
        }
    }

    if (clockOut) {
        const minutes = (time: string) => {
            const [hour, minute] = time.split(":").map(Number);
            return hour * 60 + minute;
        };
        const breakMinutes = breaks.reduce((sum, brk) => sum + minutes(brk.end) - minutes(brk.start), 0);
        if (breakMinutes >= minutes(clockOut) - minutes(clockIn)) {
            throw new AttendanceError("Total break duration cannot exceed work duration");
        }
    }

    const workMode = ["office", "remote", "hybrid"].includes(String(raw.work_mode))
        ? String(raw.work_mode) as ManualEntryInput["workMode"]
        : "office";
    const offsetMs = timezoneOffset * 60000;
    const toUtc = (time: string) => {
        const [year, month, day] = date.split("-").map(Number);
        const [hour, minute] = time.split(":").map(Number);
        return new Date(Date.UTC(year, month - 1, day, hour, minute, 0) + offsetMs).toISOString();
    };

    return { date, clockIn, clockOut, breaks, timezoneOffset, workMode, toUtc };
}
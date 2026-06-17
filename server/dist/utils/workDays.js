"use strict";
/**
 * Helpers for organisation-configured work days (the inverse of "weekend
 * holidays"). All callers should use these helpers instead of hardcoding
 * "Saturday & Sunday are off" — those days are admin-configurable per org
 * via `organizations.work_days`.
 *
 * Storage format: `work_days` is a comma-separated list of JS day-of-week
 * numbers (the same values JavaScript's `Date#getUTCDay()` / `getDay()`
 * returns): **0=Sunday, 1=Monday, 2=Tuesday, … 6=Saturday**.
 *
 * Default `"1,2,3,4,5"` means Mon–Fri are working days and Sat & Sun are
 * the weekend.
 *
 * NOTE on the format choice: this matches what the rest of the codebase
 * (attendance.js, export.js, the original tracker clock-in handler) was
 * already comparing against `Date#getUTCDay()`. We deliberately keep this
 * convention rather than switching to ISO weekday so legacy rows and
 * existing test fixtures continue to work without a migration.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_WORK_DAYS = void 0;
exports.parseWorkDays = parseWorkDays;
exports.isJsDowWorkDay = isJsDowWorkDay;
exports.isWorkDay = isWorkDay;
const DEFAULT_WORK_DAYS = "1,2,3,4,5";
exports.DEFAULT_WORK_DAYS = DEFAULT_WORK_DAYS;
/**
 * Parse a stored work_days string into a `Set<number>` of JS DOW values
 * (0..6). Falls back to the default Mon–Fri set when the input is missing
 * or malformed so callers never have to defend against bad rows.
 */
function parseWorkDays(value) {
    const raw = (value && typeof value === "string") ? value : DEFAULT_WORK_DAYS;
    const nums = raw.split(",")
        .map(s => parseInt(s.trim(), 10))
        .filter(n => Number.isInteger(n) && n >= 0 && n <= 6);
    return new Set(nums.length > 0 ? nums : [1, 2, 3, 4, 5]);
}
/**
 * Is a JS DOW value (0=Sun..6=Sat) a working day for this org?
 */
function isJsDowWorkDay(jsDow, workDaysSetOrValue) {
    const set = workDaysSetOrValue instanceof Set
        ? workDaysSetOrValue
        : parseWorkDays(workDaysSetOrValue);
    return set.has(jsDow);
}
/**
 * Is a Date instance on a working day for this org?
 */
function isWorkDay(date, workDaysSetOrValue) {
    return isJsDowWorkDay(date.getUTCDay(), workDaysSetOrValue);
}
//# sourceMappingURL=workDays.js.map
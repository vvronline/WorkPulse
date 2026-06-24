import { computeFloorMs, endOfLocalDayMs } from "./timeCalc";
import type { TimeEntry } from "../types/domain";

interface DbLike {
    query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>;
}

interface LeaveRow {
    date: string;
    leave_type: string;
    duration: "full" | "half" | "quarter";
}

interface AttendanceResult {
    scheduledDays: number;
    daysWorked: number;
    daysAbsent: number;
    leaveDays: number;
    totalHours: number;
    regularHours: number;
    overtimeHours: number;
    workHoursPerDay: number;
}

async function calculateAttendance(
    db: DbLike,
    userId: number,
    orgId: number,
    startDate: string,
    endDate: string,
    timezoneOffset = 0,
): Promise<AttendanceResult> {
    const orgRow = (await db.query(
        `SELECT work_days, work_hours_per_day, min_hours_present FROM organizations WHERE id = $1`,
        [orgId]
    )).rows[0] || {};
    const workDaySet = new Set<number>(
        (orgRow.work_days || "1,2,3,4,5")
            .split(",").map((n: string) => parseInt(n.trim(), 10)).filter((n: number) => !isNaN(n))
    );
    const workHpd = orgRow.work_hours_per_day || 8;
    const minHoursPresent = (orgRow.min_hours_present != null && Number(orgRow.min_hours_present) >= 0)
        ? Number(orgRow.min_hours_present)
        : workHpd / 2;

    const holidaySet = new Set<string>(
        (await db.query(
            `SELECT date FROM holidays
             WHERE org_id = $1 AND date BETWEEN $2 AND $3 AND is_optional = FALSE`,
            [orgId, startDate, endDate]
        )).rows.map((h: { date: string }) => h.date)
    );

    const memberInterval = `${-timezoneOffset} minutes`;

    const entries = (await db.query(
        // Count live clock-ins (approval_status NULL) always; count manual
        // entries only once approved. Filtering on `approval_status = 'approved'`
        // alone silently drops every normal in-app clock-in (which is NULL),
        // making fully-worked days show up as Absent.
        `SELECT * FROM time_entries
         WHERE user_id = $1
           AND (is_manual = FALSE OR approval_status = 'approved')
           AND (timestamp + $4::interval)::date BETWEEN $2::date AND $3::date
         ORDER BY timestamp ASC`,
        [userId, startDate, endDate, memberInterval]
    )).rows as TimeEntry[];

    const byDate: Record<string, TimeEntry[]> = {};
    for (const e of entries) {
        const localDate = new Date(new Date(e.timestamp).getTime() - timezoneOffset * 60000)
            .toISOString().slice(0, 10);
        (byDate[localDate] ??= []).push(e);
    }

    const leaveMap: Record<string, LeaveRow> = {};
    for (const l of (await db.query(
        `SELECT date, leave_type, duration FROM leaves
         WHERE user_id = $1 AND status = 'approved' AND date BETWEEN $2 AND $3`,
        [userId, startDate, endDate]
    )).rows as LeaveRow[]) {
        leaveMap[l.date] = l;
    }

    const allDays: string[] = [];
    const dt = new Date(startDate + "T00:00:00Z");
    const dtEnd = new Date(endDate + "T00:00:00Z");
    while (dt <= dtEnd) {
        allDays.push(dt.toISOString().slice(0, 10));
        dt.setUTCDate(dt.getUTCDate() + 1);
    }

    let scheduledDays = 0, daysWorked = 0;
    let totalLeaveDays = 0, leaveEquivForAbsent = 0;
    let totalHours = 0, regularHours = 0, overtimeHours = 0;
    const minPresentMs = minHoursPresent * 3_600_000;

    // Today (in the member's local timezone) — an open session for *today* must
    // be capped at "now", not end-of-day, so today's in-progress hours aren't
    // over-counted. Past days cap an unterminated session at end-of-local-day.
    const nowMs = Date.now();
    const todayLocal = new Date(nowMs - timezoneOffset * 60000).toISOString().slice(0, 10);

    for (const date of allDays) {
        const dow = new Date(date + "T00:00:00Z").getUTCDay();
        const isWorkDay = workDaySet.has(dow);
        const isHoliday = holidaySet.has(date);
        const leave = leaveMap[date];
        const dayEntries = byDate[date] || [];
        const hasWork = dayEntries.length > 0;
        // Credit an unterminated session (never clocked out, or whose nightly
        // auto-clock-out landed in the wrong day bucket because of a stale
        // timezone offset) by capping it at the end of its own local day —
        // or at "now" for today. Without this, a fully-worked overnight shift
        // counted as 0 floor minutes and was wrongly marked Absent.
        const capMs = date >= todayLocal ? nowMs : endOfLocalDayMs(date, timezoneOffset);
        const floorMs = hasWork ? computeFloorMs(dayEntries, true, capMs) : 0;
        const meetsMinHours = floorMs >= minPresentMs;

        if (!isWorkDay) {
            if (!hasWork) continue;
        } else if (isHoliday) {
            if (!hasWork) continue;
        } else {
            scheduledDays++;
            if (meetsMinHours) daysWorked++;

            if (leave) {
                const durFrac = leave.duration === "quarter" ? 0.25
                    : leave.duration === "half" ? 0.5 : 1;
                totalLeaveDays += durFrac;
                if (leave.duration === "full") {
                    leaveEquivForAbsent += 1;
                } else if (!meetsMinHours) {
                    leaveEquivForAbsent += durFrac;
                }
            }
        }

        if (hasWork) {
            const dayTotal = floorMs / 3_600_000;
            if (!isWorkDay || isHoliday) {
                overtimeHours += dayTotal;
            } else {
                regularHours += Math.min(dayTotal, workHpd);
                overtimeHours += Math.max(0, dayTotal - workHpd);
            }
            totalHours += dayTotal;
        }
    }

    const daysAbsent = Math.max(0, scheduledDays - daysWorked - leaveEquivForAbsent);

    return {
        scheduledDays,
        daysWorked,
        daysAbsent: parseFloat(daysAbsent.toFixed(2)),
        leaveDays: parseFloat(totalLeaveDays.toFixed(2)),
        totalHours: parseFloat(totalHours.toFixed(2)),
        regularHours: parseFloat(regularHours.toFixed(2)),
        overtimeHours: parseFloat(overtimeHours.toFixed(2)),
        workHoursPerDay: workHpd,
    };
}

export { calculateAttendance };
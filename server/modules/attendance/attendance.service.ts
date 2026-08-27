/** Attendance business rules and orchestration. */
import type {
    AttendanceActor,
    AttendanceDb,
    CreateOvertimeInput,
    Theme,
} from "./attendance.types";
import { AttendanceError } from "./attendance.types";
import * as repository from "./attendance.repository";
import { computeDaySummary, endOfLocalDayMs } from "../../utils/timeCalc";
import { computeStatus } from "../../utils/timeCalc";
import { parseWorkDays, isJsDowWorkDay } from "../../utils/workDays";

interface AttendanceDependencies {
    findApprover: (
        db: AttendanceDb,
        userId: number,
        orgId: number | null,
    ) => Promise<{ id: number } | null>;
    sendToUser: (
        tenantId: number | null | undefined,
        userId: number,
        type: string,
        data: unknown,
    ) => void;
}

export function createAttendanceService(deps: AttendanceDependencies) {
    return {
        async createOvertimeRequest(
            db: AttendanceDb,
            actor: AttendanceActor,
            input: CreateOvertimeInput,
        ): Promise<{ approverId: number | null }> {
            if (await repository.hasPendingOvertime(db, actor.userId, input.date)) {
                throw new AttendanceError("You already have a pending overtime request for this date");
            }

            const approver = await deps.findApprover(db, actor.userId, actor.orgId);
            const approverId = approver?.id || null;
            await repository.insertOvertimeRequest(db, actor, approverId, input);

            // Notification delivery is best-effort: the approval request is the
            // source of truth and must survive an email/WS notification failure.
            if (approverId) {
                try {
                    const requesterName = await repository.getUserDisplayName(db, actor.userId);
                    await repository.insertOvertimeNotification(db, approverId, requesterName, input);
                    deps.sendToUser(actor.tenantId, approverId, "approval_update", {
                        type: "overtime",
                        status: "pending",
                    });
                } catch {
                    // Route logger records best-effort notification failures in
                    // the current compatibility wrapper if needed.
                }
            }
            return { approverId };
        },

        async listOvertimeRequests(db: AttendanceDb, userId: number): Promise<any[]> {
            const rows = await repository.listOvertimeRequests(db, userId);
            return rows.map((row: { metadata: string | object | null; [key: string]: unknown }) => {
                let metadata: object | null = null;
                if (typeof row.metadata === "string") {
                    try { metadata = JSON.parse(row.metadata); } catch { metadata = {}; }
                } else if (row.metadata && typeof row.metadata === "object") {
                    metadata = row.metadata;
                }
                return { ...row, metadata };
            });
        },

        getTheme(db: AttendanceDb, userId: number): Promise<Theme> {
            return repository.getUserTheme(db, userId);
        },

        async updateTheme(
            db: AttendanceDb,
            actor: Pick<AttendanceActor, "userId" | "tenantId">,
            theme: Theme,
        ): Promise<void> {
            await repository.updateUserTheme(db, actor.userId, theme);
            try {
                deps.sendToUser(actor.tenantId, actor.userId, "theme_changed", { theme });
            } catch {
                // WS is best-effort; the persisted theme remains authoritative.
            }
        },

        async getWeeklySummary(
            db: AttendanceDb,
            userId: number,
            timezoneOffset: number,
            nowMs = Date.now(),
        ) {
            const now = new Date(nowMs - timezoneOffset * 60000);
            const today = now.toISOString().slice(0, 10);
            const monday = new Date(now);
            monday.setUTCDate(now.getUTCDate() - ((now.getUTCDay() + 6) % 7));
            const sunday = new Date(monday);
            sunday.setUTCDate(monday.getUTCDate() + 6);
            const from = monday.toISOString().slice(0, 10);
            const to = sunday.toISOString().slice(0, 10);
            const interval = `${-timezoneOffset} minutes`;
            const entries = await repository.listTimeEntriesForDateRange(db, userId, from, to, interval);

            const grouped: Record<string, any[]> = {};
            for (const entry of entries) {
                const date = new Date(new Date(entry.timestamp).getTime() - timezoneOffset * 60000)
                    .toISOString().slice(0, 10);
                (grouped[date] ??= []).push(entry);
            }

            const days = Array.from({ length: 7 }, (_, index) => {
                const date = new Date(monday);
                date.setUTCDate(monday.getUTCDate() + index);
                const dateStr = date.toISOString().slice(0, 10);
                const dayEntries = grouped[dateStr] || [];
                const capMs = dateStr >= today ? nowMs : endOfLocalDayMs(dateStr, timezoneOffset);
                const summary = dayEntries.length
                    ? computeDaySummary(dayEntries, true, capMs)
                    : { floorMinutes: 0 };
                return {
                    date: dateStr,
                    day: date.toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" }),
                    hours: Math.round(summary.floorMinutes / 6) / 10,
                    isToday: dateStr === today,
                };
            });
            return { days };
        },

        async getTaskSummary(db: AttendanceDb, userId: number, date: string) {
            const tasks = await repository.listTasksForDate(db, userId, date);
            const count = (status: string) => tasks.filter((task) => task.status === status).length;
            return {
                total: tasks.length,
                done: count("done"),
                pending: count("pending"),
                inProgress: count("in_progress"),
                inReview: count("in_review"),
                activeTasks: tasks
                    .filter((task) => ["in_progress", "in_review", "pending"].includes(task.status))
                    .map((task) => ({ title: task.title, priority: task.priority, status: task.status })),
            };
        },

        async getHistory(
            db: AttendanceDb,
            userId: number,
            fromDate: string,
            toDate: string,
            timezoneOffset: number,
            nowMs = Date.now(),
        ) {
            const entries = await repository.listTimeEntriesForDateRange(
                db, userId, fromDate, toDate, `${-timezoneOffset} minutes`, true,
            );
            const grouped = groupEntriesByLocalDate(entries, timezoneOffset);
            const today = new Date(nowMs - timezoneOffset * 60000).toISOString().slice(0, 10);
            return Object.keys(grouped).sort().map((date) => ({
                date,
                ...computeDaySummary(
                    grouped[date],
                    true,
                    date >= today ? nowMs : endOfLocalDayMs(date, timezoneOffset),
                ),
            }));
        },

        async getAnalytics(
            db: AttendanceDb,
            userId: number,
            fromDate: string,
            toDate: string,
            numDays: number,
            timezoneOffset: number,
            nowMs = Date.now(),
        ) {
            const entries = await repository.listTimeEntriesForDateRange(
                db, userId, fromDate, toDate, `${-timezoneOffset} minutes`, true,
            );
            const grouped = groupEntriesByLocalDate(entries, timezoneOffset);
            const today = new Date(nowMs - timezoneOffset * 60000).toISOString().slice(0, 10);
            const startMs = new Date(`${fromDate}T00:00:00Z`).getTime();
            return Array.from({ length: numDays }, (_, index) => {
                const date = new Date(startMs + index * 86400000).toISOString().slice(0, 10);
                return {
                    date,
                    ...computeDaySummary(
                        grouped[date] || [],
                        true,
                        date >= today ? nowMs : endOfLocalDayMs(date, timezoneOffset),
                    ),
                };
            });
        },

        async getStatus(
            db: AttendanceDb,
            userId: number,
            today: string,
            dayOfWeek: number,
            timezoneOffset: number,
        ) {
            const interval = `${-timezoneOffset} minutes`;
            const orgId = await repository.getUserOrgId(db, userId);
            const config = await repository.getOrgWorkConfig(db, orgId);
            const targetMinutes = (config.work_hours_per_day || 8) * 60;
            let entries = await repository.listEntriesForLocalDay(db, userId, today, interval);
            const status = computeStatus(entries);
            let autoLoggedOut = false;
            const last = entries.at(-1);
            if (last && !last.is_manual && status.state !== "logged_out"
                && status.floorMinutes >= targetMinutes) {
                autoLoggedOut = await repository.autoClockOutIfOpen(db, userId, today, interval);
                if (autoLoggedOut) {
                    entries = await repository.listEntriesForLocalDay(db, userId, today, interval);
                    Object.assign(status, computeStatus(entries));
                }
            }
            const latestClockIn = [...entries].reverse().find((entry) => entry.entry_type === "clock_in");
            return {
                ...status,
                isWeekend: !isJsDowWorkDay(dayOfWeek, config.work_days),
                workMode: latestClockIn?.work_mode || "office",
                targetMinutes,
                dailyTargetMet: status.floorMinutes >= targetMinutes,
                autoLoggedOut,
            };
        },

        async getWidgets(
            db: AttendanceDb,
            userId: number,
            today: string,
            timezoneOffset: number,
            nowMs = Date.now(),
        ) {
            const entries = await repository.listRecentEntries(
                db, userId, today, `${-timezoneOffset} minutes`,
            );
            const grouped = groupEntriesByLocalDate(entries, timezoneOffset);
            const leaveDates = new Set(await repository.listApprovedLeaveDates(db, userId, today));
            const orgId = await repository.getUserOrgId(db, userId);
            const config = await repository.getOrgWorkConfig(db, orgId);
            const monthStart = `${today.slice(0, 7)}-01`;
            const target = (config.work_hours_per_day || 8) * 60;
            const minPresent = Number(config.min_hours_present ?? (config.work_hours_per_day || 8) / 2) * 60;
            let totalFloorMin = 0, workDays = 0, targetMetDays = 0, officeDays = 0, remoteDays = 0;
            const floorByDate: Record<string, number> = {};
            let earlyDays = 0;

            for (const [date, dayEntries] of Object.entries(grouped)) {
                if (!dayEntries.some((entry) => entry.entry_type === "clock_in")) continue;
                workDays++;
                const summary = computeDaySummary(
                    dayEntries, true,
                    date >= today ? nowMs : endOfLocalDayMs(date, timezoneOffset),
                );
                floorByDate[date] = summary.floorMinutes;
                totalFloorMin += summary.floorMinutes;
                if (summary.floorMinutes >= target) targetMetDays++;
                if (summary.workMode === "remote") remoteDays++; else officeDays++;
                const firstClockIn = dayEntries.find((entry) => entry.entry_type === "clock_in");
                if (firstClockIn) {
                    const local = new Date(new Date(firstClockIn.timestamp).getTime() - timezoneOffset * 60000);
                    if (local.getUTCHours() < 10
                        || (local.getUTCHours() === 10 && local.getUTCMinutes() === 0)) earlyDays++;
                }
            }

            const workDaySet = parseWorkDays(config.work_days || null);
            let monthPresentDays = 0, totalWeekdays = 0;
            for (let day = new Date(`${monthStart}T00:00:00Z`);
                day <= new Date(`${today}T00:00:00Z`); day.setUTCDate(day.getUTCDate() + 1)) {
                const date = day.toISOString().slice(0, 10);
                if (!isJsDowWorkDay(day.getUTCDay(), workDaySet)) continue;
                totalWeekdays++;
                if ((floorByDate[date] || 0) >= minPresent) monthPresentDays++;
            }
            const leaveCount = [...leaveDates].filter((date) => date >= monthStart).length;
            return {
                avgFloorMinutes: workDays ? Math.round(totalFloorMin / workDays) : 0,
                punctualityPercent: workDays ? Math.round((earlyDays / workDays) * 100) : 0,
                attendancePercent: totalWeekdays
                    ? Math.min(100, Math.round(((monthPresentDays + leaveCount) / totalWeekdays) * 100))
                    : 0,
                targetMetDays, workDays, totalWeekdays, leaveCount, officeDays, remoteDays,
            };
        },

        async startBreak(
            db: AttendanceDb,
            userId: number,
            today: string,
            timezoneOffset: number,
        ): Promise<void> {
            const result = await repository.appendBreakTransition(
                db, userId, today, `${-timezoneOffset} minutes`, "break_start",
            );
            if (result.error) throw new AttendanceError(result.error);
        },

        async endBreak(
            db: AttendanceDb,
            userId: number,
            today: string,
            timezoneOffset: number,
        ): Promise<void> {
            const result = await repository.appendBreakTransition(
                db, userId, today, `${-timezoneOffset} minutes`, "break_end",
            );
            if (result.error) throw new AttendanceError(result.error);
        },

        async listManualEntries(db: AttendanceDb, userId: number) {
            const rows = await repository.listManualEntryRequests(db, userId);
            return rows.map((row: { metadata: string | object | null; [key: string]: unknown }) => {
                if (typeof row.metadata !== "string") return row;
                try { return { ...row, metadata: JSON.parse(row.metadata) }; }
                catch { return { ...row, metadata: null }; }
            });
        },

        getEntriesForDate(
            db: AttendanceDb,
            userId: number,
            date: string,
            timezoneOffset: number,
        ) {
            return repository.listEntriesForDate(db, userId, date, `${-timezoneOffset} minutes`);
        },

        async deleteEntriesForDate(
            db: AttendanceDb,
            actor: Pick<AttendanceActor, "userId" | "orgId">,
            date: string,
            timezoneOffset: number,
        ): Promise<number> {
            if (actor.orgId) {
                const locked = await repository.findLockedPayPeriod(db, actor.orgId, date);
                if (locked) {
                    throw new AttendanceError(
                        `This date is in a locked pay period (${locked.label}). Time entries cannot be deleted.`,
                    );
                }
            }
            const modifier = `${-timezoneOffset} minutes`;
            if (await repository.hasProtectedEntries(db, actor.userId, date, modifier)) {
                throw new AttendanceError(
                    "Cannot delete entries that are pending approval or already approved. Contact your manager.",
                    403,
                );
            }
            return repository.deleteEntriesForDate(db, actor.userId, date, modifier);
        },
    };
}

function groupEntriesByLocalDate(entries: any[], timezoneOffset: number): Record<string, any[]> {
    const grouped: Record<string, any[]> = {};
    for (const entry of entries) {
        const raw = entry.timestamp instanceof Date
            ? entry.timestamp.getTime()
            : new Date(String(entry.timestamp).replace(" ", "T")
                + (String(entry.timestamp).endsWith("Z") ? "" : "Z")).getTime();
        const date = new Date(raw - timezoneOffset * 60000).toISOString().slice(0, 10);
        (grouped[date] ??= []).push(entry);
    }
    return grouped;
}

export type AttendanceService = ReturnType<typeof createAttendanceService>;
import { createAttendanceService } from "../attendance.service";
import { AttendanceError } from "../attendance.types";
import { parseCreateOvertime, parseTheme, parseManualEntry } from "../attendance.schema";

function makeDb(rows: any[] = [], rowCount = rows.length) {
    return {
        query: jest.fn(async (_sql: string, _params?: unknown[]) => ({ rows, rowCount })),
        transaction: undefined as undefined | jest.Mock,
    };
}

describe("attendance schema", () => {
    it("parses a valid overtime request", () => {
        expect(parseCreateOvertime({ date: "2026-08-21", hours: "2.5", reason: "Release" }))
            .toEqual({ date: "2026-08-21", hours: 2.5, reason: "Release" });
    });

    it.each([
        [{}, /required/],
        [{ date: "bad", hours: 1, reason: "x" }, /date format/],
        [{ date: "2026-08-21", hours: 25, reason: "x" }, /between 0 and 24/],
    ])("rejects invalid overtime input", (body, error) => {
        expect(() => parseCreateOvertime(body)).toThrow(error);
    });

    it("accepts only dark/light themes", () => {
        expect(parseTheme({ theme: "light" })).toBe("light");
        expect(() => parseTheme({ theme: "blue" })).toThrow("Invalid theme");
    });

    it("normalizes manual entries and converts local time to UTC", () => {
        const value = parseManualEntry({
            date: "2026-08-21",
            clock_in: "09:00",
            clock_out: "17:00",
            breaks: [{ start: "13:00", end: "13:30" }, { start: "11:00", end: "11:15" }],
            timezoneOffset: -330,
            work_mode: "remote",
        }, { today: "2026-08-21" });
        expect(value.breaks.map((b) => b.start)).toEqual(["11:00", "13:00"]);
        expect(value.workMode).toBe("remote");
        expect(value.toUtc("09:00")).toBe("2026-08-21T03:30:00.000Z");
    });

    it("rejects overlapping manual breaks", () => {
        expect(() => parseManualEntry({
            date: "2026-08-21", clock_in: "09:00", clock_out: "17:00",
            breaks: [{ start: "10:00", end: "11:30" }, { start: "11:00", end: "12:00" }],
        }, { today: "2026-08-21" })).toThrow("must not overlap");
    });

    it("uses the edit-specific future-date error", () => {
        expect(() => parseManualEntry({ clock_in: "09:00" }, {
            date: "2026-08-22", today: "2026-08-21", edit: true,
        })).toThrow("Cannot set a manual entry for a future date");
    });
});

describe("attendance service", () => {
    it("rejects duplicate pending overtime", async () => {
        const db = makeDb([{ id: 1 }], 1);
        const service = createAttendanceService({ findApprover: jest.fn(), sendToUser: jest.fn() });
        await expect(service.createOvertimeRequest(db as any, {
            userId: 1, orgId: 2, tenantId: 3,
        }, { date: "2026-08-21", hours: 2, reason: "x" }))
            .rejects.toBeInstanceOf(AttendanceError);
    });

    it("persists and notifies an approver", async () => {
        const db = makeDb();
        db.query
            .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // duplicate probe
            .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // insert request
            .mockResolvedValueOnce({ rows: [{ full_name: "Alice" }], rowCount: 1 })
            .mockResolvedValueOnce({ rows: [], rowCount: 1 }); // notification
        const sendToUser = jest.fn();
        const service = createAttendanceService({
            findApprover: jest.fn(async () => ({ id: 9 })),
            sendToUser,
        });

        await service.createOvertimeRequest(db as any, {
            userId: 1, orgId: 2, tenantId: 3,
        }, { date: "2026-08-21", hours: 2, reason: "Release" });

        expect(sendToUser).toHaveBeenCalledWith(3, 9, "approval_update", {
            type: "overtime", status: "pending",
        });
        expect(db.query.mock.calls.some((call) => /INSERT INTO approval_requests/.test(call[0]))).toBe(true);
    });

    it("updates theme then broadcasts", async () => {
        const db = makeDb();
        const sendToUser = jest.fn();
        const service = createAttendanceService({ findApprover: jest.fn(), sendToUser });
        await service.updateTheme(db as any, { userId: 1, tenantId: 3 }, "dark");
        expect(db.query).toHaveBeenCalledWith("UPDATE users SET theme = $1 WHERE id = $2", ["dark", 1]);
        expect(sendToUser).toHaveBeenCalledWith(3, 1, "theme_changed", { theme: "dark" });
    });

    it("summarises tasks by status", async () => {
        const db = makeDb([
            { title: "A", status: "done", priority: "high" },
            { title: "B", status: "pending", priority: "low" },
            { title: "C", status: "in_progress", priority: "medium" },
        ]);
        const service = createAttendanceService({ findApprover: jest.fn(), sendToUser: jest.fn() });
        const result = await service.getTaskSummary(db as any, 1, "2026-08-21");
        expect(result).toMatchObject({ total: 3, done: 1, pending: 1, inProgress: 1, inReview: 0 });
        expect(result.activeTasks).toHaveLength(2);
    });

    it("builds seven weekly buckets and counts an open current-day session", async () => {
        const now = Date.UTC(2026, 7, 19, 12, 0, 0); // Wednesday
        const db = makeDb([
            { entry_type: "clock_in", timestamp: "2026-08-19T08:00:00Z", work_mode: "office" },
        ]);
        const service = createAttendanceService({ findApprover: jest.fn(), sendToUser: jest.fn() });
        const result = await service.getWeeklySummary(db as any, 1, 0, now);
        expect(result.days).toHaveLength(7);
        expect(result.days.find((day) => day.isToday)?.hours).toBe(4);
    });

    it("groups history by local date and omits empty days", async () => {
        const now = Date.UTC(2026, 7, 21, 12, 0, 0);
        const db = makeDb([
            { entry_type: "clock_in", timestamp: "2026-08-20T09:00:00Z" },
            { entry_type: "clock_out", timestamp: "2026-08-20T17:00:00Z" },
        ]);
        const service = createAttendanceService({ findApprover: jest.fn(), sendToUser: jest.fn() });
        const result = await service.getHistory(db as any, 1, "2026-08-01", "2026-08-21", 0, now);
        expect(result).toHaveLength(1);
        expect(result[0]).toMatchObject({ date: "2026-08-20", floorMinutes: 480 });
        expect(db.query.mock.calls[0][0]).toMatch(/approval_status.*rejected/s);
    });

    it("analytics fills empty days in the requested range", async () => {
        const db = makeDb([]);
        const service = createAttendanceService({ findApprover: jest.fn(), sendToUser: jest.fn() });
        const result = await service.getAnalytics(
            db as any, 1, "2026-08-18", "2026-08-20", 3, 0,
            Date.UTC(2026, 7, 21, 12),
        );
        expect(result.map((day) => day.date)).toEqual([
            "2026-08-18", "2026-08-19", "2026-08-20",
        ]);
        expect(result.every((day) => day.floorMinutes === 0)).toBe(true);
    });

    it("auto-closes an open status session after the daily target", async () => {
        const db = makeDb();
        db.query
            .mockResolvedValueOnce({ rows: [{ org_id: 2 }], rowCount: 1 })
            .mockResolvedValueOnce({ rows: [{ work_hours_per_day: 4, work_days: "1,2,3,4,5" }], rowCount: 1 })
            .mockResolvedValueOnce({ rows: [
                { entry_type: "clock_in", timestamp: "2026-08-21T08:00:00Z", work_mode: "remote" },
                { entry_type: "break_start", timestamp: "2026-08-21T10:00:00Z" },
                { entry_type: "break_end", timestamp: "2026-08-21T10:30:00Z" },
                { entry_type: "clock_out", timestamp: "2026-08-21T12:30:00Z" },
                { entry_type: "clock_in", timestamp: "2026-08-21T13:00:00Z", work_mode: "office" },
            ], rowCount: 5 })
            .mockResolvedValueOnce({ rows: [
                { entry_type: "clock_in", timestamp: "2026-08-21T08:00:00Z", work_mode: "remote" },
                { entry_type: "clock_out", timestamp: "2026-08-21T12:30:00Z" },
            ], rowCount: 2 });
        db.transaction = jest.fn(async (fn: any) => fn({
            query: jest.fn()
                .mockResolvedValueOnce({ rows: [{ entry_type: "clock_in" }], rowCount: 1 })
                .mockResolvedValueOnce({ rows: [], rowCount: 1 }),
        }));
        const service = createAttendanceService({ findApprover: jest.fn(), sendToUser: jest.fn() });
        const status = await service.getStatus(db as any, 1, "2026-08-21", 5, 0);
        expect(status.autoLoggedOut).toBe(true);
        expect(db.transaction).toHaveBeenCalled();
    });

    it("computes widgets from entries, leave dates and org targets", async () => {
        const db = makeDb();
        db.query
            .mockResolvedValueOnce({ rows: [
                { entry_type: "clock_in", timestamp: "2026-08-03T09:00:00Z", work_mode: "office" },
                { entry_type: "clock_out", timestamp: "2026-08-03T17:00:00Z" },
            ], rowCount: 2 })
            .mockResolvedValueOnce({ rows: [{ date: "2026-08-04" }], rowCount: 1 })
            .mockResolvedValueOnce({ rows: [{ org_id: 2 }], rowCount: 1 })
            .mockResolvedValueOnce({ rows: [{ work_hours_per_day: 8, work_days: "1,2,3,4,5" }], rowCount: 1 });
        const service = createAttendanceService({ findApprover: jest.fn(), sendToUser: jest.fn() });
        const widgets = await service.getWidgets(db as any, 1, "2026-08-05", 0, Date.UTC(2026, 7, 5, 12));
        expect(widgets).toMatchObject({
            avgFloorMinutes: 480,
            targetMetDays: 1,
            workDays: 1,
            leaveCount: 1,
            officeDays: 1,
            remoteDays: 0,
        });
    });

    it("starts a break atomically when the user is on the floor", async () => {
        const client = {
            query: jest.fn()
                .mockResolvedValueOnce({ rows: [{ entry_type: "clock_in" }], rowCount: 1 })
                .mockResolvedValueOnce({ rows: [], rowCount: 1 }),
        };
        const db = makeDb();
        db.transaction = jest.fn(async (fn: any) => fn(client));
        const service = createAttendanceService({ findApprover: jest.fn(), sendToUser: jest.fn() });
        await expect(service.startBreak(db as any, 1, "2026-08-21", 0)).resolves.toBeUndefined();
        expect(client.query.mock.calls[1][1]).toEqual([1, "break_start"]);
    });

    it("rejects break end unless the latest event is break_start", async () => {
        const client = {
            query: jest.fn().mockResolvedValueOnce({
                rows: [{ entry_type: "clock_in" }], rowCount: 1,
            }),
        };
        const db = makeDb();
        db.transaction = jest.fn(async (fn: any) => fn(client));
        const service = createAttendanceService({ findApprover: jest.fn(), sendToUser: jest.fn() });
        await expect(service.endBreak(db as any, 1, "2026-08-21", 0))
            .rejects.toThrow("You are not on break");
    });

    it("parses manual-entry request metadata", async () => {
        const db = makeDb([{ request_id: 1, metadata: '{"date":"2026-08-21"}' }]);
        const service = createAttendanceService({ findApprover: jest.fn(), sendToUser: jest.fn() });
        const rows = await service.listManualEntries(db as any, 1);
        expect(rows[0].metadata).toEqual({ date: "2026-08-21" });
    });

    it("blocks deleting a locked pay-period date", async () => {
        const db = makeDb([{ label: "August payroll" }], 1);
        const service = createAttendanceService({ findApprover: jest.fn(), sendToUser: jest.fn() });
        await expect(service.deleteEntriesForDate(
            db as any, { userId: 1, orgId: 2 }, "2026-08-21", 0,
        )).rejects.toThrow("locked pay period");
    });

    it("blocks deleting pending or approved entries", async () => {
        const db = makeDb([], 0);
        db.query
            .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // no locked period
            .mockResolvedValueOnce({ rows: [{ "?column?": 1 }], rowCount: 1 });
        const service = createAttendanceService({ findApprover: jest.fn(), sendToUser: jest.fn() });
        await expect(service.deleteEntriesForDate(
            db as any, { userId: 1, orgId: 2 }, "2026-08-21", 0,
        )).rejects.toMatchObject({ statusCode: 403 });
    });

    it("deletes unprotected entries and returns the count", async () => {
        const db = makeDb([], 0);
        db.query
            .mockResolvedValueOnce({ rows: [], rowCount: 0 })
            .mockResolvedValueOnce({ rows: [], rowCount: 0 })
            .mockResolvedValueOnce({ rows: [], rowCount: 3 });
        const service = createAttendanceService({ findApprover: jest.fn(), sendToUser: jest.fn() });
        expect(await service.deleteEntriesForDate(
            db as any, { userId: 1, orgId: 2 }, "2026-08-21", 0,
        )).toBe(3);
    });
});
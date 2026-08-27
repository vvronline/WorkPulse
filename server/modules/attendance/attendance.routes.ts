/** HTTP adapter for the first attendance module slice. */
import express from "express";
import type { Request, Response } from "express";
import auth from "../../middleware/auth";
import { loadUserContext } from "../../middleware/rbac";
import { findApprover } from "../../utils/approver";
import { logAction } from "../../utils/audit";
import { sendToUser } from "../../utils/ws";
import { createAttendanceService } from "./attendance.service";
import { AttendanceError } from "./attendance.types";
import type { AttendanceDb } from "./attendance.types";
import { parseCreateOvertime, parseTheme, parseDateParam } from "./attendance.schema";
import { getLocalToday, getLocalDow, getOffsetMin } from "../../utils/timezone";

const router = express.Router();
const service = createAttendanceService({ findApprover: findApprover as any, sendToUser });

function db(req: Request): AttendanceDb {
    return req.db as unknown as AttendanceDb;
}

router.post("/overtime-request", auth, loadUserContext, async (req: Request, res: Response) => {
    try {
        const input = parseCreateOvertime(req.body);
        await service.createOvertimeRequest(db(req), {
            userId: req.userId!,
            orgId: req.userOrgId || null,
            tenantId: req.tenantId ? Number(req.tenantId) : null,
        }, input);
        logAction(req, "create", "overtime_request", null, { date: input.date, hours: input.hours });
        res.json({ message: "Overtime request submitted for approval" });
    } catch (err) {
        if (err instanceof AttendanceError) return res.status(err.statusCode).json({ error: err.message });
        req.log.error({ err }, "Overtime request error");
        res.status(500).json({ error: "Failed to submit overtime request" });
    }
});

router.get("/overtime-requests", auth, async (req: Request, res: Response) => {
    try {
        res.json(await service.listOvertimeRequests(db(req), req.userId!));
    } catch (err) {
        req.log.error({ err }, "Overtime requests error");
        res.status(500).json({ error: "Failed to fetch overtime requests" });
    }
});

router.get("/theme", auth, async (req: Request, res: Response) => {
    try {
        res.json({ theme: await service.getTheme(db(req), req.userId!) });
    } catch {
        res.status(500).json({ error: "Failed to fetch theme" });
    }
});

router.put("/theme", auth, async (req: Request, res: Response) => {
    try {
        const theme = parseTheme(req.body);
        await service.updateTheme(db(req), {
            userId: req.userId!,
            tenantId: req.tenantId ? Number(req.tenantId) : null,
        }, theme);
        res.json({ theme, message: "Theme updated" });
    } catch (err) {
        if (err instanceof AttendanceError) return res.status(err.statusCode).json({ error: err.message });
        res.status(500).json({ error: "Failed to update theme" });
    }
});

router.get("/weekly", auth, async (req: Request, res: Response) => {
    try {
        res.json(await service.getWeeklySummary(db(req), req.userId!, getOffsetMin(req)));
    } catch (err) {
        req.log.error({ err }, "Weekly error");
        res.status(500).json({ error: "Failed to fetch weekly data" });
    }
});

router.get("/task-summary", auth, async (req: Request, res: Response) => {
    try {
        res.json(await service.getTaskSummary(db(req), req.userId!, getLocalToday(req)));
    } catch (err) {
        req.log.error({ err }, "Task summary error");
        res.status(500).json({ error: "Failed to fetch task summary" });
    }
});

router.get("/history", auth, async (req: Request, res: Response) => {
    try {
        const { from, to } = req.query as { from?: string; to?: string };
        const offset = getOffsetMin(req);
        const fromDate = from || new Date(Date.now() - offset * 60000 - 30 * 86400000)
            .toISOString().slice(0, 10);
        const toDate = to || getLocalToday(req);
        res.json(await service.getHistory(db(req), req.userId!, fromDate, toDate, offset));
    } catch (err) {
        req.log.error({ err }, "History error");
        res.status(500).json({ error: "Failed to fetch history" });
    }
});

router.get("/analytics", auth, async (req: Request, res: Response) => {
    try {
        const { days, from, to } = req.query as { days?: string; from?: string; to?: string };
        const offset = getOffsetMin(req);
        let fromDate: string;
        let toDate: string;
        let numDays: number;
        if (from && to) {
            fromDate = from;
            toDate = to;
            numDays = Math.round((new Date(`${to}T00:00:00Z`).getTime()
                - new Date(`${from}T00:00:00Z`).getTime()) / 86400000) + 1;
            numDays = Math.min(Math.max(numDays, 1), 365);
        } else {
            numDays = Math.min(Math.max(parseInt(String(days)) || 7, 1), 365);
            fromDate = new Date(Date.now() - offset * 60000 - numDays * 86400000)
                .toISOString().slice(0, 10);
            toDate = getLocalToday(req);
        }
        res.json(await service.getAnalytics(db(req), req.userId!, fromDate, toDate, numDays, offset));
    } catch (err) {
        req.log.error({ err }, "Analytics error");
        res.status(500).json({ error: "Failed to fetch analytics" });
    }
});

router.get("/status", auth, async (req: Request, res: Response) => {
    try {
        const status = await service.getStatus(
            db(req), req.userId!, getLocalToday(req), getLocalDow(req), getOffsetMin(req),
        );
        if (status.autoLoggedOut) {
            logAction(req, "auto_clock_out", "time_entry", null, {
                floorMinutes: status.floorMinutes,
                targetMinutes: status.targetMinutes,
            });
        }
        res.json(status);
    } catch (err) {
        req.log.error({ err }, "Status error");
        res.status(500).json({ error: "Failed to get status" });
    }
});

router.get("/widgets", auth, async (req: Request, res: Response) => {
    try {
        res.json(await service.getWidgets(
            db(req), req.userId!, getLocalToday(req), getOffsetMin(req),
        ));
    } catch (err) {
        req.log.error({ err }, "Widgets error");
        res.status(500).json({ error: "Failed to fetch widgets" });
    }
});

router.post("/break-start", auth, async (req: Request, res: Response) => {
    try {
        await service.startBreak(db(req), req.userId!, getLocalToday(req), getOffsetMin(req));
        logAction(req, "break_start", "time_entry", null, {});
        res.json({ message: "Break started" });
    } catch (err) {
        if (err instanceof AttendanceError) return res.status(err.statusCode).json({ error: err.message });
        req.log.error({ err }, "Break-start error");
        res.status(500).json({ error: "Failed to start break" });
    }
});

router.post("/break-end", auth, async (req: Request, res: Response) => {
    try {
        await service.endBreak(db(req), req.userId!, getLocalToday(req), getOffsetMin(req));
        logAction(req, "break_end", "time_entry", null, {});
        res.json({ message: "Break ended, back to work!" });
    } catch (err) {
        if (err instanceof AttendanceError) return res.status(err.statusCode).json({ error: err.message });
        req.log.error({ err }, "Break-end error");
        res.status(500).json({ error: "Failed to end break" });
    }
});

router.get("/manual-entries", auth, loadUserContext, async (req: Request, res: Response) => {
    try {
        res.json(await service.listManualEntries(db(req), req.userId!));
    } catch (err) {
        req.log.error({ err }, "Manual entries error");
        res.status(500).json({ error: "Failed to fetch manual entries" });
    }
});

router.get("/entries/:date", auth, async (req: Request, res: Response) => {
    try {
        const date = parseDateParam(req.params.date);
        res.json(await service.getEntriesForDate(db(req), req.userId!, date, getOffsetMin(req)));
    } catch (err) {
        if (err instanceof AttendanceError) return res.status(err.statusCode).json({ error: err.message });
        req.log.error({ err }, "Get entries error");
        res.status(500).json({ error: "Failed to fetch entries" });
    }
});

router.delete("/entries/:date", auth, loadUserContext, async (req: Request, res: Response) => {
    try {
        const date = parseDateParam(req.params.date);
        const deleted = await service.deleteEntriesForDate(db(req), {
            userId: req.userId!,
            orgId: req.userOrgId || null,
        }, date, getOffsetMin(req));
        res.json({ message: `Deleted ${deleted} entries for ${date}` });
    } catch (err) {
        if (err instanceof AttendanceError) return res.status(err.statusCode).json({ error: err.message });
        req.log.error({ err }, "Delete entries error");
        res.status(500).json({ error: "Failed to delete entries" });
    }
});

export = router;
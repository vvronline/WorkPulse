"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
const express_1 = __importDefault(require("express"));
const auth = require("../middleware/auth");
const { loadUserContext } = require("../middleware/rbac");
const { logger } = require("../utils/logger");
const router = express_1.default.Router();
const { requireTenant } = require("../middleware/tenant");
router.use(auth, loadUserContext, requireTenant);
router.get("/", async (req, res) => {
    try {
        const page = Math.max(parseInt(String(req.query.page)) || 1, 1);
        const perPage = Math.min(Math.max(parseInt(String(req.query.per_page)) || 50, 1), 100);
        const offset = (page - 1) * perPage;
        const totalRes = await req.db.query("SELECT COUNT(*) AS count FROM notifications WHERE user_id = $1", [req.userId]);
        const total = parseInt(totalRes.rows[0].count, 10);
        const rows = (await req.db.query(`
            SELECT n.*, t.title AS task_title
            FROM notifications n
            LEFT JOIN tasks t ON t.id = n.link_task_id
            WHERE n.user_id = $1
            ORDER BY n.created_at DESC
            LIMIT $2 OFFSET $3
        `, [req.userId, perPage, offset])).rows;
        const unread = (await req.db.query("SELECT COUNT(*) AS count FROM notifications WHERE user_id = $1 AND is_read = FALSE", [req.userId])).rows[0].count;
        res.json({ notifications: rows, unread: parseInt(unread, 10), total, page, perPage });
    }
    catch (err) {
        req.log.error({ err }, "Error fetching notifications");
        res.status(500).json({ error: "Failed to fetch notifications" });
    }
});
router.post("/read-all", async (req, res) => {
    try {
        await req.db.query("UPDATE notifications SET is_read = TRUE WHERE user_id = $1", [req.userId]);
        res.json({ ok: true });
    }
    catch (err) {
        res.status(500).json({ error: "Failed to mark notifications read" });
    }
});
router.post("/:id/read", async (req, res) => {
    try {
        const id = parseInt(String(req.params.id), 10);
        if (isNaN(id))
            return res.status(400).json({ error: "Invalid notification ID" });
        await req.db.query("UPDATE notifications SET is_read = TRUE WHERE id = $1 AND user_id = $2", [id, req.userId]);
        res.json({ ok: true });
    }
    catch (err) {
        res.status(500).json({ error: "Failed to mark notification read" });
    }
});
router.delete("/:id", async (req, res) => {
    try {
        const id = parseInt(String(req.params.id), 10);
        if (isNaN(id))
            return res.status(400).json({ error: "Invalid notification ID" });
        await req.db.query("DELETE FROM notifications WHERE id = $1 AND user_id = $2", [id, req.userId]);
        res.json({ ok: true });
    }
    catch (err) {
        res.status(500).json({ error: "Failed to delete notification" });
    }
});
router.get("/announcements", async (req, res) => {
    try {
        const rows = (await req.db.query(`
            SELECT a.id, a.message, a.type, a.created_at, u.full_name AS author
            FROM announcements a
            LEFT JOIN users u ON u.id = a.created_by
            WHERE a.is_active = TRUE AND (a.org_id IS NULL OR a.org_id = $1)
              AND (a.expires_at IS NULL OR a.expires_at > NOW())
            ORDER BY a.created_at DESC LIMIT 20
        `, [req.userOrgId])).rows;
        res.json({ data: rows });
    }
    catch (err) {
        req.log.error({ err }, "Error fetching announcements");
        res.status(500).json({ error: "Failed to fetch announcements" });
    }
});
module.exports = router;
//# sourceMappingURL=notifications.js.map
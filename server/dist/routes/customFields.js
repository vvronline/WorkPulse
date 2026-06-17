"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
/**
 * Custom Fields routes — tenant-customisable extra fields on tasks.
 *
 * Two responsibilities:
 *   1. Field DEFINITIONS (admin-only management of the catalog).
 *   2. Field VALUES on individual tasks (anyone with access to the task).
 *
 * Endpoints:
 *
 *   ─── Definitions ─────────────────────────────────────────────────────
 *   GET    /custom-fields                  list active defs (any auth)
 *   GET    /custom-fields/all              list incl. inactive (admin)
 *   POST   /custom-fields                  create (admin)
 *   PUT    /custom-fields/:id              update (admin)
 *   DELETE /custom-fields/:id              soft-delete + drop values (admin)
 *   PUT    /custom-fields/reorder          { order: [id,id,...] } (admin)
 *
 *   ─── Per-task values ─────────────────────────────────────────────────
 *   GET    /custom-fields/task/:taskId     { fieldId: value } map
 *   PUT    /custom-fields/task/:taskId     { values: { fieldId: value } }
 *
 * "Admin" here means any role allowed to edit Agile config: super_admin,
 * platform_admin, hr_admin, manager, team_lead, scrum_master.
 * Same gate as work-item-types — admins of the workflow own the schema.
 */
const express_1 = __importDefault(require("express"));
const auth = require("../middleware/auth");
const { loadUserContext } = require("../middleware/rbac");
const { requireTenant, requireFeature } = require("../middleware/tenant");
const { isAgileEditorRole } = require("../middleware/agileEditor");
const { logAction } = require("../utils/audit");
const router = express_1.default.Router();
// Custom fields are an Enterprise-only feature (see planCatalog.js). The
// gate must come BEFORE auth so the 403 returns immediately without forcing
// a DB lookup on every blocked request.
router.use(requireTenant, requireFeature("custom_fields"));
router.use(auth);
router.use(loadUserContext);
const FIELD_TYPES = ["text", "number", "date", "select", "multiselect", "checkbox", "url"];
// ── Helpers ────────────────────────────────────────────────────────────────
function requireAdmin(req, res, next) {
    if (!req.userRole || !isAgileEditorRole(req.userRole)) {
        return res.status(403).json({ error: "Insufficient permissions to manage custom fields." });
    }
    next();
}
function slugify(name) {
    return String(name || "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "")
        .slice(0, 40);
}
function normaliseOptions(raw) {
    if (!Array.isArray(raw))
        return [];
    return raw
        .slice(0, 100)
        .map((o) => {
        if (typeof o === "string") {
            const s = o.trim();
            return s ? { value: s, label: s } : null;
        }
        const value = String(o?.value ?? o?.label ?? "").trim();
        const label = String(o?.label ?? o?.value ?? "").trim();
        if (!value)
            return null;
        return { value: value.slice(0, 100), label: (label || value).slice(0, 100) };
    })
        .filter(Boolean);
}
function normaliseAppliesToTypes(raw) {
    if (!Array.isArray(raw))
        return [];
    return raw
        .map((v) => parseInt(v, 10))
        .filter((n) => Number.isFinite(n) && n > 0)
        .slice(0, 50);
}
function coerceValue(field, raw) {
    if (raw === null || raw === undefined || raw === "")
        return null;
    switch (field.field_type) {
        case "text": {
            const s = String(raw).slice(0, 5000);
            return s === "" ? null : s;
        }
        case "url": {
            const s = String(raw).trim().slice(0, 2000);
            if (!s)
                return null;
            // Allow http(s)://, mailto:, or bare values — the UI displays them as text otherwise.
            return s;
        }
        case "number": {
            const n = Number(raw);
            return Number.isFinite(n) ? n : null;
        }
        case "date": {
            // Expect YYYY-MM-DD; accept full ISO and trim.
            const s = String(raw).slice(0, 10);
            return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
        }
        case "checkbox":
            return !!raw;
        case "select": {
            const s = String(raw);
            const opts = Array.isArray(field.options) ? field.options : [];
            return opts.some((o) => String(o.value) === s) ? s : null;
        }
        case "multiselect": {
            if (!Array.isArray(raw))
                return null;
            const opts = Array.isArray(field.options) ? field.options : [];
            const allowed = new Set(opts.map((o) => String(o.value)));
            const cleaned = raw
                .map((v) => String(v))
                .filter((v) => allowed.has(v));
            return cleaned;
        }
        default:
            return null;
    }
}
async function loadDefinitions(req, { includeInactive = false } = {}) {
    const sql = `
        SELECT id, key, label, field_type, description, options,
               is_required, show_on_card, applies_to_types, sort_order, is_active,
               created_at, updated_at
          FROM custom_field_definitions
         WHERE org_id = $1 ${includeInactive ? "" : "AND is_active = TRUE"}
         ORDER BY sort_order ASC, id ASC`;
    return (await req.db.query(sql, [req.userOrgId])).rows;
}
// ── Definitions ────────────────────────────────────────────────────────────
router.get("/", async (req, res) => {
    try {
        if (!req.userOrgId)
            return res.json([]);
        const rows = await loadDefinitions(req);
        res.json(rows);
    }
    catch (err) {
        req.log.error({ err }, "GET /custom-fields error");
        res.status(500).json({ error: "Failed to load custom fields" });
    }
});
router.get("/all", requireAdmin, async (req, res) => {
    try {
        if (!req.userOrgId)
            return res.json([]);
        const rows = await loadDefinitions(req, { includeInactive: true });
        res.json(rows);
    }
    catch (err) {
        req.log.error({ err }, "GET /custom-fields/all error");
        res.status(500).json({ error: "Failed to load custom fields" });
    }
});
router.post("/", requireAdmin, async (req, res) => {
    try {
        if (!req.userOrgId)
            return res.status(400).json({ error: "Organization context required" });
        const b = req.body || {};
        const label = String(b.label || "").trim();
        if (!label)
            return res.status(400).json({ error: "Label is required" });
        if (label.length > 80)
            return res.status(400).json({ error: "Label must be 80 characters or less" });
        const fieldType = String(b.field_type || "").trim();
        if (!FIELD_TYPES.includes(fieldType)) {
            return res.status(400).json({ error: `Invalid field_type. Allowed: ${FIELD_TYPES.join(", ")}` });
        }
        let key = String(b.key || "").trim() || slugify(label);
        key = slugify(key);
        if (!key)
            return res.status(400).json({ error: "Could not derive a key from the label" });
        const exists = await req.db.query("SELECT 1 FROM custom_field_definitions WHERE org_id = $1 AND key = $2", [req.userOrgId, key]);
        if (exists.rowCount > 0) {
            return res.status(409).json({ error: "A field with this key already exists" });
        }
        const description = b.description ? String(b.description).slice(0, 500) : null;
        const options = (fieldType === "select" || fieldType === "multiselect")
            ? normaliseOptions(b.options) : [];
        if ((fieldType === "select" || fieldType === "multiselect") && options.length === 0) {
            return res.status(400).json({ error: "Select fields need at least one option" });
        }
        const isRequired = !!b.is_required;
        const showOnCard = !!b.show_on_card;
        const appliesTo = normaliseAppliesToTypes(b.applies_to_types);
        // Place new field at the end
        const maxRow = await req.db.query("SELECT COALESCE(MAX(sort_order),0) AS m FROM custom_field_definitions WHERE org_id = $1", [req.userOrgId]);
        const sortOrder = (maxRow.rows[0]?.m || 0) + 1;
        const ins = await req.db.query(`INSERT INTO custom_field_definitions
                (org_id, key, label, field_type, description, options,
                 is_required, show_on_card, applies_to_types, sort_order, created_by)
             VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9::jsonb,$10,$11)
             RETURNING *`, [req.userOrgId, key, label, fieldType, description, JSON.stringify(options),
            isRequired, showOnCard, JSON.stringify(appliesTo), sortOrder, req.userId]);
        const row = ins.rows[0];
        logAction(req, "create", "custom_field", row.id, { key, label, field_type: fieldType });
        res.json(row);
    }
    catch (err) {
        req.log.error({ err }, "POST /custom-fields error");
        res.status(500).json({ error: "Failed to create custom field" });
    }
});
router.put("/reorder", requireAdmin, async (req, res) => {
    try {
        if (!req.userOrgId)
            return res.status(400).json({ error: "Organization context required" });
        const order = Array.isArray(req.body?.order) ? req.body.order : null;
        if (!order)
            return res.status(400).json({ error: "order array required" });
        const ids = order.map((v) => parseInt(v, 10)).filter(Number.isFinite);
        await req.db.transaction(async (client) => {
            for (let i = 0; i < ids.length; i++) {
                await client.query(`UPDATE custom_field_definitions SET sort_order = $1, updated_at = NOW()
                      WHERE id = $2 AND org_id = $3`, [i + 1, ids[i], req.userOrgId]);
            }
        });
        const rows = await loadDefinitions(req, { includeInactive: true });
        res.json(rows);
    }
    catch (err) {
        req.log.error({ err }, "PUT /custom-fields/reorder error");
        res.status(500).json({ error: "Failed to reorder custom fields" });
    }
});
router.put("/:id", requireAdmin, async (req, res) => {
    try {
        if (!req.userOrgId)
            return res.status(400).json({ error: "Organization context required" });
        const id = parseInt(String(req.params.id), 10);
        if (!Number.isFinite(id))
            return res.status(400).json({ error: "Invalid field id" });
        const cur = (await req.db.query("SELECT * FROM custom_field_definitions WHERE id = $1 AND org_id = $2", [id, req.userOrgId])).rows[0];
        if (!cur)
            return res.status(404).json({ error: "Custom field not found" });
        const b = req.body || {};
        const updates = [];
        const params = [];
        let p = 1;
        const set = (col, val) => { updates.push(`${col} = $${p++}`); params.push(val); };
        if (b.label !== undefined) {
            const label = String(b.label || "").trim();
            if (!label)
                return res.status(400).json({ error: "Label cannot be empty" });
            if (label.length > 80)
                return res.status(400).json({ error: "Label must be 80 characters or less" });
            set("label", label);
        }
        if (b.description !== undefined) {
            set("description", b.description ? String(b.description).slice(0, 500) : null);
        }
        // field_type changes are allowed but we do NOT migrate existing values
        // — we simply re-coerce on read. Block changes that would invalidate
        // existing values is left as a future enhancement.
        if (b.field_type !== undefined) {
            const ft = String(b.field_type);
            if (!FIELD_TYPES.includes(ft)) {
                return res.status(400).json({ error: `Invalid field_type. Allowed: ${FIELD_TYPES.join(", ")}` });
            }
            set("field_type", ft);
        }
        if (b.options !== undefined) {
            set("options", JSON.stringify(normaliseOptions(b.options)));
        }
        if (b.is_required !== undefined)
            set("is_required", !!b.is_required);
        if (b.show_on_card !== undefined)
            set("show_on_card", !!b.show_on_card);
        if (b.applies_to_types !== undefined) {
            set("applies_to_types", JSON.stringify(normaliseAppliesToTypes(b.applies_to_types)));
        }
        if (b.is_active !== undefined)
            set("is_active", !!b.is_active);
        if (updates.length === 0)
            return res.json(cur);
        updates.push("updated_at = NOW()");
        params.push(id, req.userOrgId);
        const upd = await req.db.query(`UPDATE custom_field_definitions SET ${updates.join(", ")}
              WHERE id = $${p++} AND org_id = $${p}
              RETURNING *`, params);
        logAction(req, "update", "custom_field", id, { fields: Object.keys(b) });
        res.json(upd.rows[0]);
    }
    catch (err) {
        req.log.error({ err }, "PUT /custom-fields/:id error");
        res.status(500).json({ error: "Failed to update custom field" });
    }
});
router.delete("/:id", requireAdmin, async (req, res) => {
    try {
        if (!req.userOrgId)
            return res.status(400).json({ error: "Organization context required" });
        const id = parseInt(String(req.params.id), 10);
        if (!Number.isFinite(id))
            return res.status(400).json({ error: "Invalid field id" });
        const cur = (await req.db.query("SELECT id FROM custom_field_definitions WHERE id = $1 AND org_id = $2", [id, req.userOrgId])).rows[0];
        if (!cur)
            return res.status(404).json({ error: "Custom field not found" });
        // Hard delete — cascades to task_custom_field_values via FK.
        await req.db.query("DELETE FROM custom_field_definitions WHERE id = $1 AND org_id = $2", [id, req.userOrgId]);
        logAction(req, "delete", "custom_field", id, {});
        res.json({ ok: true });
    }
    catch (err) {
        req.log.error({ err }, "DELETE /custom-fields/:id error");
        res.status(500).json({ error: "Failed to delete custom field" });
    }
});
// ── Per-task values ────────────────────────────────────────────────────────
// Task access check — mirrors the rules in routes/tasks.js but lighter.
async function loadTaskAccessible(req, taskId) {
    const task = (await req.db.query("SELECT * FROM tasks WHERE id = $1", [taskId])).rows[0];
    if (!task)
        return null;
    if (req.userOrgId && task.org_id && task.org_id !== req.userOrgId)
        return null;
    if (!req.userOrgId && task.org_id)
        return null;
    // Org admins can always access; otherwise creator/assignee or same team.
    const isAdmin = ["super_admin", "hr_admin", "platform_admin"].includes(req.userRole);
    if (isAdmin)
        return task;
    if (task.user_id === req.userId || task.assigned_to === req.userId)
        return task;
    if (req.userTeamId) {
        const r = await req.db.query("SELECT 1 FROM users WHERE id = $1 AND team_id = $2", [task.user_id, req.userTeamId]);
        if (r.rowCount > 0)
            return task;
    }
    return null;
}
router.get("/task/:taskId", async (req, res) => {
    try {
        const taskId = parseInt(String(req.params.taskId), 10);
        if (!Number.isFinite(taskId))
            return res.status(400).json({ error: "Invalid task id" });
        const task = await loadTaskAccessible(req, taskId);
        if (!task)
            return res.status(404).json({ error: "Task not found" });
        const rows = (await req.db.query(`SELECT field_id, value FROM task_custom_field_values WHERE task_id = $1`, [taskId])).rows;
        const values = {};
        for (const r of rows)
            values[r.field_id] = r.value;
        res.json({ values });
    }
    catch (err) {
        req.log.error({ err }, "GET /custom-fields/task/:taskId error");
        res.status(500).json({ error: "Failed to load custom field values" });
    }
});
router.put("/task/:taskId", async (req, res) => {
    try {
        const taskId = parseInt(String(req.params.taskId), 10);
        if (!Number.isFinite(taskId))
            return res.status(400).json({ error: "Invalid task id" });
        const task = await loadTaskAccessible(req, taskId);
        if (!task)
            return res.status(404).json({ error: "Task not found" });
        const incoming = (req.body && typeof req.body.values === "object" && req.body.values) || {};
        const defs = await loadDefinitions(req);
        const defById = new Map(defs.map((d) => [d.id, d]));
        await req.db.transaction(async (client) => {
            for (const [fidStr, raw] of Object.entries(incoming)) {
                const fid = parseInt(fidStr, 10);
                const def = defById.get(fid);
                if (!def)
                    continue;
                // Honour applies_to_types if set
                const applies = Array.isArray(def.applies_to_types) ? def.applies_to_types : [];
                if (applies.length > 0 && task.work_item_type_id && !applies.includes(task.work_item_type_id)) {
                    continue;
                }
                const coerced = coerceValue(def, raw);
                if (coerced === null
                    || (Array.isArray(coerced) && coerced.length === 0)
                    || coerced === "") {
                    await client.query("DELETE FROM task_custom_field_values WHERE task_id = $1 AND field_id = $2", [taskId, fid]);
                }
                else {
                    await client.query(`INSERT INTO task_custom_field_values (task_id, field_id, value, updated_by, updated_at)
                         VALUES ($1, $2, $3::jsonb, $4, NOW())
                         ON CONFLICT (task_id, field_id)
                         DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = NOW()`, [taskId, fid, JSON.stringify(coerced), req.userId]);
                }
            }
        });
        // Audit row in task_history (best-effort; ignore failures)
        try {
            await req.db.query(`INSERT INTO task_history (task_id, user_id, action, field, new_value)
                 VALUES ($1, $2, 'updated', 'custom_fields', $3)`, [taskId, req.userId, `${Object.keys(incoming).length} field(s)`]);
        }
        catch { /* ignore */ }
        // Return the updated value map
        const rows = (await req.db.query(`SELECT field_id, value FROM task_custom_field_values WHERE task_id = $1`, [taskId])).rows;
        const values = {};
        for (const r of rows)
            values[r.field_id] = r.value;
        res.json({ values });
    }
    catch (err) {
        req.log.error({ err }, "PUT /custom-fields/task/:taskId error");
        res.status(500).json({ error: "Failed to update custom field values" });
    }
});
module.exports = router;
//# sourceMappingURL=customFields.js.map
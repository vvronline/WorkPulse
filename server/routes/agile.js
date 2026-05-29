/**
 * Agile configuration & access-control routes.
 *
 * Endpoints (all require auth + tenant + loadUserContext):
 *
 *   ─── Public read (any authenticated org member can read) ───
 *   GET    /agile/config              full config bundle (settings + types + states)
 *   GET    /agile/settings
 *   GET    /agile/work-item-types
 *   GET    /agile/workflow-states
 *   GET    /agile/permissions/me      { canEdit, isSuperAdmin, requestStatus }
 *
 *   ─── Editor-gated (super_admin OR active grant in agile_editor_grants) ───
 *   PUT    /agile/settings
 *   POST   /agile/work-item-types
 *   PUT    /agile/work-item-types/:id
 *   DELETE /agile/work-item-types/:id   (block if in use)
 *   PUT    /agile/work-item-types/reorder
 *   POST   /agile/workflow-states
 *   PUT    /agile/workflow-states/:id
 *   DELETE /agile/workflow-states/:id   (block if in use; 4 categories must remain covered)
 *   PUT    /agile/workflow-states/reorder
 *
 *   ─── Access-request workflow ───
 *   POST   /agile/permissions/request          { reason }
 *   POST   /agile/permissions/cancel-request   (cancel my pending request)
 *
 *   ─── super_admin only ───
 *   GET    /agile/permissions/requests         pending requests
 *   PUT    /agile/permissions/requests/:id     { action: 'approve'|'reject', reject_reason? }
 *   GET    /agile/permissions/grants           active grants
 *   DELETE /agile/permissions/grants/:id       revoke grant
 */
const express = require('express');
const auth = require('../middleware/auth');
const { loadUserContext, requireRole } = require('../middleware/rbac');
const { requireTenant, requireFeature } = require('../middleware/tenant');
const { requireAgileEditor, isAgileEditor, isAgileReviewerRole } = require('../middleware/agileEditor');

// Custom middleware: allow any reviewer role (super_admin / hr_admin /
// platform_admin / manager) to manage editor grants & requests, instead of
// the previous super_admin-only gate.
function requireAgileReviewer(req, res, next) {
    if (!req.userRole || !isAgileReviewerRole(req.userRole)) {
        return res.status(403).json({ error: 'Insufficient permissions to review Agile access requests' });
    }
    next();
}
const { logAction } = require('../utils/audit');

const router = express.Router();
router.use(requireTenant, requireFeature('agile'));
router.use(auth);
router.use(loadUserContext);

const REQUIRED_CATEGORIES = ['open', 'in_progress', 'in_review', 'done'];
const ESTIMATION_TYPES = ['fibonacci', 'linear', 'tshirt', 'hours', 'none', 'custom'];

// ── Helpers ──────────────────────────────────────────────────────────────────

async function loadOrgSettings(db, orgId) {
    const r = await db.query('SELECT * FROM org_agile_settings WHERE org_id = $1', [orgId]);
    return r.rows[0] || null;
}

async function ensureSettingsRow(db, orgId) {
    let row = await loadOrgSettings(db, orgId);
    if (row) return row;
    await db.query('INSERT INTO org_agile_settings (org_id) VALUES ($1) ON CONFLICT (org_id) DO NOTHING', [orgId]);
    row = await loadOrgSettings(db, orgId);
    return row;
}

function validateColor(color, fallback = '#6366f1') {
    return /^#[0-9a-fA-F]{6}$/.test(color || '') ? color : fallback;
}

function slugifyKey(name) {
    return String(name || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 40);
}

// ── Config bundle (single round-trip for the client config context) ─────────

router.get('/config', async (req, res) => {
    try {
        if (!req.userOrgId) return res.status(400).json({ error: 'Organization context required' });
        const settings = await ensureSettingsRow(req.db, req.userOrgId);
        const types = (await req.db.query(
            `SELECT id, key, name, icon, color, description, is_default, is_epic, is_active, sort_order
               FROM work_item_types
              WHERE org_id = $1 AND is_active = TRUE
              ORDER BY sort_order ASC, id ASC`,
            [req.userOrgId]
        )).rows;
        const states = (await req.db.query(
            `SELECT id, key, name, category, color, icon, wip_limit, is_initial, is_terminal, is_active, sort_order
               FROM workflow_states
              WHERE org_id = $1 AND is_active = TRUE
              ORDER BY sort_order ASC, id ASC`,
            [req.userOrgId]
        )).rows;
        const canEdit = await isAgileEditor(req);
        res.json({ settings, workItemTypes: types, workflowStates: states, canEdit });
    } catch (err) {
        req.log.error({ err }, 'GET /agile/config error');
        res.status(500).json({ error: 'Failed to load Agile config' });
    }
});

// ── Settings ─────────────────────────────────────────────────────────────────

router.get('/settings', async (req, res) => {
    try {
        if (!req.userOrgId) return res.status(400).json({ error: 'Organization context required' });
        const row = await ensureSettingsRow(req.db, req.userOrgId);
        res.json(row);
    } catch (err) {
        req.log.error({ err }, 'GET /agile/settings error');
        res.status(500).json({ error: 'Failed to load settings' });
    }
});

router.put('/settings', requireAgileEditor, async (req, res) => {
    try {
        if (!req.userOrgId) return res.status(400).json({ error: 'Organization context required' });
        await ensureSettingsRow(req.db, req.userOrgId);

        const b = req.body || {};
        const updates = [];
        const params = [];
        let p = 1;

        const setField = (col, val) => {
            updates.push(`${col} = $${p++}`);
            params.push(val);
        };

        if (b.estimation_type !== undefined) {
            if (!ESTIMATION_TYPES.includes(b.estimation_type)) {
                return res.status(400).json({ error: `Invalid estimation_type. Allowed: ${ESTIMATION_TYPES.join(', ')}` });
            }
            setField('estimation_type', b.estimation_type);
        }
        if (b.estimation_values !== undefined) {
            if (!Array.isArray(b.estimation_values)) {
                return res.status(400).json({ error: 'estimation_values must be an array' });
            }
            // T-shirt sizes are strings ("XS","S","M","L","XL"); numeric scales are numbers.
            const cleaned = b.estimation_values.map(v => (typeof v === 'string' ? v : Number(v)))
                .filter(v => v !== '' && (typeof v === 'string' || Number.isFinite(v)))
                .slice(0, 30);
            setField('estimation_values', JSON.stringify(cleaned));
        }
        if (b.estimation_unit_label !== undefined) {
            setField('estimation_unit_label', String(b.estimation_unit_label || 'SP').slice(0, 20));
        }
        if (b.priority_scheme !== undefined) {
            if (!Array.isArray(b.priority_scheme) || b.priority_scheme.length === 0) {
                return res.status(400).json({ error: 'priority_scheme must be a non-empty array' });
            }
            const cleaned = b.priority_scheme.slice(0, 10).map(p => ({
                key: String(p.key || slugifyKey(p.label)).slice(0, 30),
                label: String(p.label || p.key || 'Priority').slice(0, 30),
                color: validateColor(p.color),
            }));
            setField('priority_scheme', JSON.stringify(cleaned));
        }
        for (const flag of [
            'enable_story_points', 'enable_epics', 'enable_dependencies',
            'enable_acceptance_criteria', 'enable_wip_limits', 'enable_blockers',
            'enable_retrospectives', 'require_estimate_for_sprint',
        ]) {
            if (b[flag] !== undefined) setField(flag, !!b[flag]);
        }
        if (b.default_dod !== undefined) {
            setField('default_dod', b.default_dod ? String(b.default_dod).slice(0, 10000) : null);
        }

        if (updates.length === 0) {
            const row = await loadOrgSettings(req.db, req.userOrgId);
            return res.json(row);
        }

        updates.push(`updated_at = NOW()`);
        params.push(req.userOrgId);
        await req.db.query(
            `UPDATE org_agile_settings SET ${updates.join(', ')} WHERE org_id = $${p}`,
            params
        );
        const row = await loadOrgSettings(req.db, req.userOrgId);
        logAction(req, 'update', 'agile_settings', req.userOrgId, { fields: updates });
        res.json(row);
    } catch (err) {
        req.log.error({ err }, 'PUT /agile/settings error');
        res.status(500).json({ error: 'Failed to update settings' });
    }
});

// ── Work Item Types ──────────────────────────────────────────────────────────

router.get('/work-item-types', async (req, res) => {
    try {
        if (!req.userOrgId) return res.json([]);
        const r = await req.db.query(
            `SELECT id, key, name, icon, color, description, is_default, is_epic, is_active, sort_order, created_at
               FROM work_item_types
              WHERE org_id = $1
              ORDER BY sort_order ASC, id ASC`,
            [req.userOrgId]
        );
        res.json(r.rows);
    } catch (err) {
        req.log.error({ err }, 'GET /agile/work-item-types error');
        res.status(500).json({ error: 'Failed to load work item types' });
    }
});

router.post('/work-item-types', requireAgileEditor, async (req, res) => {
    try {
        if (!req.userOrgId) return res.status(400).json({ error: 'Organization context required' });
        const { name, icon, color, description, is_epic, is_default } = req.body || {};
        if (!name || !String(name).trim()) return res.status(400).json({ error: 'Name is required' });

        const finalName = String(name).trim().slice(0, 50);
        let key = req.body?.key ? slugifyKey(req.body.key) : slugifyKey(finalName);
        if (!key) key = `type_${Date.now()}`;

        const exists = await req.db.query('SELECT id FROM work_item_types WHERE org_id = $1 AND key = $2', [req.userOrgId, key]);
        if (exists.rows[0]) return res.status(409).json({ error: 'A work item type with this key already exists' });

        const sortRes = await req.db.query('SELECT COALESCE(MAX(sort_order), 0) + 1 AS next FROM work_item_types WHERE org_id = $1', [req.userOrgId]);
        const sortOrder = sortRes.rows[0].next;

        await req.db.transaction(async (client) => {
            if (is_default) {
                await client.query('UPDATE work_item_types SET is_default = FALSE WHERE org_id = $1', [req.userOrgId]);
            }
            await client.query(
                `INSERT INTO work_item_types (org_id, key, name, icon, color, description, is_epic, is_default, sort_order)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
                [
                    req.userOrgId, key, finalName,
                    icon ? String(icon).slice(0, 40) : null,
                    validateColor(color),
                    description ? String(description).slice(0, 500) : null,
                    !!is_epic, !!is_default, sortOrder,
                ]
            );
        });

        const row = (await req.db.query('SELECT * FROM work_item_types WHERE org_id = $1 AND key = $2', [req.userOrgId, key])).rows[0];
        logAction(req, 'create', 'work_item_type', row.id, { key, name: finalName });
        res.json(row);
    } catch (err) {
        req.log.error({ err }, 'POST /agile/work-item-types error');
        res.status(500).json({ error: 'Failed to create work item type' });
    }
});

router.put('/work-item-types/:id', requireAgileEditor, async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
        const existing = (await req.db.query('SELECT * FROM work_item_types WHERE id = $1', [id])).rows[0];
        if (!existing || existing.org_id !== req.userOrgId) return res.status(404).json({ error: 'Work item type not found' });

        const b = req.body || {};
        const updates = [];
        const params = [];
        let p = 1;
        const set = (col, val) => { updates.push(`${col} = $${p++}`); params.push(val); };

        if (b.name !== undefined) set('name', String(b.name).trim().slice(0, 50));
        if (b.icon !== undefined) set('icon', b.icon ? String(b.icon).slice(0, 40) : null);
        if (b.color !== undefined) set('color', validateColor(b.color, existing.color));
        if (b.description !== undefined) set('description', b.description ? String(b.description).slice(0, 500) : null);
        if (b.is_epic !== undefined) set('is_epic', !!b.is_epic);
        if (b.is_active !== undefined) set('is_active', !!b.is_active);
        if (b.sort_order !== undefined) set('sort_order', parseInt(b.sort_order, 10) || 0);

        await req.db.transaction(async (client) => {
            if (b.is_default === true) {
                await client.query('UPDATE work_item_types SET is_default = FALSE WHERE org_id = $1', [req.userOrgId]);
                set('is_default', true);
            } else if (b.is_default === false) {
                set('is_default', false);
            }
            if (updates.length > 0) {
                params.push(id);
                await client.query(`UPDATE work_item_types SET ${updates.join(', ')} WHERE id = $${p}`, params);
            }
        });

        const row = (await req.db.query('SELECT * FROM work_item_types WHERE id = $1', [id])).rows[0];
        logAction(req, 'update', 'work_item_type', id, { name: row.name });
        res.json(row);
    } catch (err) {
        req.log.error({ err }, 'PUT /agile/work-item-types/:id error');
        res.status(500).json({ error: 'Failed to update work item type' });
    }
});

router.delete('/work-item-types/:id', requireAgileEditor, async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
        const existing = (await req.db.query('SELECT * FROM work_item_types WHERE id = $1', [id])).rows[0];
        if (!existing || existing.org_id !== req.userOrgId) return res.status(404).json({ error: 'Work item type not found' });

        // Block delete if any task references this type
        const usage = (await req.db.query('SELECT COUNT(*)::int AS c FROM tasks WHERE work_item_type_id = $1', [id])).rows[0];
        if (usage.c > 0) {
            return res.status(409).json({
                error: `Cannot delete: ${usage.c} task(s) still use this type. Reassign them first.`,
                taskCount: usage.c,
            });
        }
        // Block deleting the only default
        if (existing.is_default) {
            const otherDefault = (await req.db.query(
                'SELECT id FROM work_item_types WHERE org_id = $1 AND id != $2 AND is_active = TRUE LIMIT 1',
                [req.userOrgId, id]
            )).rows[0];
            if (!otherDefault) return res.status(409).json({ error: 'Cannot delete the only active work item type. Add another first.' });
        }

        await req.db.query('DELETE FROM work_item_types WHERE id = $1', [id]);
        logAction(req, 'delete', 'work_item_type', id, { name: existing.name });
        res.json({ message: 'Work item type deleted' });
    } catch (err) {
        req.log.error({ err }, 'DELETE /agile/work-item-types/:id error');
        res.status(500).json({ error: 'Failed to delete work item type' });
    }
});

router.put('/work-item-types/reorder', requireAgileEditor, async (req, res) => {
    try {
        const { order } = req.body || {};
        if (!Array.isArray(order)) return res.status(400).json({ error: 'order must be an array of ids' });
        await req.db.transaction(async (client) => {
            for (let i = 0; i < order.length; i++) {
                const id = parseInt(order[i], 10);
                if (isNaN(id)) continue;
                await client.query('UPDATE work_item_types SET sort_order = $1 WHERE id = $2 AND org_id = $3', [i + 1, id, req.userOrgId]);
            }
        });
        res.json({ message: 'Order updated' });
    } catch (err) {
        req.log.error({ err }, 'PUT /agile/work-item-types/reorder error');
        res.status(500).json({ error: 'Failed to reorder' });
    }
});

// ── Workflow States ─────────────────────────────────────────────────────────

router.get('/workflow-states', async (req, res) => {
    try {
        if (!req.userOrgId) return res.json([]);
        const r = await req.db.query(
            `SELECT id, key, name, category, color, icon, wip_limit, is_initial, is_terminal, is_active, sort_order, created_at
               FROM workflow_states
              WHERE org_id = $1
              ORDER BY sort_order ASC, id ASC`,
            [req.userOrgId]
        );
        res.json(r.rows);
    } catch (err) {
        req.log.error({ err }, 'GET /agile/workflow-states error');
        res.status(500).json({ error: 'Failed to load workflow states' });
    }
});

/**
 * Validate that the active workflow_states for an org cover all 4 required
 * categories (open / in_progress / in_review / done). Throws if not.
 */
async function assertCategoriesCovered(db, orgId, opts = {}) {
    const { excludeId = null, makingInactiveId = null } = opts;
    const rows = (await db.query(
        `SELECT category FROM workflow_states
          WHERE org_id = $1 AND is_active = TRUE AND id != COALESCE($2, -1) AND id != COALESCE($3, -1)`,
        [orgId, excludeId, makingInactiveId]
    )).rows;
    const have = new Set(rows.map(r => r.category));
    const missing = REQUIRED_CATEGORIES.filter(c => !have.has(c));
    if (missing.length > 0) {
        const err = new Error(`Workflow must keep at least one active state in each category. Missing: ${missing.join(', ')}`);
        err.code = 'CATEGORY_MISSING';
        err.missing = missing;
        throw err;
    }
}

router.post('/workflow-states', requireAgileEditor, async (req, res) => {
    try {
        if (!req.userOrgId) return res.status(400).json({ error: 'Organization context required' });
        const { name, category, color, icon, wip_limit, is_initial, is_terminal } = req.body || {};
        if (!name || !String(name).trim()) return res.status(400).json({ error: 'Name is required' });
        if (!REQUIRED_CATEGORIES.includes(category)) {
            return res.status(400).json({ error: `category must be one of: ${REQUIRED_CATEGORIES.join(', ')}` });
        }
        const finalName = String(name).trim().slice(0, 40);
        let key = req.body?.key ? slugifyKey(req.body.key) : slugifyKey(finalName);
        if (!key) key = `state_${Date.now()}`;

        const exists = await req.db.query('SELECT id FROM workflow_states WHERE org_id = $1 AND key = $2', [req.userOrgId, key]);
        if (exists.rows[0]) return res.status(409).json({ error: 'A workflow state with this key already exists' });

        const sortRes = await req.db.query('SELECT COALESCE(MAX(sort_order), 0) + 1 AS next FROM workflow_states WHERE org_id = $1', [req.userOrgId]);
        const sortOrder = sortRes.rows[0].next;

        await req.db.transaction(async (client) => {
            // Only one is_initial per org
            if (is_initial) await client.query('UPDATE workflow_states SET is_initial = FALSE WHERE org_id = $1', [req.userOrgId]);
            await client.query(
                `INSERT INTO workflow_states (org_id, key, name, category, color, icon, wip_limit, is_initial, is_terminal, sort_order)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
                [
                    req.userOrgId, key, finalName, category,
                    validateColor(color, '#6b7280'),
                    icon ? String(icon).slice(0, 40) : null,
                    wip_limit != null ? parseInt(wip_limit, 10) || null : null,
                    !!is_initial, !!is_terminal, sortOrder,
                ]
            );
        });

        const row = (await req.db.query('SELECT * FROM workflow_states WHERE org_id = $1 AND key = $2', [req.userOrgId, key])).rows[0];
        logAction(req, 'create', 'workflow_state', row.id, { key, name: finalName, category });
        res.json(row);
    } catch (err) {
        req.log.error({ err }, 'POST /agile/workflow-states error');
        res.status(500).json({ error: 'Failed to create workflow state' });
    }
});

router.put('/workflow-states/:id', requireAgileEditor, async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
        const existing = (await req.db.query('SELECT * FROM workflow_states WHERE id = $1', [id])).rows[0];
        if (!existing || existing.org_id !== req.userOrgId) return res.status(404).json({ error: 'Workflow state not found' });

        const b = req.body || {};
        const updates = [];
        const params = [];
        let p = 1;
        const set = (col, val) => { updates.push(`${col} = $${p++}`); params.push(val); };

        if (b.name !== undefined) set('name', String(b.name).trim().slice(0, 40));
        if (b.category !== undefined) {
            if (!REQUIRED_CATEGORIES.includes(b.category)) {
                return res.status(400).json({ error: `category must be one of: ${REQUIRED_CATEGORIES.join(', ')}` });
            }
            set('category', b.category);
        }
        if (b.color !== undefined) set('color', validateColor(b.color, existing.color));
        if (b.icon !== undefined) set('icon', b.icon ? String(b.icon).slice(0, 40) : null);
        if (b.wip_limit !== undefined) set('wip_limit', b.wip_limit != null ? (parseInt(b.wip_limit, 10) || null) : null);
        if (b.is_terminal !== undefined) set('is_terminal', !!b.is_terminal);
        if (b.sort_order !== undefined) set('sort_order', parseInt(b.sort_order, 10) || 0);

        // is_active changes that would leave a category empty are blocked.
        if (b.is_active === false) {
            // Consider what the active set looks like AFTER this change; the row
            // we're inactivating still exists but won't count.
            try {
                await assertCategoriesCovered(req.db, req.userOrgId, { makingInactiveId: id });
            } catch (e) {
                if (e.code === 'CATEGORY_MISSING') return res.status(409).json({ error: e.message, missing: e.missing });
                throw e;
            }
            set('is_active', false);
        } else if (b.is_active === true) {
            set('is_active', true);
        }

        // category change: ensure the OLD category is still covered after the change
        if (b.category !== undefined && b.category !== existing.category) {
            try {
                await assertCategoriesCovered(req.db, req.userOrgId, { excludeId: id });
                // After the change `id` will move to b.category — so the old category
                // is missing one row; verify another row covers it.
                const others = (await req.db.query(
                    `SELECT 1 FROM workflow_states
                      WHERE org_id = $1 AND is_active = TRUE AND category = $2 AND id != $3
                      LIMIT 1`,
                    [req.userOrgId, existing.category, id]
                )).rows;
                if (others.length === 0) {
                    return res.status(409).json({
                        error: `Cannot change category: no other active state covers '${existing.category}'`,
                    });
                }
            } catch (e) {
                if (e.code === 'CATEGORY_MISSING') return res.status(409).json({ error: e.message, missing: e.missing });
                throw e;
            }
        }

        await req.db.transaction(async (client) => {
            if (b.is_initial === true) {
                await client.query('UPDATE workflow_states SET is_initial = FALSE WHERE org_id = $1', [req.userOrgId]);
                set('is_initial', true);
            } else if (b.is_initial === false) {
                set('is_initial', false);
            }
            if (updates.length > 0) {
                params.push(id);
                await client.query(`UPDATE workflow_states SET ${updates.join(', ')} WHERE id = $${p}`, params);
            }
        });

        const row = (await req.db.query('SELECT * FROM workflow_states WHERE id = $1', [id])).rows[0];
        logAction(req, 'update', 'workflow_state', id, { name: row.name });
        res.json(row);
    } catch (err) {
        req.log.error({ err }, 'PUT /agile/workflow-states/:id error');
        res.status(500).json({ error: 'Failed to update workflow state' });
    }
});

router.delete('/workflow-states/:id', requireAgileEditor, async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
        const existing = (await req.db.query('SELECT * FROM workflow_states WHERE id = $1', [id])).rows[0];
        if (!existing || existing.org_id !== req.userOrgId) return res.status(404).json({ error: 'Workflow state not found' });

        // Hard-block: do not delete if any task references this state.
        const usage = (await req.db.query('SELECT COUNT(*)::int AS c FROM tasks WHERE workflow_state_id = $1', [id])).rows[0];
        if (usage.c > 0) {
            return res.status(409).json({
                error: `Cannot delete: ${usage.c} task(s) are in this state. Move them to another state first.`,
                taskCount: usage.c,
            });
        }
        // Ensure the 4-categories rule still holds after the delete.
        try {
            await assertCategoriesCovered(req.db, req.userOrgId, { excludeId: id });
        } catch (e) {
            if (e.code === 'CATEGORY_MISSING') return res.status(409).json({ error: e.message, missing: e.missing });
            throw e;
        }

        await req.db.query('DELETE FROM workflow_states WHERE id = $1', [id]);
        logAction(req, 'delete', 'workflow_state', id, { name: existing.name });
        res.json({ message: 'Workflow state deleted' });
    } catch (err) {
        req.log.error({ err }, 'DELETE /agile/workflow-states/:id error');
        res.status(500).json({ error: 'Failed to delete workflow state' });
    }
});

router.put('/workflow-states/reorder', requireAgileEditor, async (req, res) => {
    try {
        const { order } = req.body || {};
        if (!Array.isArray(order)) return res.status(400).json({ error: 'order must be an array of ids' });
        await req.db.transaction(async (client) => {
            for (let i = 0; i < order.length; i++) {
                const id = parseInt(order[i], 10);
                if (isNaN(id)) continue;
                await client.query('UPDATE workflow_states SET sort_order = $1 WHERE id = $2 AND org_id = $3', [i + 1, id, req.userOrgId]);
            }
        });
        res.json({ message: 'Order updated' });
    } catch (err) {
        req.log.error({ err }, 'PUT /agile/workflow-states/reorder error');
        res.status(500).json({ error: 'Failed to reorder' });
    }
});

// ── Permissions: who can edit Agile settings ────────────────────────────────

router.get('/permissions/me', async (req, res) => {
    try {
        const canEdit = await isAgileEditor(req);
        const isSuperAdmin = req.userRole === 'super_admin' || req.userRole === 'platform_admin';
        const isReviewer = isAgileReviewerRole(req.userRole);
        let requestStatus = 'none';
        if (!canEdit && req.userOrgId) {
            const r = await req.db.query(
                `SELECT status FROM agile_editor_requests
                  WHERE org_id = $1 AND user_id = $2
                  ORDER BY created_at DESC LIMIT 1`,
                [req.userOrgId, req.userId]
            );
            if (r.rows[0]) requestStatus = r.rows[0].status;
        }
        // `isReviewer` tells the UI whether to show the pending-requests &
        // active-grants admin panels; `isSuperAdmin` is kept for backwards
        // compat (legacy UI checks).
        res.json({ canEdit, isSuperAdmin, isReviewer, requestStatus, role: req.userRole });
    } catch (err) {
        req.log.error({ err }, 'GET /agile/permissions/me error');
        res.status(500).json({ error: 'Failed to load permissions' });
    }
});

router.post('/permissions/request', async (req, res) => {
    try {
        if (!req.userOrgId) return res.status(400).json({ error: 'Organization context required' });
        // If already an editor (super_admin or active grant), no need to request.
        if (await isAgileEditor(req)) return res.status(400).json({ error: 'You already have edit access' });

        // Block if there's already a pending request
        const pending = await req.db.query(
            `SELECT id FROM agile_editor_requests
              WHERE org_id = $1 AND user_id = $2 AND status = 'pending' LIMIT 1`,
            [req.userOrgId, req.userId]
        );
        if (pending.rows[0]) return res.status(409).json({ error: 'You already have a pending request' });

        const reason = req.body?.reason ? String(req.body.reason).slice(0, 1000) : null;
        const ins = await req.db.query(
            `INSERT INTO agile_editor_requests (org_id, user_id, reason)
             VALUES ($1, $2, $3) RETURNING *`,
            [req.userOrgId, req.userId, reason]
        );
        // Notify all super_admins in the org
        try {
            const admins = (await req.db.query(
                `SELECT id FROM users WHERE org_id = $1 AND role = 'super_admin' AND is_active = TRUE`,
                [req.userOrgId]
            )).rows;
            const requesterName = (await req.db.query('SELECT full_name, username FROM users WHERE id = $1', [req.userId])).rows[0];
            const name = requesterName?.full_name || requesterName?.username || 'A user';
            for (const a of admins) {
                await req.db.query(
                    `INSERT INTO notifications (user_id, type, title, body) VALUES ($1, 'agile_request', $2, $3)`,
                    [a.id, 'Agile editor access requested', `${name} is requesting Agile settings edit access`]
                );
            }
        } catch (e) { req.log.warn({ err: e }, 'Failed to notify admins of agile request'); }

        logAction(req, 'create', 'agile_editor_request', ins.rows[0].id, { reason });
        res.json(ins.rows[0]);
    } catch (err) {
        req.log.error({ err }, 'POST /agile/permissions/request error');
        res.status(500).json({ error: 'Failed to submit request' });
    }
});

router.post('/permissions/cancel-request', async (req, res) => {
    try {
        if (!req.userOrgId) return res.status(400).json({ error: 'Organization context required' });
        const r = await req.db.query(
            `UPDATE agile_editor_requests
                SET status = 'cancelled', reviewed_at = NOW()
              WHERE org_id = $1 AND user_id = $2 AND status = 'pending'`,
            [req.userOrgId, req.userId]
        );
        res.json({ cancelled: r.rowCount });
    } catch (err) {
        req.log.error({ err }, 'POST /agile/permissions/cancel-request error');
        res.status(500).json({ error: 'Failed to cancel' });
    }
});

router.get('/permissions/requests', requireAgileReviewer, async (req, res) => {
    try {
        if (!req.userOrgId) return res.json([]);
        const r = await req.db.query(
            `SELECT r.*, u.username, u.full_name, u.avatar, u.email
               FROM agile_editor_requests r
               JOIN users u ON u.id = r.user_id
              WHERE r.org_id = $1
              ORDER BY CASE r.status WHEN 'pending' THEN 1 ELSE 2 END, r.created_at DESC
              LIMIT 200`,
            [req.userOrgId]
        );
        res.json(r.rows);
    } catch (err) {
        req.log.error({ err }, 'GET /agile/permissions/requests error');
        res.status(500).json({ error: 'Failed to load requests' });
    }
});

router.put('/permissions/requests/:id', requireAgileReviewer, async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
        const { action, reject_reason } = req.body || {};
        if (!['approve', 'reject'].includes(action)) {
            return res.status(400).json({ error: 'action must be approve or reject' });
        }
        const reqRow = (await req.db.query('SELECT * FROM agile_editor_requests WHERE id = $1', [id])).rows[0];
        if (!reqRow || reqRow.org_id !== req.userOrgId) return res.status(404).json({ error: 'Request not found' });
        if (reqRow.status !== 'pending') return res.status(400).json({ error: 'Request already reviewed' });

        if (action === 'approve') {
            await req.db.transaction(async (client) => {
                await client.query(
                    `UPDATE agile_editor_requests
                        SET status = 'approved', reviewed_by = $1, reviewed_at = NOW()
                      WHERE id = $2`,
                    [req.userId, id]
                );
                // Insert (or reactivate) grant
                await client.query(
                    `INSERT INTO agile_editor_grants (org_id, user_id, granted_by)
                     VALUES ($1, $2, $3)
                     ON CONFLICT (org_id, user_id) DO UPDATE
                        SET revoked_at = NULL, granted_by = EXCLUDED.granted_by, granted_at = NOW()`,
                    [reqRow.org_id, reqRow.user_id, req.userId]
                );
            });
            // Notify requester
            await req.db.query(
                `INSERT INTO notifications (user_id, type, title, body)
                 VALUES ($1, 'agile_grant', 'Agile editor access granted', 'You can now edit Agile settings.')`,
                [reqRow.user_id]
            );
            logAction(req, 'approve', 'agile_editor_request', id, { user_id: reqRow.user_id });
        } else {
            await req.db.query(
                `UPDATE agile_editor_requests
                    SET status = 'rejected', reviewed_by = $1, reviewed_at = NOW(), reject_reason = $2
                  WHERE id = $3`,
                [req.userId, reject_reason ? String(reject_reason).slice(0, 500) : null, id]
            );
            await req.db.query(
                `INSERT INTO notifications (user_id, type, title, body)
                 VALUES ($1, 'agile_grant', 'Agile editor request rejected', $2)`,
                [reqRow.user_id, reject_reason ? `Reason: ${reject_reason}` : 'Your request was rejected.']
            );
            logAction(req, 'reject', 'agile_editor_request', id, { user_id: reqRow.user_id, reason: reject_reason });
        }

        const updated = (await req.db.query('SELECT * FROM agile_editor_requests WHERE id = $1', [id])).rows[0];
        res.json(updated);
    } catch (err) {
        req.log.error({ err }, 'PUT /agile/permissions/requests/:id error');
        res.status(500).json({ error: 'Failed to review request' });
    }
});

router.get('/permissions/grants', requireAgileReviewer, async (req, res) => {
    try {
        if (!req.userOrgId) return res.json([]);
        const r = await req.db.query(
            `SELECT g.*, u.username, u.full_name, u.avatar, u.email,
                    gb.username AS granted_by_username, gb.full_name AS granted_by_name
               FROM agile_editor_grants g
               JOIN users u ON u.id = g.user_id
          LEFT JOIN users gb ON gb.id = g.granted_by
              WHERE g.org_id = $1 AND g.revoked_at IS NULL
              ORDER BY g.granted_at DESC`,
            [req.userOrgId]
        );
        res.json(r.rows);
    } catch (err) {
        req.log.error({ err }, 'GET /agile/permissions/grants error');
        res.status(500).json({ error: 'Failed to load grants' });
    }
});

router.delete('/permissions/grants/:id', requireAgileReviewer, async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
        const grant = (await req.db.query('SELECT * FROM agile_editor_grants WHERE id = $1', [id])).rows[0];
        if (!grant || grant.org_id !== req.userOrgId) return res.status(404).json({ error: 'Grant not found' });
        await req.db.query('UPDATE agile_editor_grants SET revoked_at = NOW() WHERE id = $1', [id]);
        await req.db.query(
            `INSERT INTO notifications (user_id, type, title, body)
             VALUES ($1, 'agile_grant', 'Agile editor access revoked', 'Your edit access for Agile settings was revoked.')`,
            [grant.user_id]
        );
        logAction(req, 'revoke', 'agile_editor_grant', id, { user_id: grant.user_id });
        res.json({ message: 'Grant revoked' });
    } catch (err) {
        req.log.error({ err }, 'DELETE /agile/permissions/grants/:id error');
        res.status(500).json({ error: 'Failed to revoke grant' });
    }
});

module.exports = router;
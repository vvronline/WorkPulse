"use strict";
// Agile catalog helpers — work item types, workflow states, story points
// and acceptance criteria normalisation.
function validateStoryPoints(v) {
    if (v === null || v === undefined || v === '')
        return null;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0 || n > 9999)
        return null;
    return n;
}
/**
 * Resolve work_item_type_id for an org. Accepts either a numeric id or a key.
 * Returns the type row or null. Returns null if value is empty.
 */
async function resolveWorkItemType(value, orgId, db) {
    if (value === null || value === undefined || value === '')
        return null;
    if (!orgId)
        return null;
    const num = Number(value);
    let row;
    if (Number.isFinite(num) && Number.isInteger(num)) {
        row = (await db.query('SELECT * FROM work_item_types WHERE id = $1 AND org_id = $2 AND is_active = TRUE', [num, orgId])).rows[0];
    }
    else {
        row = (await db.query('SELECT * FROM work_item_types WHERE key = $1 AND org_id = $2 AND is_active = TRUE', [String(value), orgId])).rows[0];
    }
    return row || null;
}
/**
 * Resolve workflow_state by id or key, scoped to the org.
 */
async function resolveWorkflowState(value, orgId, db) {
    if (value === null || value === undefined || value === '')
        return null;
    if (!orgId)
        return null;
    const num = Number(value);
    let row;
    if (Number.isFinite(num) && Number.isInteger(num)) {
        row = (await db.query('SELECT * FROM workflow_states WHERE id = $1 AND org_id = $2 AND is_active = TRUE', [num, orgId])).rows[0];
    }
    else {
        row = (await db.query('SELECT * FROM workflow_states WHERE key = $1 AND org_id = $2 AND is_active = TRUE', [String(value), orgId])).rows[0];
    }
    return row || null;
}
/**
 * Get the org's initial workflow state (or first state by sort order). Used
 * when creating a task without an explicit workflow_state_id.
 */
async function getInitialWorkflowState(orgId, db) {
    if (!orgId)
        return null;
    let row = (await db.query('SELECT * FROM workflow_states WHERE org_id = $1 AND is_active = TRUE AND is_initial = TRUE LIMIT 1', [orgId])).rows[0];
    if (!row) {
        row = (await db.query("SELECT * FROM workflow_states WHERE org_id = $1 AND is_active = TRUE ORDER BY sort_order ASC, id ASC LIMIT 1", [orgId])).rows[0];
    }
    return row || null;
}
/**
 * Get the org's default work item type, falling back to the first active type.
 */
async function getDefaultWorkItemType(orgId, db) {
    if (!orgId)
        return null;
    let row = (await db.query('SELECT * FROM work_item_types WHERE org_id = $1 AND is_active = TRUE AND is_default = TRUE LIMIT 1', [orgId])).rows[0];
    if (!row) {
        row = (await db.query('SELECT * FROM work_item_types WHERE org_id = $1 AND is_active = TRUE ORDER BY sort_order ASC, id ASC LIMIT 1', [orgId])).rows[0];
    }
    return row || null;
}
/**
 * Validate and normalise an acceptance_criteria array.
 *
 * Bug #12 (Stage 2): two different normalisers used to live in this repo —
 * one produced `{text, done, doneAt, doneBy}` (used by create/update) and
 * the other produced `{id, text, done}` (used by PUT /acceptance-criteria).
 * Reading a task back after each writer therefore produced incompatible
 * client state. We now emit a single canonical shape:
 *
 *   { id, text, done, doneAt, doneBy }
 *
 * `id` is auto-assigned (monotonic) if missing, preserving any existing ids
 * passed in by the client so checklist items survive reorders. Cap at 100
 * items (was 50) to match the dedicated PUT endpoint.
 */
function normalizeAcceptanceCriteria(value) {
    if (value === null || value === undefined)
        return null;
    if (!Array.isArray(value))
        return null;
    let nextId = Math.max(0, ...value.map((c) => Number(c?.id) || 0)) + 1;
    return value.slice(0, 100).map((it) => {
        const text = String(it?.text || '').trim().slice(0, 500);
        if (!text)
            return null;
        return {
            id: Number(it?.id) || nextId++,
            text,
            done: !!it?.done,
            doneAt: it?.doneAt || null,
            doneBy: it?.doneBy != null ? Number(it.doneBy) : null,
        };
    }).filter(Boolean);
}
module.exports = {
    validateStoryPoints,
    resolveWorkItemType,
    resolveWorkflowState,
    getInitialWorkflowState,
    getDefaultWorkItemType,
    normalizeAcceptanceCriteria,
};
//# sourceMappingURL=agile.js.map
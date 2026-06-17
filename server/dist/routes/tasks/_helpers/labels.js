"use strict";
// syncLabels — replace the label set on a task with the supplied list.
// Validates labels exist in the requester's org so a malicious payload
// can't attach labels from another tenant.
async function syncLabels(taskId, labelIds, orgId, db) {
    if (!labelIds || !Array.isArray(labelIds))
        return;
    // Limit labels per task to prevent resource exhaustion
    const limitedIds = labelIds.slice(0, 20).map((lid) => parseInt(String(lid), 10)).filter((n) => !isNaN(n));
    await db.query('DELETE FROM task_label_map WHERE task_id = $1', [taskId]);
    if (limitedIds.length === 0)
        return;
    // Batch-validate labels belong to the same org
    const validLabels = orgId
        ? (await db.query('SELECT id FROM task_labels WHERE id = ANY($1) AND org_id = $2', [limitedIds, orgId])).rows
        : (await db.query('SELECT id FROM task_labels WHERE id = ANY($1) AND org_id IS NULL', [limitedIds])).rows;
    const validIds = validLabels.map((r) => r.id);
    if (validIds.length > 0) {
        const values = validIds.map((lid, i) => `($1, $${i + 2})`).join(', ');
        await db.query(`INSERT INTO task_label_map (task_id, label_id) VALUES ${values} ON CONFLICT DO NOTHING`, [taskId, ...validIds]);
    }
}
module.exports = { syncLabels };
//# sourceMappingURL=labels.js.map
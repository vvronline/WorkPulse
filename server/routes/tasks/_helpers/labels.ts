// syncLabels — replace the label set on a task with the supplied list.
// Validates labels exist in the requester's org so a malicious payload
// can't attach labels from another tenant.

interface DbLike {
    query: (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount: number }>;
}

async function syncLabels(taskId: number, labelIds: unknown, orgId: number | null | undefined, db: DbLike): Promise<void> {
    if (!labelIds || !Array.isArray(labelIds)) return;
    // Limit labels per task to prevent resource exhaustion
    const limitedIds = labelIds.slice(0, 20).map((lid: unknown) => parseInt(String(lid), 10)).filter((n: number) => !isNaN(n));
    await db.query('DELETE FROM task_label_map WHERE task_id = $1', [taskId]);
    if (limitedIds.length === 0) return;
    // Batch-validate labels belong to the same org
    const validLabels = orgId
        ? (await db.query('SELECT id FROM task_labels WHERE id = ANY($1) AND org_id = $2', [limitedIds, orgId])).rows
        : (await db.query('SELECT id FROM task_labels WHERE id = ANY($1) AND org_id IS NULL', [limitedIds])).rows;
    const validIds = validLabels.map((r: any) => r.id);
    if (validIds.length > 0) {
        const values = validIds.map((lid: number, i: number) => `($1, $${i + 2})`).join(', ');
        await db.query(
            `INSERT INTO task_label_map (task_id, label_id) VALUES ${values} ON CONFLICT DO NOTHING`,
            [taskId, ...validIds]
        );
    }
}

export = { syncLabels };
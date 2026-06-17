"use strict";
// Issue-key helpers (Jira-style "PROJ-123").
//
// A task that belongs to a project gets a stable human-readable key formed
// from the project's `key` column and the task's `task_number` (per-project
// running counter). Legacy tasks without a project remain key-less.
//
// Examples:
//   { project: { key: 'PSSPMT' }, task_number: 123 } → 'PSSPMT-123'
//   { project: null, task_number: null }              → null
// Regex for parsing an issue key out of arbitrary text (branch names, PR
// titles, commit messages). Word-boundary anchored so we don't match
// substrings like "FOO-12-BAR". Case-insensitive; project keys are stored
// upper-case so we always re-upper-case before lookup.
const ISSUE_KEY_RE = /\b([A-Z][A-Z0-9_]{1,9})-(\d{1,9})\b/gi;
function formatIssueKey(projectKey, taskNumber) {
    if (!projectKey || !taskNumber)
        return null;
    return `${String(projectKey).toUpperCase()}-${taskNumber}`;
}
/**
 * Extract every distinct (projectKey, taskNumber) pair referenced anywhere
 * in `text`. Returns `Array<{ projectKey: string, taskNumber: number, raw: string }>`.
 */
function extractIssueKeys(text) {
    if (!text)
        return [];
    const seen = new Set();
    const out = [];
    const re = new RegExp(ISSUE_KEY_RE.source, 'gi');
    let m;
    while ((m = re.exec(String(text))) !== null) {
        const projectKey = m[1].toUpperCase();
        const taskNumber = parseInt(m[2], 10);
        const raw = `${projectKey}-${taskNumber}`;
        if (seen.has(raw))
            continue;
        seen.add(raw);
        out.push({ projectKey, taskNumber, raw });
    }
    return out;
}
/**
 * Resolve a list of issue keys against the org's tasks. Returns an array of
 * `{ key, task_id }` for keys that exist; unknown keys are silently dropped.
 */
async function resolveIssueKeys(keys, orgId, db) {
    if (!keys || !keys.length || !orgId)
        return [];
    // Build a parameterised IN list of project keys + task numbers.
    // We use a single query with arrays so we don't N+1.
    const projectKeys = keys.map(k => k.projectKey);
    const taskNumbers = keys.map(k => k.taskNumber);
    const rows = (await db.query(`SELECT p.key AS project_key, t.task_number, t.id
           FROM tasks t
           JOIN projects p ON p.id = t.project_id
          WHERE p.org_id = $1
            AND (p.key, t.task_number) IN (
                SELECT UNNEST($2::text[]), UNNEST($3::int[])
            )`, [orgId, projectKeys, taskNumbers])).rows;
    return rows.map(r => ({
        key: `${r.project_key}-${r.task_number}`,
        task_id: r.id,
    }));
}
module.exports = {
    formatIssueKey,
    extractIssueKeys,
    resolveIssueKeys,
    ISSUE_KEY_RE,
};
//# sourceMappingURL=issueKey.js.map
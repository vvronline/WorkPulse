"use strict";
// Helpers that hydrate raw task rows with labels, comment counts, assignee
// info, creator info and sprint summaries. Batched to avoid N+1 queries.
async function getLabelsForTasks(taskIds, db) {
    if (!taskIds.length)
        return {};
    const rows = (await db.query(`SELECT tlm.task_id, tl.id, tl.name, tl.color
         FROM task_label_map tlm
         JOIN task_labels tl ON tl.id = tlm.label_id
         WHERE tlm.task_id = ANY($1)`, [taskIds])).rows;
    const map = {};
    for (const r of rows) {
        if (!map[r.task_id])
            map[r.task_id] = [];
        map[r.task_id].push({ id: r.id, name: r.name, color: r.color });
    }
    return map;
}
async function getCommentCounts(taskIds, db) {
    if (!taskIds.length)
        return {};
    const rows = (await db.query(`SELECT task_id, COUNT(*) as count FROM task_comments
         WHERE task_id = ANY($1)
         GROUP BY task_id`, [taskIds])).rows;
    const map = {};
    for (const r of rows)
        map[r.task_id] = parseInt(r.count, 10);
    return map;
}
async function enrichTasks(tasks, db) {
    if (!tasks.length)
        return [];
    const taskIds = tasks.map(t => t.id);
    const [labelsMap, commentMap] = await Promise.all([
        getLabelsForTasks(taskIds, db),
        getCommentCounts(taskIds, db),
    ]);
    const assigneeIds = [...new Set(tasks.map(t => t.assigned_to).filter(Boolean))];
    const creatorIds = [...new Set(tasks.map(t => t.user_id))];
    const sprintIds = [...new Set(tasks.map(t => t.sprint_id).filter(Boolean))];
    // Stage 3: collect project ids so we can surface `issue_key` (PROJ-123)
    // and the lightweight project summary on every enriched task.
    const projectIds = [...new Set(tasks.map(t => t.project_id).filter(Boolean))];
    const allUserIds = [...new Set([...assigneeIds, ...creatorIds])];
    const [userRows, sprintRows, projectRows] = await Promise.all([
        allUserIds.length
            ? db.query('SELECT id, username, full_name, avatar FROM users WHERE id = ANY($1)', [allUserIds]).then(r => r.rows)
            : [],
        sprintIds.length
            ? db.query('SELECT id, name, status, start_date, end_date FROM sprints WHERE id = ANY($1)', [sprintIds]).then(r => r.rows)
            : [],
        projectIds.length
            ? db.query('SELECT id, key, name, color FROM projects WHERE id = ANY($1)', [projectIds]).then(r => r.rows)
            : [],
    ]);
    const userMap = {};
    for (const u of userRows)
        userMap[u.id] = u;
    const sprintMap = {};
    for (const s of sprintRows)
        sprintMap[s.id] = s;
    const projectMap = {};
    for (const p of projectRows)
        projectMap[p.id] = p;
    return tasks.map(t => {
        const project = t.project_id ? (projectMap[t.project_id] || null) : null;
        // Issue key is only set for tasks that have both a project and a
        // task_number (legacy tasks remain key-less even if they get a
        // project assigned, until a number is generated for them).
        const issueKey = project && t.task_number ? `${project.key}-${t.task_number}` : null;
        return {
            ...t,
            labels: labelsMap[t.id] || [],
            comment_count: commentMap[t.id] || 0,
            assignee: t.assigned_to
                ? (userMap[t.assigned_to]
                    ? { username: userMap[t.assigned_to].username, full_name: userMap[t.assigned_to].full_name, avatar: userMap[t.assigned_to].avatar }
                    : null)
                : null,
            creator: userMap[t.user_id]
                ? { username: userMap[t.user_id].username, full_name: userMap[t.user_id].full_name }
                : null,
            sprint: t.sprint_id ? (sprintMap[t.sprint_id] || null) : null,
            project,
            issue_key: issueKey,
        };
    });
}
module.exports = { enrichTasks, getLabelsForTasks, getCommentCounts };
//# sourceMappingURL=enrich.js.map
"use strict";
// Helper: record task history.
//
// Either `client` (a transaction connection) or `db` (a tenant-bound DB
// handle) must be supplied. We throw explicitly when neither is provided so
// the caller's missing argument is obvious in the stack trace rather than
// surfacing a confusing `ReferenceError: query is not defined`.
async function logHistory(taskId, userId, action, field, oldValue, newValue, client, db) {
    let q;
    if (client)
        q = client.query.bind(client);
    else if (db && typeof db.query === 'function')
        q = db.query.bind(db);
    else
        throw new Error('logHistory: either client or db must be provided');
    await q('INSERT INTO task_history (task_id, user_id, action, field, old_value, new_value) VALUES ($1, $2, $3, $4, $5, $6)', [taskId, userId, action, field || null, oldValue != null ? String(oldValue) : null, newValue != null ? String(newValue) : null]);
}
module.exports = { logHistory };
//# sourceMappingURL=logHistory.js.map
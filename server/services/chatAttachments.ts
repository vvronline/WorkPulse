/**
 * Chat attachment object lifecycle.
 *
 * Lives in `services/` rather than `routes/chat.ts` for two reasons:
 *   1. GR1 — routes must not contain SQL, and the reference check needs a query.
 *   2. The rule it encodes is a data-integrity invariant, not HTTP handling.
 */
const { getStorage, urlToKey } = require("../platform/storage");
const { logger } = require("../utils/logger");

interface DbLike {
    query: (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount: number }>;
}

/**
 * Delete a chat attachment object — but ONLY if no live message still uses it.
 *
 * 🔴 WHY THE REFERENCE CHECK EXISTS
 *   Forwarding (POST /messages/:id/forward) copies `file_url` into the new row
 *   instead of duplicating the object, so ONE object can be referenced by N
 *   messages across different conversations. Deleting unconditionally — as this
 *   used to — destroyed the object for every other recipient, including people
 *   who never saw the deleted message. The attachment then 404s forever, and
 *   nothing logs an error because the delete "succeeded".
 *
 *   The check and the delete are not atomic, deliberately: the worst case here
 *   is an orphaned object (harmless, a few KB) whereas deleting live data is
 *   unrecoverable. For the same reason a failed check keeps the object.
 *
 * @param exceptMessageId The message being deleted. Its own row is soft-deleted
 *   by the caller, but pass it explicitly so the check is correct regardless of
 *   statement ordering.
 * @returns true when the object was deleted.
 */
async function deleteChatAttachment(
    fileUrl: string | null | undefined,
    db: DbLike,
    exceptMessageId?: number,
): Promise<boolean> {
    const key = urlToKey(fileUrl);
    if (!key) return false;

    try {
        const stillReferenced = (
            await db.query(
                `SELECT 1 FROM messages
                  WHERE file_url = $1
                    AND deleted_at IS NULL
                    AND ($2::int IS NULL OR id <> $2)
                  LIMIT 1`,
                [fileUrl, exceptMessageId ?? null],
            )
        ).rows[0];

        if (stillReferenced) return false; // a forwarded copy still needs it
    } catch (err) {
        // Fail CLOSED: an unknown reference count must not authorise a delete.
        logger.warn({ err, key }, "Chat attachment reference check failed — keeping object");
        return false;
    }

    try {
        await getStorage().delete(key);
        return true;
    } catch {
        return false; // best-effort: an orphaned object is harmless
    }
}

export { deleteChatAttachment };

/**
 * Deleting a chat message must NOT delete an attachment another message shares.
 *
 * THE BUG THIS LOCKS DOWN
 *   POST /messages/:id/forward copies `file_url` into the new row rather than
 *   duplicating the object (chat.ts). So one R2 object is referenced by N
 *   messages across different conversations. `deleteChatObject()` used to
 *   delete unconditionally, so deleting ANY copy destroyed the object for every
 *   other recipient — including people who never saw the deleted message.
 *
 *   The attachment then 404s forever. Nothing logs an error: the delete
 *   "succeeded".
 *
 * These tests exercise the reference-check contract directly. The route-level
 * suite (chat.routes.test.ts) mocks a fixed query sequence, which makes it a
 * poor fit for asserting a conditional extra query.
 */
export {};

const FILE_URL = "/uploads/tenant_1/org_1/chat/chat_abc123.mp4";
const KEY = "tenant_1/org_1/chat/chat_abc123.mp4";

/**
 * Mirrors deleteChatObject() in routes/chat.ts.
 *
 * Kept in the test rather than exported from the route module because that
 * module pulls in the whole Express app graph (ws, redis, mailer) for what is a
 * self-contained decision. The final describe block asserts the real
 * implementation still matches this contract, so drift is caught.
 */
async function deleteChatObject(
    fileUrl: string | null | undefined,
    db: { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> },
    storage: { delete: (key: string) => Promise<void> },
    urlToKey: (u: string | null | undefined) => string | null,
    onWarn: (err: unknown) => void,
    exceptMessageId?: number,
): Promise<void> {
    const key = urlToKey(fileUrl);
    if (!key) return;

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
        if (stillReferenced) return;
    } catch (err) {
        onWarn(err);
        return;
    }

    try {
        await storage.delete(key);
    } catch {
        /* best-effort */
    }
}

const urlToKey = (u: string | null | undefined) =>
    (u ? String(u).replace(/^\/uploads\//, "") : null);

function harness(rows: any[]) {
    const deleted: string[] = [];
    const warnings: unknown[] = [];
    return {
        deleted,
        warnings,
        db: { query: jest.fn().mockResolvedValue({ rows }) },
        storage: { delete: jest.fn(async (k: string) => { deleted.push(k); }) },
        onWarn: (e: unknown) => warnings.push(e),
    };
}

describe("deleteChatObject reference counting", () => {
    it("KEEPS the object when a forwarded copy still references it", async () => {
        const h = harness([{ "?column?": 1 }]); // another live row matches
        await deleteChatObject(FILE_URL, h.db, h.storage, urlToKey, h.onWarn, 42);
        expect(h.storage.delete).not.toHaveBeenCalled();
        expect(h.deleted).toEqual([]);
    });

    it("DELETES the object when this was the last reference", async () => {
        const h = harness([]);
        await deleteChatObject(FILE_URL, h.db, h.storage, urlToKey, h.onWarn, 42);
        expect(h.storage.delete).toHaveBeenCalledTimes(1);
        expect(h.deleted).toEqual([KEY]);
    });

    it("excludes the message being deleted from the reference check", async () => {
        // Without the exclusion the row being deleted could count as a
        // reference and NOTHING would ever be cleaned up.
        const h = harness([]);
        await deleteChatObject(FILE_URL, h.db, h.storage, urlToKey, h.onWarn, 42);
        const [sql, params] = h.db.query.mock.calls[0];
        expect(sql).toContain("file_url = $1");
        expect(sql).toContain("deleted_at IS NULL");
        expect(sql).toContain("id <> $2");
        expect(params).toEqual([FILE_URL, 42]);
    });

    it("fails CLOSED when the reference check errors", async () => {
        // Deleting on an unknown reference count risks destroying live data;
        // an orphaned object costs a few KB. Keep the object.
        const h = harness([]);
        h.db.query.mockRejectedValueOnce(new Error("connection lost"));
        await deleteChatObject(FILE_URL, h.db, h.storage, urlToKey, h.onWarn, 42);
        expect(h.storage.delete).not.toHaveBeenCalled();
        expect(h.warnings).toHaveLength(1);
    });

    it("does nothing when the message had no attachment", async () => {
        const h = harness([]);
        await deleteChatObject(null, h.db, h.storage, urlToKey, h.onWarn, 42);
        expect(h.db.query).not.toHaveBeenCalled();
        expect(h.storage.delete).not.toHaveBeenCalled();
    });

    it("still deletes when no exceptMessageId is supplied", async () => {
        const h = harness([]);
        await deleteChatObject(FILE_URL, h.db, h.storage, urlToKey, h.onWarn);
        expect(h.db.query.mock.calls[0][1]).toEqual([FILE_URL, null]);
        expect(h.deleted).toEqual([KEY]);
    });
});

describe("the production implementation keeps this contract", () => {
    const fs = require("fs");
    const path = require("path");
    const read = (rel: string) => fs.readFileSync(path.join(__dirname, rel), "utf8");

    it("the service checks references before deleting", () => {
        const src = read("../services/chatAttachments.ts");
        expect(src).toContain("FROM messages");
        expect(src).toContain("deleted_at IS NULL");
        expect(src).toContain("id <> $2");
        // The reference query must precede the delete.
        expect(src.indexOf("SELECT 1")).toBeLessThan(src.indexOf("getStorage().delete"));
    });

    it("the service fails closed when the check throws", () => {
        const src = read("../services/chatAttachments.ts");
        const catchIdx = src.indexOf("catch (err)");
        expect(catchIdx).toBeGreaterThan(-1);
        // The catch must return, never fall through to the delete.
        expect(src.slice(catchIdx, catchIdx + 220)).toContain("return false");
    });

    it("the delete route passes the message id so its own row is excluded", () => {
        expect(read("../modules/chat/chat.message-actions.routes.ts"))
            .toMatch(/deleteChatObject\(\s*msg\.file_url,[\s\S]{0,120}msgId/);
    });

    it("the route delegates to the service rather than deleting directly", () => {
        // GR1: routes must not contain SQL, and the invariant belongs in one
        // place — a second copy of this logic is how the bug would come back.
        const src = read("../modules/chat/chat.shared.ts");
        expect(src).toContain('require("../../services/chatAttachments")');
        expect(src).toMatch(/deleteChatObject\s*=\s*deleteChatAttachment/);
        // The route must not carry its own reference query or delete call.
        expect(src).not.toContain("SELECT 1 FROM messages");
    });
});

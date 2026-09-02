/**
 * Chat reactions/pin/star persistence boundary.
 *
 * This is the only file in this slice that contains SQL. It has no knowledge
 * of Express, Request, Response, cookies or status codes.
 */
import type { ChatDb } from "./chat.types";

export interface MessageRow {
    id: number;
    conversation_id: number;
    sender_id?: number;
    deleted_at: string | null;
    pinned_at?: string | null;
    pinned_by?: number | null;
}

export async function getMessage(db: ChatDb, messageId: number): Promise<MessageRow | undefined> {
    return (
        await db.query(
            "SELECT id, conversation_id, sender_id, deleted_at, pinned_at, pinned_by FROM messages WHERE id = $1",
            [messageId],
        )
    ).rows[0];
}

export async function verifyParticipant(
    db: ChatDb,
    conversationId: number,
    userId: number | undefined,
): Promise<boolean> {
    const result = await db.query(
        "SELECT 1 FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2",
        [conversationId, userId],
    );
    return result.rows.length > 0;
}

export async function getUserDisplayName(db: ChatDb, userId: number): Promise<string> {
    const row = (await db.query("SELECT full_name FROM users WHERE id = $1", [userId])).rows[0];
    return row?.full_name || "";
}

export async function getConversationParticipantIds(db: ChatDb, conversationId: number): Promise<number[]> {
    const rows = (
        await db.query(
            "SELECT user_id FROM conversation_participants WHERE conversation_id = $1",
            [conversationId],
        )
    ).rows;
    return rows.map((r) => r.user_id);
}

// ── Reactions ───────────────────────────────────────────────────────────

export async function findExistingReaction(
    db: ChatDb,
    messageId: number,
    userId: number,
    emoji: string,
): Promise<{ id: number } | undefined> {
    return (
        await db.query(
            "SELECT id FROM message_reactions WHERE message_id = $1 AND user_id = $2 AND emoji = $3",
            [messageId, userId, emoji],
        )
    ).rows[0];
}

export async function deleteReaction(db: ChatDb, reactionId: number): Promise<void> {
    await db.query("DELETE FROM message_reactions WHERE id = $1", [reactionId]);
}

export async function insertReaction(
    db: ChatDb,
    messageId: number,
    userId: number,
    emoji: string,
): Promise<void> {
    await db.query(
        "INSERT INTO message_reactions (message_id, user_id, emoji) VALUES ($1, $2, $3) ON CONFLICT (message_id, user_id, emoji) DO NOTHING",
        [messageId, userId, emoji],
    );
}

// ── Pin ─────────────────────────────────────────────────────────────────

export async function setPinned(
    db: ChatDb,
    messageId: number,
    pinnedBy: number | null,
): Promise<void> {
    if (pinnedBy === null) {
        await db.query(
            "UPDATE messages SET pinned_at = NULL, pinned_by = NULL WHERE id = $1",
            [messageId],
        );
    } else {
        await db.query(
            "UPDATE messages SET pinned_at = NOW(), pinned_by = $1 WHERE id = $2",
            [pinnedBy, messageId],
        );
    }
}

export async function listPinnedMessages(db: ChatDb, conversationId: number) {
    return (
        await db.query(
            `SELECT m.id, m.sender_id, m.content, m.created_at, m.pinned_at, m.pinned_by,
                    m.file_url, m.file_name, m.file_type,
                    u.full_name AS sender_name, u.avatar AS sender_avatar,
                    pb.full_name AS pinned_by_name
             FROM messages m
             JOIN users u ON u.id = m.sender_id
             LEFT JOIN users pb ON pb.id = m.pinned_by
             WHERE m.conversation_id = $1 AND m.pinned_at IS NOT NULL AND m.deleted_at IS NULL
             ORDER BY m.pinned_at DESC`,
            [conversationId],
        )
    ).rows;
}

// ── Star ────────────────────────────────────────────────────────────────

export async function findStarred(
    db: ChatDb,
    userId: number,
    messageId: number,
): Promise<boolean> {
    const row = (
        await db.query(
            "SELECT 1 FROM starred_messages WHERE user_id = $1 AND message_id = $2",
            [userId, messageId],
        )
    ).rows[0];
    return !!row;
}

export async function deleteStar(db: ChatDb, userId: number, messageId: number): Promise<void> {
    await db.query(
        "DELETE FROM starred_messages WHERE user_id = $1 AND message_id = $2",
        [userId, messageId],
    );
}

export async function insertStar(db: ChatDb, userId: number, messageId: number): Promise<void> {
    await db.query(
        "INSERT INTO starred_messages (user_id, message_id) VALUES ($1, $2)",
        [userId, messageId],
    );
}

export async function listStarredMessages(db: ChatDb, userId: number) {
    return (
        await db.query(
            `SELECT m.id, m.conversation_id, m.sender_id, m.content, m.created_at,
                    m.file_url, m.file_name, m.file_type, m.file_size,
                    m.format_type, m.metadata,
                    u.full_name AS sender_name, u.avatar AS sender_avatar,
                    sm.created_at AS starred_at,
                    c.name AS group_name, c.is_group
             FROM starred_messages sm
             JOIN messages m ON m.id = sm.message_id
             JOIN users u ON u.id = m.sender_id
             JOIN conversations c ON c.id = m.conversation_id
             WHERE sm.user_id = $1 AND m.deleted_at IS NULL
             ORDER BY sm.created_at DESC
             LIMIT 100`,
            [userId],
        )
    ).rows;
}

// ── Blocking ────────────────────────────────────────────────────────────

export async function listBlockedUsers(db: ChatDb, blockerId: number) {
    return (
        await db.query(
            `SELECT u.id, u.username, u.full_name, u.avatar, b.created_at AS blocked_at
               FROM blocked_users b
               JOIN users u ON u.id = b.blocked_id
              WHERE b.blocker_id = $1
              ORDER BY u.full_name ASC`,
            [blockerId],
        )
    ).rows;
}

export async function getUserInOrg(
    db: ChatDb,
    userId: number,
    orgId: number | undefined,
): Promise<{ id: number } | undefined> {
    return (
        await db.query("SELECT id FROM users WHERE id = $1 AND org_id = $2", [userId, orgId])
    ).rows[0];
}

export async function getUserOrgId(db: ChatDb, userId: number | undefined): Promise<number | undefined> {
    const row = (await db.query("SELECT org_id FROM users WHERE id = $1", [userId])).rows[0];
    return row?.org_id;
}

export async function insertBlock(db: ChatDb, blockerId: number, blockedId: number): Promise<void> {
    await db.query(
        `INSERT INTO blocked_users (blocker_id, blocked_id)
             VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [blockerId, blockedId],
    );
}

export async function deleteBlock(db: ChatDb, blockerId: number, blockedId: number): Promise<void> {
    await db.query(
        "DELETE FROM blocked_users WHERE blocker_id = $1 AND blocked_id = $2",
        [blockerId, blockedId],
    );
}

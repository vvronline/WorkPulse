/**
 * Chat persistence boundary.
 *
 * This file owns all chat SQL and has no knowledge of Express, Request, Response, cookies, or status codes.
 */
import type { ChatDb, DirectConversationResult } from "./chat.types";



/** SQL statements used by chat service workflows. */
/** SQL statements used by chat service workflows. */
export const sql = {
    q001: "SELECT 1 FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2",
    q002: "SELECT 1 FROM messages WHERE id = $1 AND conversation_id = $2 AND deleted_at IS NULL",
    q003: "SELECT org_id FROM users WHERE id = $1",
    q004: "INSERT INTO messages (conversation_id, sender_id, content, format_type, metadata) VALUES ($1, $2, $3, 'system', $4) RETURNING id, created_at",
    q005: "UPDATE conversations SET updated_at = NOW() WHERE id = $1",
    q006: "SELECT user_id FROM conversation_participants WHERE conversation_id = $1",
    q007: "SELECT id, username, full_name, email, avatar, last_seen_at FROM users WHERE org_id = $1 AND is_active = TRUE AND hidden_from_directory = FALSE AND (username ILIKE $2 OR full_name ILIKE $2 OR email ILIKE $2) ORDER BY CASE WHEN id = $3 THEN 0 ELSE 1 END, full_name ASC LIMIT 20",
    q008: "SELECT id FROM users WHERE id = ANY($1) AND org_id = $2",
    q009: "SELECT user_id, entry_type, work_mode FROM time_entries WHERE user_id = ANY($1) AND (timestamp + $2::interval)::date = $3::date AND (approval_status IS NULL OR approval_status != 'rejected') ORDER BY user_id ASC, timestamp ASC, id ASC",
    q010: "SELECT * FROM conversations WHERE id = $1 AND is_group = TRUE",
    q011: "SELECT full_name FROM users WHERE id = $1",
    q012: "UPDATE conversations SET name = $1 WHERE id = $2",
    q013: "UPDATE conversations SET description = $1 WHERE id = $2",
    q014: "UPDATE conversations SET avatar = $1 WHERE id = $2",
    q015: "UPDATE conversations SET post_policy = $1 WHERE id = $2",
    q016: "UPDATE conversations SET add_policy = $1 WHERE id = $2",
    q017: "SELECT id, full_name FROM users WHERE id = ANY($1) AND org_id = $2 AND is_active = TRUE",
    q018: "INSERT INTO conversation_participants (conversation_id, user_id, role) VALUES ($1, $2, 'member') ON CONFLICT DO NOTHING",
    q019: "SELECT u.id, u.full_name, cp.role FROM users u JOIN conversation_participants cp ON cp.user_id = u.id AND cp.conversation_id = $3 WHERE u.id = ANY($1) AND u.org_id = $2",
    q020: "DELETE FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2",
    q021: "SELECT id, is_group FROM conversations WHERE id = $1",
    q022: "SELECT role FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2",
    q023: "SELECT user_id FROM conversation_participants WHERE conversation_id = $1 AND user_id <> $2 ORDER BY (role = 'admin') DESC, user_id ASC LIMIT 1",
    q024: "UPDATE conversation_participants SET role = 'owner' WHERE conversation_id = $1 AND user_id = $2",
    q025: "UPDATE conversations SET created_by = $1 WHERE id = $2",
    q026: "SELECT cp.role, u.full_name FROM conversation_participants cp JOIN users u ON u.id = cp.user_id WHERE cp.conversation_id = $1 AND cp.user_id = $2",
    q027: "UPDATE conversation_participants SET role = $1 WHERE conversation_id = $2 AND user_id = $3",
    q028: "SELECT u.full_name FROM conversation_participants cp JOIN users u ON u.id = cp.user_id WHERE cp.conversation_id = $1 AND cp.user_id = $2",
    q029: "UPDATE conversation_participants SET role = 'admin' WHERE conversation_id = $1 AND user_id = $2",
    q030: `SELECT
        c.id,
        c.updated_at,
        c.name AS group_name,
        c.is_group,
        c.description AS group_description,
        c.avatar AS group_avatar,
        c.post_policy,
        c.add_policy,
        cp.role AS my_role,
        CASE WHEN c.is_group = FALSE THEN COALESCE(u.id, self_u.id) END AS other_user_id,
        CASE WHEN c.is_group = FALSE THEN COALESCE(u.username, self_u.username) END AS other_username,
        CASE WHEN c.is_group = FALSE THEN COALESCE(u.full_name, self_u.full_name) END AS other_full_name,
        CASE WHEN c.is_group = FALSE THEN COALESCE(u.avatar, self_u.avatar) END AS other_avatar,
        CASE WHEN c.is_group = FALSE THEN COALESCE(u.last_seen_at, self_u.last_seen_at) END AS other_last_seen,
        CASE WHEN c.is_group = FALSE AND u.id IS NULL THEN TRUE ELSE FALSE END AS is_self_chat,
        m.content AS last_message, m.sender_id AS last_sender_id, m.sender_name AS last_sender_name,
        m.created_at AS last_message_at, m.file_url AS last_file_url, m.file_type AS last_file_type,
        m.file_name AS last_file_name, m.deleted_at AS last_deleted, m.format_type AS last_format_type,
        m.metadata AS last_metadata,
        (SELECT EXISTS (
            SELECT 1 FROM message_reads mr2 JOIN users ur ON ur.id = mr2.user_id
            WHERE mr2.conversation_id = c.id AND mr2.user_id != $1 AND mr2.last_read_at >= m.created_at
              AND COALESCE((ur.notification_prefs->>'readReceipts')::boolean, TRUE)
        ) AND COALESCE((SELECT (notification_prefs->>'readReceipts')::boolean FROM users WHERE id = $1), TRUE)) AS last_message_read,
        COALESCE(jsonb_array_length(m.delivered_to), 0) > 0 AS last_message_delivered,
        COALESCE(mr.last_read_at, '1970-01-01'::timestamptz) AS last_read_at,
        (SELECT COUNT(*)::int FROM messages msg WHERE msg.conversation_id = c.id
          AND msg.created_at > COALESCE(mr.last_read_at, '1970-01-01'::timestamptz)
          AND msg.sender_id != $1 AND msg.deleted_at IS NULL) AS unread_count,
        CASE WHEN c.is_group THEN (SELECT COUNT(*)::int FROM conversation_participants WHERE conversation_id = c.id) END AS member_count,
        CASE WHEN c.is_group THEN (
            SELECT COALESCE(json_agg(x.avatar) FILTER (WHERE x.avatar IS NOT NULL), '[]'::json)
            FROM (SELECT u3.avatar FROM conversation_participants cp3 JOIN users u3 ON u3.id = cp3.user_id
                  WHERE cp3.conversation_id = c.id ORDER BY cp3.user_id ASC LIMIT 4) x
        ) END AS group_member_avatars,
        cp.is_pinned, cp.is_favourite,
        (cp.is_muted AND (cp.muted_until IS NULL OR cp.muted_until > NOW())) AS is_muted,
        cp.muted_until, cp.is_archived,
        CASE WHEN c.is_group = FALSE AND u.id IS NOT NULL THEN
            EXISTS (SELECT 1 FROM blocked_users b WHERE b.blocker_id = $1 AND b.blocked_id = u.id)
        ELSE FALSE END AS is_blocked,
        CASE WHEN mtg.id IS NOT NULL THEN TRUE ELSE FALSE END AS is_meeting_chat,
        mtg.meeting_code
    FROM conversations c
    JOIN conversation_participants cp ON cp.conversation_id = c.id AND cp.user_id = $1
    LEFT JOIN conversation_participants cp2 ON cp2.conversation_id = c.id AND cp2.user_id != $1 AND c.is_group = FALSE
    LEFT JOIN users u ON u.id = cp2.user_id AND c.is_group = FALSE
    LEFT JOIN users self_u ON self_u.id = $1 AND c.is_group = FALSE AND cp2.user_id IS NULL
    LEFT JOIN meetings mtg ON mtg.conversation_id = c.id AND mtg.is_huddle = FALSE
    LEFT JOIN LATERAL (
        SELECT lm.content, lm.sender_id, lm.created_at, lm.file_url, lm.file_type, lm.file_name,
               lm.deleted_at, lm.format_type, lm.metadata, lm.delivered_to, usr.full_name AS sender_name
        FROM messages lm JOIN users usr ON usr.id = lm.sender_id
        WHERE lm.conversation_id = c.id ORDER BY lm.created_at DESC LIMIT 1
    ) m ON TRUE
    LEFT JOIN message_reads mr ON mr.conversation_id = c.id AND mr.user_id = $1
    ORDER BY cp.is_pinned DESC, COALESCE(m.created_at, c.created_at) DESC
    LIMIT 200`,    q031: "SELECT mr.message_id, mr.emoji, mr.user_id, u.full_name FROM message_reactions mr JOIN users u ON u.id = mr.user_id JOIN messages m ON m.id = mr.message_id WHERE mr.message_id = ANY($1) AND m.deleted_at IS NULL ORDER BY mr.created_at",
    q032: "INSERT INTO message_reads (conversation_id, user_id, last_read_at) VALUES ($1, $2, NOW()) ON CONFLICT (conversation_id, user_id) DO UPDATE SET last_read_at = NOW()",
    q033: "SELECT user_id FROM conversation_participants WHERE conversation_id = $1 AND user_id != $2",
    q034: "WITH me AS ( SELECT COALESCE((notification_prefs->>'readReceipts')::boolean, TRUE) AS receipts_on FROM users WHERE id = $2 ) SELECT mr.user_id, mr.last_read_at, u.full_name FROM message_reads mr JOIN users u ON u.id = mr.user_id CROSS JOIN me WHERE mr.conversation_id = $1 AND mr.user_id != $2 AND me.receipts_on AND COALESCE((u.notification_prefs->>'readReceipts')::boolean, TRUE)",
    q035: "SELECT is_group, name AS group_name FROM conversations WHERE id = $1",
    q036: "SELECT 1 FROM blocked_users b JOIN conversation_participants cp ON cp.conversation_id = $1 AND cp.user_id != $2 WHERE (b.blocker_id = $2 AND b.blocked_id = cp.user_id) OR (b.blocker_id = cp.user_id AND b.blocked_id = $2) LIMIT 1",
    q037: "INSERT INTO messages (conversation_id, sender_id, content, reply_to_id) VALUES ($1, $2, $3, $4) RETURNING id, created_at",
    q038: "INSERT INTO message_reads (conversation_id, user_id, last_read_at) VALUES ($1, $2, $3) ON CONFLICT (conversation_id, user_id) DO UPDATE SET last_read_at = $3",
    q039: "SELECT full_name, avatar, username FROM users WHERE id = $1",
    q040: "SELECT m.content, m.file_url, m.file_type, m.file_name, u.full_name AS sender_name FROM messages m JOIN users u ON u.id = m.sender_id WHERE m.id = $1 AND m.conversation_id = $2",
    q041: "SELECT COUNT(*)::int AS unread FROM messages m JOIN conversation_participants cp ON cp.conversation_id = m.conversation_id AND cp.user_id = $1 LEFT JOIN message_reads mr ON mr.conversation_id = m.conversation_id AND mr.user_id = $1 WHERE m.sender_id <> $1 AND (mr.last_read_at IS NULL OR m.created_at > mr.last_read_at)",
    q042: "INSERT INTO messages (conversation_id, sender_id, content, file_url, file_name, file_type, file_size, reply_to_id, metadata) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id, created_at",
    q043: "INSERT INTO chat_media_jobs (message_id, conversation_id, sender_id, status, stage, progress, attempts, pipeline_meta) VALUES ($1, $2, $3, 'queued', 'queued', 0, 1, '{}'::jsonb) RETURNING id, status, stage, progress, pipeline_meta",
    q044: "SELECT id, message_id, conversation_id, sender_id, status FROM chat_media_jobs WHERE id = $1",
    q045: "UPDATE chat_media_jobs SET cancel_requested = TRUE, status = 'cancelled', stage = 'cancelled', progress = 0, failure_reason = 'cancelled-by-user', updated_at = NOW() WHERE id = $1",
    q046: "SELECT id, message_id, conversation_id, sender_id, status, attempts FROM chat_media_jobs WHERE id = $1",
    q047: "UPDATE chat_media_jobs SET status = 'queued', stage = 'queued', progress = 0, failure_reason = NULL, cancel_requested = FALSE, attempts = COALESCE(attempts, 0) + 1, updated_at = NOW() WHERE id = $1",
    q048: "SELECT * FROM messages WHERE id = $1",
    q049: "UPDATE messages SET content = $1, edited_at = NOW() WHERE id = $2",
    q050: "UPDATE messages SET deleted_at = NOW(), content = NULL, file_url = NULL, file_name = NULL, file_type = NULL, file_size = NULL WHERE id = $1",
    q051: "DELETE FROM message_reactions WHERE message_id = $1",
    q052: "SELECT * FROM messages WHERE id = $1 AND deleted_at IS NULL",
    q053: "INSERT INTO messages (conversation_id, sender_id, content, file_url, file_name, file_type, file_size, forwarded_from_id, metadata) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id, created_at",
    q054: "INSERT INTO message_reads (conversation_id, user_id, last_read_at) VALUES ($1, $2, $3) ON CONFLICT (conversation_id, user_id) DO UPDATE SET last_read_at = $3",
    q055: "INSERT INTO polls (conversation_id, creator_id, question, options, multi_select) VALUES ($1, $2, $3, $4, $5) RETURNING *",
    q056: "INSERT INTO messages (conversation_id, sender_id, content, format_type, metadata) VALUES ($1, $2, $3, 'poll', $4) RETURNING id, created_at",
    q057: "SELECT * FROM polls WHERE id = $1",
    q058: "SELECT id FROM poll_votes WHERE poll_id = $1 AND user_id = $2 AND option_idx = $3",
    q059: "DELETE FROM poll_votes WHERE id = $1",
    q060: "DELETE FROM poll_votes WHERE poll_id = $1 AND user_id = $2",
    q061: "INSERT INTO poll_votes (poll_id, user_id, option_idx) VALUES ($1, $2, $3)",
    q062: "SELECT option_idx, array_agg(user_id) AS user_ids FROM poll_votes WHERE poll_id = $1 GROUP BY option_idx",
    q063: "SELECT pv.option_idx, pv.user_id, u.full_name FROM poll_votes pv JOIN users u ON u.id = pv.user_id WHERE pv.poll_id = $1",
    q064: "SELECT m.id, m.file_url, m.file_name, m.file_type, m.file_size, m.created_at, m.sender_id, u.full_name AS sender_name, u.avatar AS sender_avatar FROM messages m JOIN users u ON u.id = m.sender_id WHERE m.conversation_id = $1 AND m.file_url IS NOT NULL AND m.deleted_at IS NULL ORDER BY m.created_at DESC LIMIT 100",
    q065: "SELECT created_at FROM messages WHERE conversation_id = $1 AND sender_id != $2 AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1",
    q066: "INSERT INTO message_reads (conversation_id, user_id, last_read_at) VALUES ($1, $2, $3::timestamptz - INTERVAL '1 second') ON CONFLICT (conversation_id, user_id) DO UPDATE SET last_read_at = $3::timestamptz - INTERVAL '1 second'",
    q067: "SELECT is_group, created_by FROM conversations WHERE id = $1",
    q068: "DELETE FROM messages WHERE conversation_id = $1",
    q069: "DELETE FROM conversations WHERE id = $1",
    q070: "SELECT m.conversation_id FROM messages m JOIN conversation_participants cp ON cp.conversation_id = m.conversation_id AND cp.user_id = $1 WHERE m.id = $2",
    q071: "UPDATE messages SET delivered_to = delivered_to || $1::jsonb WHERE id = $2 AND NOT delivered_to @> $1::jsonb",
    q072: "SELECT id, conversation_id, sender_id, file_url, metadata FROM messages WHERE id = $1 AND deleted_at IS NULL",
    q073: "UPDATE messages SET metadata = jsonb_set( COALESCE(metadata, '{}'::jsonb), '{viewedBy}', COALESCE(metadata->'viewedBy', '[]'::jsonb) || to_jsonb($2::int), true ) WHERE id = $1 AND COALESCE((metadata->>'viewOnce')::boolean, false) = true AND NOT ( COALESCE(metadata->'viewedBy', '[]'::jsonb) @> to_jsonb(ARRAY[$2::int]) ) RETURNING file_url",
    q074: "SELECT sub.*, COUNT(*) OVER()::int AS total_count FROM ( SELECT DISTINCT ON (cl.id) cl.id, cl.conversation_id, cl.caller_id, cl.call_type, cl.status, cl.started_at, cl.ended_at, cl.duration, cl.created_at, caller.full_name AS caller_name, caller.avatar AS caller_avatar, other_u.id AS other_user_id, other_u.full_name AS other_name, other_u.avatar AS other_avatar, c.is_group, c.name AS group_name FROM call_logs cl JOIN conversations c ON c.id = cl.conversation_id JOIN users caller ON caller.id = cl.caller_id JOIN conversation_participants cp_me ON cp_me.conversation_id = cl.conversation_id AND cp_me.user_id = $1 LEFT JOIN LATERAL ( SELECT u.id, u.full_name, u.avatar FROM conversation_participants cp2 JOIN users u ON u.id = cp2.user_id WHERE cp2.conversation_id = cl.conversation_id AND cp2.user_id != $1 AND NOT c.is_group LIMIT 1 ) other_u ON true ORDER BY cl.id, cl.created_at DESC ) sub ORDER BY created_at DESC LIMIT 100",
    q075: "DELETE FROM call_logs cl WHERE EXISTS ( SELECT 1 FROM conversation_participants cp WHERE cp.conversation_id = cl.conversation_id AND cp.user_id = $1 )",
    q076: "DELETE FROM call_logs cl WHERE cl.id = ANY($1::int[]) AND EXISTS ( SELECT 1 FROM conversation_participants cp WHERE cp.conversation_id = cl.conversation_id AND cp.user_id = $2 )",
    q077: "SELECT cl.id, cl.conversation_id, cl.caller_id, cl.call_type, cl.status, cl.started_at, caller.full_name AS caller_name, caller.avatar AS caller_avatar, c.is_group, c.name AS group_name, other_u.id AS other_user_id, other_u.full_name AS other_name, other_u.avatar AS other_avatar FROM call_logs cl JOIN conversations c ON c.id = cl.conversation_id JOIN users caller ON caller.id = cl.caller_id JOIN conversation_participants cp_me ON cp_me.conversation_id = cl.conversation_id AND cp_me.user_id = $1 LEFT JOIN LATERAL ( SELECT u.id, u.full_name, u.avatar FROM conversation_participants cp2 JOIN users u ON u.id = cp2.user_id WHERE cp2.conversation_id = cl.conversation_id AND cp2.user_id != $1 AND NOT c.is_group LIMIT 1 ) other_u ON true WHERE cl.status = 'answered' AND EXISTS ( SELECT 1 FROM user_presence_sessions ups WHERE ups.activity = 'in_call' AND ups.activity_ref_id = cl.id AND ups.disconnected_at IS NULL ) ORDER BY cl.started_at DESC LIMIT 1",
    q078: "SELECT cl.id, cl.caller_id, cl.call_type, cl.status, cl.started_at, cl.ended_at, cl.duration, cl.created_at, u.full_name AS caller_name, u.avatar AS caller_avatar FROM call_logs cl JOIN users u ON u.id = cl.caller_id WHERE cl.conversation_id = $1 ORDER BY cl.created_at DESC LIMIT 50",
    q079: "SELECT * FROM call_logs WHERE id = $1 AND conversation_id = $2",
    q080: "UPDATE call_logs SET status = 'declined', ended_at = NOW() WHERE id = $1 AND status = 'ringing' RETURNING id",
    q081: "UPDATE call_logs SET status = 'answered', started_at = NOW() WHERE id = $1 AND status = 'ringing' RETURNING id",
    q082: "SELECT full_name, avatar FROM users WHERE id = $1",
    q083: "UPDATE call_logs SET status = CASE WHEN status = 'ringing' THEN 'missed' ELSE 'ended' END, ended_at = NOW(), duration = $2 WHERE id = $1 RETURNING id",
    q084: "SELECT m.id, m.sender_id, m.content, m.created_at, m.reply_to_id, m.file_url, m.file_name, m.file_type, m.file_size, m.edited_at, m.deleted_at, m.forwarded_from_id, m.pinned_at, m.pinned_by, m.link_preview, m.format_type, m.metadata, m.delivered_to, cmj.id AS media_job_id, cmj.status AS media_state, cmj.stage AS media_stage, cmj.progress AS media_progress, cmj.failure_reason AS media_failure_reason, cmj.pipeline_meta AS media_pipeline_meta, u.full_name AS sender_name, u.avatar AS sender_avatar, u.username AS sender_username, rm.content AS reply_content, rm.sender_id AS reply_sender_id, ru.full_name AS reply_sender_name, rm.file_url AS reply_file_url, rm.file_type AS reply_file_type, rm.file_name AS reply_file_name, CASE WHEN sm.message_id IS NOT NULL THEN true ELSE false END AS starred FROM messages m JOIN users u ON u.id = m.sender_id LEFT JOIN chat_media_jobs cmj ON cmj.message_id = m.id LEFT JOIN messages rm ON rm.id = m.reply_to_id AND rm.conversation_id = m.conversation_id LEFT JOIN users ru ON ru.id = rm.sender_id LEFT JOIN starred_messages sm ON sm.message_id = m.id AND sm.user_id = $1 WHERE m.conversation_id = $2",
    q085: "SELECT m.id, m.conversation_id, m.sender_id, m.content, m.created_at, m.file_url, m.file_name, u.full_name AS sender_name, u.avatar AS sender_avatar FROM messages m JOIN users u ON u.id = m.sender_id WHERE m.conversation_id = $1 AND m.deleted_at IS NULL AND COALESCE(m.content, '') ILIKE $2 ORDER BY m.created_at DESC LIMIT 50",
    q086: "SELECT m.id, m.conversation_id, m.sender_id, m.content, m.created_at, m.file_url, m.file_name, u.full_name AS sender_name, u.avatar AS sender_avatar, c.name AS group_name, c.is_group FROM messages m JOIN users u ON u.id = m.sender_id JOIN conversations c ON c.id = m.conversation_id JOIN conversation_participants cp ON cp.conversation_id = c.id AND cp.user_id = $1 WHERE m.deleted_at IS NULL AND COALESCE(m.content, '') ILIKE $2 ORDER BY m.created_at DESC LIMIT 50",
    q087: " AND m.id < $",
    q088: " ORDER BY m.created_at DESC LIMIT $",
} as const;

/** Executes a statement owned by this persistence boundary. */
export function query(db: Pick<ChatDb, "query">, statement: string, params?: unknown[]) {
    return db.query(statement, params);
}

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

// ── Direct conversations ──────────────────────────────────────────────────

export async function getActiveUser(db: ChatDb, userId: number): Promise<{ id: number; org_id: number } | undefined> {
    return (await db.query(
        "SELECT id, org_id FROM users WHERE id = $1 AND is_active = TRUE",
        [userId],
    )).rows[0];
}

export async function getActiveUsers(
    db: ChatDb,
    userIds: number[],
): Promise<Array<{ id: number; org_id: number | null }>> {
    return (await db.query(
        "SELECT id, org_id FROM users WHERE id = ANY($1) AND is_active = TRUE",
        [userIds],
    )).rows;
}

export async function getUsersInOrg(db: ChatDb, userIds: number[], orgId: number) {
    return (await db.query(
        "SELECT id FROM users WHERE id = ANY($1) AND org_id = $2 AND is_active = TRUE",
        [userIds, orgId],
    )).rows;
}

async function transaction<T>(db: ChatDb, fn: (client: ChatDb) => Promise<T>): Promise<T> {
    if (!db.transaction) throw new Error("Database transaction support is required");
    return db.transaction(fn);
}

export async function findOrCreateSelfConversation(
    db: ChatDb,
    userId: number,
    orgId: number,
): Promise<DirectConversationResult> {
    return transaction(db, async (client) => {
        const existing = (await client.query(
            `SELECT cp.conversation_id
             FROM conversation_participants cp
             JOIN conversations c ON c.id = cp.conversation_id
             WHERE cp.user_id = $1
               AND c.is_group = FALSE
               AND (SELECT COUNT(*) FROM conversation_participants WHERE conversation_id = cp.conversation_id) = 1
             LIMIT 1
             FOR UPDATE`,
            [userId],
        )).rows[0];
        if (existing) return { id: existing.conversation_id, existed: true };

        const conversation = (await client.query(
            "INSERT INTO conversations (org_id) VALUES ($1) RETURNING id",
            [orgId],
        )).rows[0];
        await client.query(
            "INSERT INTO conversation_participants (conversation_id, user_id) VALUES ($1, $2)",
            [conversation.id, userId],
        );
        return conversation;
    });
}

export async function findOrCreateDirectConversation(
    db: ChatDb,
    userId: number,
    otherUserId: number,
    orgId: number,
): Promise<DirectConversationResult> {
    return transaction(db, async (client) => {
        const existing = (await client.query(
            `SELECT cp1.conversation_id
             FROM conversation_participants cp1
             JOIN conversation_participants cp2 ON cp1.conversation_id = cp2.conversation_id
             JOIN conversations c ON c.id = cp1.conversation_id
             WHERE cp1.user_id = $1 AND cp2.user_id = $2
               AND c.is_group = FALSE
               AND (SELECT COUNT(*) FROM conversation_participants WHERE conversation_id = cp1.conversation_id) >= 2
             LIMIT 1
             FOR UPDATE`,
            [userId, otherUserId],
        )).rows[0];
        if (existing) {
            await client.query(
                `DELETE FROM conversation_participants
                 WHERE conversation_id = $1 AND user_id NOT IN ($2, $3)`,
                [existing.conversation_id, userId, otherUserId],
            );
            return { id: existing.conversation_id, existed: true };
        }

        const conversation = (await client.query(
            "INSERT INTO conversations (org_id) VALUES ($1) RETURNING id",
            [orgId],
        )).rows[0];
        await client.query(
            "INSERT INTO conversation_participants (conversation_id, user_id) VALUES ($1, $2), ($1, $3)",
            [conversation.id, userId, otherUserId],
        );
        return conversation;
    });
}

export async function createGroupConversation(
    db: ChatDb,
    orgId: number,
    name: string,
    creatorId: number,
    userIds: number[],
): Promise<{ id: number }> {
    return transaction(db, async (client) => {
        const conversation = (await client.query(
            "INSERT INTO conversations (org_id, name, is_group, created_by) VALUES ($1, $2, TRUE, $3) RETURNING id",
            [orgId, name, creatorId],
        )).rows[0];
        for (const userId of userIds) {
            await client.query(
                `INSERT INTO conversation_participants (conversation_id, user_id, role)
                 VALUES ($1, $2, $3)`,
                [conversation.id, userId, userId === creatorId ? "owner" : "member"],
            );
        }
        return conversation;
    });
}

export async function listConversationMembers(db: ChatDb, conversationId: number) {
    return (await db.query(
        `SELECT u.id, u.username, u.full_name, u.avatar, u.last_seen_at,
                cp.role
         FROM conversation_participants cp
         JOIN users u ON u.id = cp.user_id
         WHERE cp.conversation_id = $1
         ORDER BY
             CASE cp.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END,
             u.full_name`,
        [conversationId],
    )).rows;
}

export async function toggleConversationPin(db: ChatDb, conversationId: number, userId: number) {
    return (await db.query(
        `UPDATE conversation_participants SET is_pinned = NOT is_pinned
         WHERE conversation_id = $1 AND user_id = $2
         RETURNING is_pinned`,
        [conversationId, userId],
    )).rows[0].is_pinned;
}

export async function toggleConversationFavourite(db: ChatDb, conversationId: number, userId: number) {
    return (await db.query(
        `UPDATE conversation_participants SET is_favourite = NOT is_favourite
         WHERE conversation_id = $1 AND user_id = $2
         RETURNING is_favourite`,
        [conversationId, userId],
    )).rows[0].is_favourite;
}

export interface ConversationMuteState {
    is_muted: boolean;
    muted_until: string | null;
}

export async function setConversationMute(
    db: ChatDb,
    conversationId: number,
    userId: number,
    mode: "toggle" | "unmute" | "always" | "until",
    mutedUntil?: string,
): Promise<ConversationMuteState> {
    if (mode === "toggle") {
        return (await db.query(
            `UPDATE conversation_participants
                SET is_muted = NOT (is_muted AND (muted_until IS NULL OR muted_until > NOW())),
                    muted_until = NULL
              WHERE conversation_id = $1 AND user_id = $2
              RETURNING is_muted, muted_until`,
            [conversationId, userId],
        )).rows[0];
    }

    if (mode === "unmute") {
        return (await db.query(
            `UPDATE conversation_participants
                SET is_muted = FALSE, muted_until = NULL
              WHERE conversation_id = $1 AND user_id = $2
              RETURNING is_muted, muted_until`,
            [conversationId, userId],
        )).rows[0];
    }

    if (mode === "always") {
        return (await db.query(
            `UPDATE conversation_participants
                SET is_muted = TRUE, muted_until = NULL
              WHERE conversation_id = $1 AND user_id = $2
              RETURNING is_muted, muted_until`,
            [conversationId, userId],
        )).rows[0];
    }
    return (await db.query(
        `UPDATE conversation_participants
            SET is_muted = TRUE, muted_until = $3
          WHERE conversation_id = $1 AND user_id = $2
          RETURNING is_muted, muted_until`,
        [conversationId, userId, mutedUntil],
    )).rows[0];
}

export async function toggleConversationArchive(db: ChatDb, conversationId: number, userId: number) {
    return (await db.query(
        `UPDATE conversation_participants SET is_archived = NOT is_archived
         WHERE conversation_id = $1 AND user_id = $2
         RETURNING is_archived`,
        [conversationId, userId],
    )).rows[0].is_archived;
}

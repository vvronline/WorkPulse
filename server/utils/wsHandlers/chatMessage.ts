/**
 * Extracted handler — `chat_message` (Phase 6 part 2 / ADR-009).
 *
 * Why this is the first one extracted
 * ───────────────────────────────────
 * `chat_message` is the single biggest handler in `handleChatMessage`
 * (~70 LoC of inline validation, persistence, fan-out, mention handling
 * and read-cursor updates). It also has the most demanding contract:
 *   • 5 different input shapes (text, reply, mention, code-block, markdown)
 *   • 4 separate DB writes per call (messages insert, conv touch,
 *     message_reads upsert, optional notifications row)
 *   • multi-step fan-out (broadcast + unread-bump + mention-broadcast)
 *
 * Splitting it off:
 *   1. Replaces the inline ad-hoc validation with a single typed schema
 *      check (`wsValidate.schema` + `wsValidate.validate`). Garbage
 *      input now lands here with a structured error reply instead of
 *      being silently swallowed.
 *   2. Gives the handler its own file that can be unit-tested in
 *      isolation — the previous test path was "spin up the whole
 *      WS server and send a frame", which is why the chat handler
 *      had ~0 unit-test coverage.
 *   3. Establishes the directory layout (`server/utils/wsHandlers/`)
 *      that subsequent handler extractions slot into.
 *
 * The handler keeps its public contract identical — same outgoing
 * events, same DB writes, same dedupe semantics. This is a pure
 * refactor at runtime; the only behavioural change is that bad input
 * now produces a typed `chat_message_error` ack instead of silent drop.
 */

import { logger } from "../logger";
import { schema, validate } from "../wsValidate";
import { pushNotifications } from "../../services/pushNotifications";
const redis = require("../../redis");

type Query = (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount?: number }>;

interface DbLike {
    query: Query;
}

interface WSLike {
    readyState: number;
    send: (data: string) => void;
    [key: string]: unknown;
}

type SendToUser = (tenantId: number | null, userId: number, type: string, data: unknown) => void;

interface ChatMessageArgs {
    db: DbLike;
    senderId: number;
    tenantId: number | null;
    data: Record<string, unknown> | null | undefined;
    ws: WSLike;
    sendToUser: SendToUser;
}

/**
 * Schema describing the wire format of an incoming `chat_message`.
 * Lives next to the handler so the contract + the implementation
 * always change together.
 */
const chatMessageSchema = {
    conversationId: schema.posInt(),
    content: schema.str({ min: 1, max: 5_000 }),
    replyToId: schema.posInt({ optional: true }),
    // 'text' (default), 'markdown', 'code'
    formatType: schema.str({ max: 16, optional: true }),
    clientMsgId: schema.str({ max: 64, optional: true }),
    // `mentions` arrives as an array of user ids — we don't yet have a
    // schema.arr() helper, so this is validated below by hand and the
    // schema just confirms it's present (optional).
};

/**
 * Defense-in-depth: reject blatant injection patterns.
 * We already escape on render, but rejecting at ingestion keeps the
 * DB clean of obviously hostile rows and gives the perpetrator a 4xx
 * (via the error ack) instead of letting them try again indefinitely.
 */
const INJECTION_RE = /<script[\s>]|javascript:|on\w+\s*=/i;

/**
 * sendErrorAck — surfaces a structured `chat_message_error` on the
 * sender's own WS connection. Mirrors the chat-message `meeting_message_error`
 * convention so the client's pending-send queue can mark the optimistic
 * bubble as `_failed` and offer a retry.
 *
 * Optional `clientMsgId` so the receiver can correlate the error with the
 * exact in-flight bubble; absent for messages that were rejected before we
 * even parsed an id (malformed JSON, missing conversationId, etc).
 */
function sendErrorAck(ws: WSLike | null | undefined, clientMsgId: unknown, reason: string): void {
    if (!ws || ws.readyState !== 1) return;
    try {
        ws.send(JSON.stringify({
            type: "chat_message_error",
            data: { clientMsgId: clientMsgId || null, reason },
        }));
    } catch { /* ignore */ }
}

/**
 * Compute a user's TOTAL unread message count across every conversation they
 * participate in. Used to populate the push badge count so the launcher / app
 * icon shows the true number (e.g. "3"), not a per-message "1".
 *
 * Counts messages newer than the user's per-conversation read cursor
 * (`message_reads.last_read_at`); conversations the user has never opened count
 * ALL messages from others. Sender's own messages are excluded. Best-effort: on
 * any error the caller falls back to the default badge of 1.
 */
async function getTotalUnread(db: DbLike, userId: number): Promise<number> {
    const row = (await db.query(
        `SELECT COUNT(*)::int AS unread
           FROM messages m
           JOIN conversation_participants cp
             ON cp.conversation_id = m.conversation_id
            AND cp.user_id = $1
           LEFT JOIN message_reads mr
             ON mr.conversation_id = m.conversation_id
            AND mr.user_id = $1
          WHERE m.sender_id <> $1
            AND (mr.last_read_at IS NULL OR m.created_at > mr.last_read_at)`,
        [userId],
    )).rows[0];
    return row?.unread ?? 0;
}

/**
 * The handler proper. Signature mirrors the call-site in
 * `handleChatMessage` so adoption is a direct replacement.
 *
 *   db        — tenant pool / master pool (whatever the caller has)
 *   senderId  — authenticated user id (already verified upstream)
 *   tenantId  — for sendToUser fan-out + unread keys
 *   data      — raw msg.data from the WebSocket frame
 *   ws        — the sender's WS connection (for the error ack)
 *   sendToUser— injected so the handler doesn't import the WS module
 *               (avoids the circular dep ws.js ↔ wsHandlers/*)
 */
async function chatMessage({ db, senderId, tenantId, data, ws, sendToUser }: ChatMessageArgs): Promise<void> {
    // ── 1. Schema check ────────────────────────────────────────────────
    const parsed = validate(chatMessageSchema, data);
    if (!parsed.ok) {
        const firstField = Object.keys(parsed.errors)[0];
        const reason = `validation:${firstField}=${parsed.errors[firstField]}`;
        sendErrorAck(ws, data && data.clientMsgId, reason);
        return;
    }
    const { conversationId, content, replyToId, formatType, clientMsgId } = parsed.value as {
        conversationId: number;
        content: string;
        replyToId?: number;
        formatType?: string;
        clientMsgId?: string;
    };
    // mentions: validated by hand (no array schema yet)
    const rawMentions: unknown[] = Array.isArray(data?.mentions) ? (data!.mentions as unknown[]) : [];

    // Defense-in-depth XSS gate.
    if (INJECTION_RE.test(content)) {
        logger.warn({ senderId, conversationId }, "chat_message: rejected content with script-like pattern");
        sendErrorAck(ws, clientMsgId, "unsafe-content");
        return;
    }

    // ── 2. Authorisation: sender must be in the conversation ───────────
    const participant = (await db.query(
        "SELECT 1 FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2",
        [conversationId, senderId],
    )).rows[0];
    if (!participant) {
        sendErrorAck(ws, clientMsgId, "not-a-participant");
        return;
    }

    // ── 3. Insert + bump conversation timestamp + update read cursor ───
    const fmtType = (formatType === "markdown" || formatType === "code") ? formatType : "text";
    const result = (await db.query(
        `INSERT INTO messages (conversation_id, sender_id, content, reply_to_id, format_type)
         VALUES ($1, $2, $3, $4, $5) RETURNING id, created_at`,
        [conversationId, senderId, content.trim(), replyToId || null, fmtType],
    )).rows[0];

    await db.query("UPDATE conversations SET updated_at = NOW() WHERE id = $1", [conversationId]);
    await db.query(
        `INSERT INTO message_reads (conversation_id, user_id, last_read_at)
         VALUES ($1, $2, $3)
         ON CONFLICT (conversation_id, user_id) DO UPDATE SET last_read_at = $3`,
        [conversationId, senderId, result.created_at],
    );

    // ── 4. Gather fan-out audience + sender meta + reply context ───────
    const [participantsResult, senderResult] = await Promise.all([
        db.query(
            "SELECT user_id FROM conversation_participants WHERE conversation_id = $1",
            [conversationId],
        ),
        db.query("SELECT full_name, avatar, username FROM users WHERE id = $1", [senderId]),
    ]);
    const participants = participantsResult.rows;
    const sender = senderResult.rows[0];

    let replyContent: string | null = null;
    let replySenderName: string | null = null;
    let replyFileUrl: string | null = null;
    let replyFileType: string | null = null;
    let replyFileName: string | null = null;
    if (replyToId) {
        const replyMsg = (await db.query(
            `SELECT m.content, m.file_url, m.file_type, m.file_name, u.full_name AS sender_name
             FROM messages m JOIN users u ON u.id = m.sender_id
             WHERE m.id = $1 AND m.conversation_id = $2`,
            [replyToId, conversationId],
        )).rows[0];
        if (replyMsg) {
            replyContent = replyMsg.content;
            replySenderName = replyMsg.sender_name;
            replyFileUrl = replyMsg.file_url;
            replyFileType = replyMsg.file_type;
            replyFileName = replyMsg.file_name;
        }
    }

    const outMsg = {
        id: result.id,
        conversationId,
        senderId,
        senderName: sender?.full_name,
        senderAvatar: sender?.avatar,
        senderUsername: sender?.username,
        content: content.trim(),
        formatType: fmtType,
        replyToId: replyToId || null,
        replyContent,
        replySenderName,
        replyFileUrl,
        replyFileType,
        replyFileName,
        createdAt: result.created_at,
        clientMsgId: clientMsgId || null,
    };

    // ── 5. Fan-out + unread counters ───────────────────────────────────
    for (const p of participants) {
        sendToUser(tenantId, p.user_id, "chat_message", outMsg);
        if (p.user_id !== senderId) {
            redis.incrUnread(tenantId, p.user_id, conversationId);

            // Compute the recipient's TOTAL unread across ALL conversations so the
            // push carries the true badge count (iOS aps.badge + Android
            // badgeCount). Without this the badge always showed "1" and never
            // reflected, e.g., "3 messages". Best-effort: a failure here must not
            // block message delivery, so we fall back to leaving it undefined
            // (the push service then defaults to 1).
            void (async () => {
                let unreadTotal: number | undefined;
                try {
                    unreadTotal = await getTotalUnread(db, p.user_id);
                } catch (err: any) {
                    logger.warn({ err: err?.message, userId: p.user_id }, "Failed to compute total unread for badge");
                }
                // Send push notification for new messages to other participants
                pushNotifications.sendMessageNotification(
                    db.query as any,
                    p.user_id,
                    tenantId,
                    {
                        conversationId,
                        messageId: result.id,
                        senderId,
                        senderName: sender?.full_name || "Unknown",
                        senderAvatar: sender?.avatar,
                        messagePreview: content.trim().substring(0, 150),
                        unreadCount: unreadTotal,
                    }
                ).catch((err: any) => {
                    logger.warn({ err: err.message, userId: p.user_id, messageId: result.id }, "Failed to send message push notification");
                });
            })();
        }
    }

    // ── 6. Mention notifications (additive — only to mentioned users) ──
    if (rawMentions.length > 0) {
        const participantIdSet = new Set(participants.map((p) => p.user_id));
        const mentionedIds = rawMentions
            .map(Number)
            .filter((n) => n > 0 && n !== senderId && participantIdSet.has(n));
        for (const uid of mentionedIds) {
            sendToUser(tenantId, uid, "chat_mention", {
                conversationId,
                messageId: result.id,
                senderId,
                senderName: sender?.full_name,
                content: content.trim().slice(0, 100),
            });
        }
    }
}

export {
    chatMessage,
    // Exported for direct schema tests.
    chatMessageSchema,
    sendErrorAck as _sendErrorAck,
};
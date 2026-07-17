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

type Query = (
  sql: string,
  params?: unknown[],
) => Promise<{ rows: any[]; rowCount?: number | null }>;

interface DbLike {
  query: Query;
}

interface WSLike {
  readyState: number;
  send: (data: string) => void;
  [key: string]: unknown;
}

type SendToUser = (
  tenantId: number | null,
  userId: number,
  type: string,
  data: unknown,
) => void;

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
  // `linkPreview` (optional object) is validated by hand below — Signal
  // parity: SENDER-generated preview travels with the message.
};

/**
 * Sanitise a sender-provided link preview to a small, known shape.
 * Returns null when it isn't a plausible preview object.
 */
function sanitizeLinkPreview(raw: unknown): {
  url: string;
  title: string;
  description: string;
  image: string | null;
  siteName: string;
} | null {
  if (!raw || typeof raw !== "object") return null;
  const p = raw as Record<string, unknown>;
  const url = typeof p.url === "string" ? p.url.slice(0, 1024) : "";
  if (!/^https?:\/\//i.test(url)) return null;
  const image =
    typeof p.image === "string" && /^https?:\/\//i.test(p.image)
      ? p.image.slice(0, 1024)
      : null;
  return {
    url,
    title: typeof p.title === "string" ? p.title.slice(0, 200) : "",
    description:
      typeof p.description === "string" ? p.description.slice(0, 300) : "",
    image,
    siteName: typeof p.siteName === "string" ? p.siteName.slice(0, 100) : "",
  };
}

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
function sendErrorAck(
  ws: WSLike | null | undefined,
  clientMsgId: unknown,
  reason: string,
): void {
  if (!ws || ws.readyState !== 1) return;
  try {
    ws.send(
      JSON.stringify({
        type: "chat_message_error",
        data: { clientMsgId: clientMsgId || null, reason },
      }),
    );
  } catch {
    /* ignore */
  }
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
  const row = (
    await db.query(
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
    )
  ).rows[0];
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
async function chatMessage({
  db,
  senderId,
  tenantId,
  data,
  ws,
  sendToUser,
}: ChatMessageArgs): Promise<void> {
  // ── 1. Schema check ────────────────────────────────────────────────
  const parsed = validate(chatMessageSchema, data);
  if (!parsed.ok) {
    const firstField = Object.keys(parsed.errors)[0];
    const reason = `validation:${firstField}=${parsed.errors[firstField]}`;
    sendErrorAck(ws, data && data.clientMsgId, reason);
    return;
  }
  const { conversationId, content, replyToId, formatType, clientMsgId } =
    parsed.value as {
      conversationId: number;
      content: string;
      replyToId?: number;
      formatType?: string;
      clientMsgId?: string;
    };
  // mentions: validated by hand (no array schema yet)
  const rawMentions: unknown[] = Array.isArray(data?.mentions)
    ? (data!.mentions as unknown[])
    : [];

  // Defense-in-depth XSS gate.
  if (INJECTION_RE.test(content)) {
    logger.warn(
      { senderId, conversationId },
      "chat_message: rejected content with script-like pattern",
    );
    sendErrorAck(ws, clientMsgId, "unsafe-content");
    return;
  }

  // ── 2. Authorisation: sender must be in the conversation ───────────
  const participant = (
    await db.query(
      `SELECT c.is_group, c.name AS group_name
         FROM conversation_participants cp
         JOIN conversations c ON c.id = cp.conversation_id
        WHERE cp.conversation_id = $1 AND cp.user_id = $2`,
      [conversationId, senderId],
    )
  ).rows[0];
  if (!participant) {
    sendErrorAck(ws, clientMsgId, "not-a-participant");
    return;
  }

  // Reply IDs are global, so they must be bound to this conversation before
  // persisting. Otherwise a sender could attach a private message from another
  // conversation and expose its context through history/realtime joins.
  if (replyToId !== undefined) {
    const replyTarget = (
      await db.query(
        `SELECT 1
           FROM messages
          WHERE id = $1
            AND conversation_id = $2
            AND deleted_at IS NULL`,
        [replyToId, conversationId],
      )
    ).rows[0];
    if (!replyTarget) {
      sendErrorAck(ws, clientMsgId, "invalid-reply-target");
      return;
    }
  }

  // ── 2b. Block enforcement (direct chats only, Signal parity) ───────
  // A block in EITHER direction stops direct-message delivery. Group
  // messages are NOT filtered (matches Signal, where blocked users'
  // group messages still render).
  if (!participant.is_group) {
    const blockedPair = (
      await db.query(
        `SELECT 1 FROM blocked_users b
           JOIN conversation_participants cp
             ON cp.conversation_id = $1 AND cp.user_id != $2
          WHERE (b.blocker_id = $2 AND b.blocked_id = cp.user_id)
             OR (b.blocker_id = cp.user_id AND b.blocked_id = $2)
          LIMIT 1`,
        [conversationId, senderId],
      )
    ).rows[0];
    if (blockedPair) {
      sendErrorAck(ws, clientMsgId, "blocked");
      return;
    }
  }

  // ── 3. Insert + bump conversation timestamp + update read cursor ───
  //
  // IDEMPOTENT PERSIST (offline-outbox support, mirrors the meeting_chat
  // handler / ADR-002): mobile clients persist unsent messages to a durable
  // outbox and RE-SEND them with the same clientMsgId on every reconnect. If
  // the original frame reached us but its echo was lost on the dying socket,
  // the retry must NOT double-insert. The partial unique index
  // `idx_messages_client_msg_id` over (conversation_id, sender_id,
  // client_msg_id) makes `ON CONFLICT DO NOTHING` safe; on conflict we fetch
  // the canonical row and RE-ECHO it so the sender's outbox still clears.
  const fmtType =
    formatType === "markdown" || formatType === "code" ? formatType : "text";
  const safeClientMsgId =
    typeof clientMsgId === "string" &&
    clientMsgId.length > 0 &&
    clientMsgId.length <= 64
      ? clientMsgId
      : null;
  const linkPreview = sanitizeLinkPreview(data?.linkPreview);
  let result = (
    await db.query(
      `INSERT INTO messages (conversation_id, sender_id, content, reply_to_id, format_type, client_msg_id, link_preview)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (conversation_id, sender_id, client_msg_id)
         WHERE client_msg_id IS NOT NULL
         DO NOTHING
         RETURNING id, created_at`,
      [
        conversationId,
        senderId,
        content.trim(),
        replyToId || null,
        fmtType,
        safeClientMsgId,
        linkPreview ? JSON.stringify(linkPreview) : null,
      ],
    )
  ).rows[0];
  let isDuplicateResend = false;
  if (!result && safeClientMsgId) {
    // Retry of an already-persisted message — fetch the canonical row so the
    // (re-)echo carries the real id + created_at.
    result = (
      await db.query(
        `SELECT id, created_at FROM messages
           WHERE conversation_id = $1 AND sender_id = $2 AND client_msg_id = $3
           LIMIT 1`,
        [conversationId, senderId, safeClientMsgId],
      )
    ).rows[0];
    isDuplicateResend = true;
  }
  if (!result) return; // insert failed with no dedupe row — nothing to echo

  await db.query("UPDATE conversations SET updated_at = NOW() WHERE id = $1", [
    conversationId,
  ]);
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
    db.query("SELECT full_name, avatar, username FROM users WHERE id = $1", [
      senderId,
    ]),
  ]);
  const participants = participantsResult.rows;
  const sender = senderResult.rows[0];

  let replyContent: string | null = null;
  let replySenderName: string | null = null;
  let replyFileUrl: string | null = null;
  let replyFileType: string | null = null;
  let replyFileName: string | null = null;
  if (replyToId) {
    const replyMsg = (
      await db.query(
        `SELECT m.content, m.file_url, m.file_type, m.file_name, u.full_name AS sender_name
             FROM messages m JOIN users u ON u.id = m.sender_id
             WHERE m.id = $1 AND m.conversation_id = $2`,
        [replyToId, conversationId],
      )
    ).rows[0];
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
    linkPreview: linkPreview || null,
  };

  // ── 5. Fan-out + unread counters ───────────────────────────────────
  //
  // DUPLICATE RE-SEND: the message was already persisted + fanned out by the
  // original frame — only RE-ECHO to the SENDER (their echo was lost; this
  // clears their outbox / pending bubble). No unread bumps, no pushes, no
  // second broadcast to the other participants.
  if (isDuplicateResend) {
    sendToUser(tenantId, senderId, "chat_message", outMsg);
    return;
  }

  // Mute-aware push suppression (Signal parity): recipients who muted this
  // conversation (indefinitely OR with an unexpired timed mute) still get
  // the WS message + unread bump, but no push notification. Best-effort —
  // on any error we fall back to sending pushes to everyone.
  const mutedRecipients = new Set<number>();
  try {
    const mutedRows = (
      await db.query(
        `SELECT user_id FROM conversation_participants
          WHERE conversation_id = $1
            AND is_muted = TRUE
            AND (muted_until IS NULL OR muted_until > NOW())`,
        [conversationId],
      )
    ).rows;
    for (const r of mutedRows) mutedRecipients.add(r.user_id);
  } catch {
    /* fall back to pushing everyone */
  }

  for (const p of participants) {
    sendToUser(tenantId, p.user_id, "chat_message", outMsg);
    if (p.user_id !== senderId) {
      redis.incrUnread(tenantId, p.user_id, conversationId);

      // Muted chats never dispatch pushes (WS delivery above still happens).
      if (mutedRecipients.has(p.user_id)) continue;

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
          logger.warn(
            { err: err?.message, userId: p.user_id },
            "Failed to compute total unread for badge",
          );
        }
        // Send push notification for new messages to other participants
        pushNotifications
          .sendMessageNotification(db.query as any, p.user_id, tenantId, {
            conversationId,
            messageId: result.id,
            senderId,
            senderName: sender?.full_name || "Unknown",
            senderAvatar: sender?.avatar,
            isGroup: Boolean(participant.is_group),
            groupName: participant.group_name || undefined,
            messagePreview: content.trim().substring(0, 150),
            unreadCount: unreadTotal,
          })
          .catch((err: any) => {
            logger.warn(
              { err: err.message, userId: p.user_id, messageId: result.id },
              "Failed to send message push notification",
            );
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

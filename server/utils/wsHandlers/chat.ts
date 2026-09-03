/**
 * Simple chat WebSocket handlers, extracted from ws.ts as part of the
 * calls/meetings-module separation (sibling to wsHandlers/chatMessage.ts,
 * which owns `chat_message`). Handles `chat_typing` and `chat_read` — both
 * are small, fire-and-forget style relays so they're grouped together here
 * rather than each getting their own file.
 *
 * Dependencies are injected (same pattern as the other extracted handlers)
 * so this module never imports ws.ts.
 */
import { logger } from "../logger";
import { schema, validate } from "../wsValidate";
const redis = require("../../redis");

type Query = (
  sql: string,
  params?: unknown[],
) => Promise<{ rows: any[]; rowCount?: number | null }>;

interface DbLike {
  query: Query;
}

type SendToUser = (
  tenantId: number | null,
  userId: number,
  type: string,
  data: unknown,
) => void;

export interface ChatSimpleHandlerArgs {
  db: DbLike;
  senderId: number;
  tenantId: number | null;
  data: Record<string, unknown> | null | undefined;
  sendToUser: SendToUser;
}

export async function handleChatTyping({
  db,
  senderId,
  tenantId,
  data,
  sendToUser,
}: ChatSimpleHandlerArgs): Promise<void> {
  // wsValidate: constitution Principle III — typed schema check replaces the
  // former bare `if (!conversationId) return;` silent-drop. Validation
  // failures are logged (not silently swallowed) but produce no reply frame
  // (typing indicators are fire-and-forget; a typed error ack adds no value).
  const parsed = validate({ conversationId: schema.posInt() }, data);
  if (!parsed.ok) {
    logger.warn(
      { senderId, tenantId, errors: parsed.errors },
      "chat_typing: schema validation failed",
    );
    return;
  }
  const { conversationId } = parsed.value as { conversationId: number };

  // Verify sender is a participant
  const participant = (
    await db.query(
      "SELECT 1 FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2",
      [conversationId, senderId],
    )
  ).rows[0];
  if (!participant) return;

  // Notify other participants
  const participants = (
    await db.query(
      "SELECT user_id FROM conversation_participants WHERE conversation_id = $1 AND user_id != $2",
      [conversationId, senderId],
    )
  ).rows;

  for (const p of participants) {
    sendToUser(tenantId, p.user_id, "chat_typing", {
      conversationId,
      userId: senderId,
    });
  }
}

export async function handleChatRead({
  db,
  senderId,
  tenantId,
  data,
}: ChatSimpleHandlerArgs): Promise<void> {
  // wsValidate: same pattern as chat_typing — silent-drop replaced with a
  // logged validation failure so bad frames surface in wsMetrics.
  const parsedRead = validate({ conversationId: schema.posInt() }, data);
  if (!parsedRead.ok) {
    logger.warn(
      { senderId, tenantId, errors: parsedRead.errors },
      "chat_read: schema validation failed",
    );
    return;
  }
  const { conversationId: readConvId } = parsedRead.value as { conversationId: number };

  const participant = (
    await db.query(
      "SELECT 1 FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2",
      [readConvId, senderId],
    )
  ).rows[0];
  if (!participant) return;

  await db.query(
    `INSERT INTO message_reads (conversation_id, user_id, last_read_at)
           VALUES ($1, $2, NOW())
           ON CONFLICT (conversation_id, user_id) DO UPDATE SET last_read_at = NOW()`,
    [readConvId, senderId],
  );
  redis.resetUnread(tenantId, senderId, readConvId);
}

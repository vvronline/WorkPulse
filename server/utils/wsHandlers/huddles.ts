
/**
 * GROUP-CALL (huddle) WebSocket handlers, extracted from ws.ts as part of the
 * calls-module separation. Huddle ring-lifecycle logic lives here so future
 * group-call changes cannot accidentally touch the 1:1 `call_*` handlers (the
 * source of earlier 1:1 regressions). Dependencies are injected (same pattern
 * as wsHandlers/chatMessage.ts) so the handlers stay unit-testable and free of
 * ws.ts's module-scope state.
 */

import { logger } from "../logger";
import { pushNotifications } from "../../services/pushNotifications";
import { withIdempotency } from "../wsIdempotency";

type DbLike = { query: (sql: string, params?: unknown[]) => Promise<any> };
type SendToUser = (
  tenantId: number | null | undefined,
  userId: number,
  type: string,
  data: unknown,
) => void;

export type HuddleDeclineDeps = {
  db: DbLike;
  tenantId: number | null;
  senderId: number;
  sendToUser: SendToUser;
};

/**
 * GROUP-CALL DECLINE (Signal/WhatsApp parity): a rung member declines the
 * huddle ring. Unlike a 1:1 `call_reject` this does NOT end the call — the
 * mesh keeps running for everyone who joined. We:
 *   1. mark the decliner's participant row 'declined' so they are not
 *      re-rung by lifecycle events,
 *   2. dismiss the ring on ALL the decliner's devices (WS + push-cancel),
 *   3. tell the joined members that this user declined (UI can show
 *      "<name> declined" on the pending tile).
 * Idempotent via withIdempotency on (tenant, sender, type, clientMsgId).
 */
export async function handleHuddleDecline(
  deps: HuddleDeclineDeps,
  data: { meetingId?: number; clientMsgId?: string } | undefined,
): Promise<void> {
  const { db, tenantId, senderId, sendToUser } = deps;
  const { meetingId, clientMsgId } = data || {};
  if (!meetingId) return;
  await withIdempotency(
    { tenantId, senderId, type: "huddle_decline", clientMsgId },
    async () => {
      const meeting = (
        await db.query(
          "SELECT id, is_huddle, conversation_id FROM meetings WHERE id = $1",
          [meetingId],
        )
      ).rows[0];
      if (!meeting || !meeting.is_huddle) return;
      // Only an invited (not-yet-joined) member can decline the ring.
      const mpRow = (
        await db.query(
          "SELECT status FROM meeting_participants WHERE meeting_id = $1 AND user_id = $2",
          [meetingId, senderId],
        )
      ).rows[0];
      if (!mpRow || mpRow.status === "joined") return;
      await db.query(
        `UPDATE meeting_participants SET status = 'declined' WHERE meeting_id = $1 AND user_id = $2 AND status != 'joined'`,
        [meetingId, senderId],
      );

      // Dismiss the ring on every one of the decliner's devices.
      sendToUser(tenantId, senderId, "call_handled_elsewhere", {
        callId: meeting.id,
        conversationId: meeting.conversation_id,
        action: "rejected",
      });
      pushNotifications
        .sendCallCancellation(db.query as any, senderId, tenantId as any, {
          callId: meeting.id,
          conversationId: meeting.conversation_id,
          reason: "rejected",
        })
        .catch((err: any) =>
          logger.warn(
            { err: err?.message, userId: senderId, meetingId },
            "huddle_decline push-cancel failed",
          ),
        );

      // Notify joined members so their UI can drop the "Ringing…" state.
      const decliner = (
        await db.query("SELECT full_name FROM users WHERE id = $1", [senderId])
      ).rows[0];
      const joined = (
        await db.query(
          `SELECT user_id FROM meeting_participants WHERE meeting_id = $1 AND status = 'joined'`,
          [meetingId],
        )
      ).rows;
      for (const p of joined) {
        sendToUser(tenantId, p.user_id, "huddle_declined", {
          meetingId,
          callId: meeting.id,
          conversationId: meeting.conversation_id,
          userId: senderId,
          userName: decliner?.full_name,
        });
      }
    },
  );
}
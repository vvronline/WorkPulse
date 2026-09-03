/**
 * 1:1 CALL WebSocket handlers, extracted from ws.ts as part of the
 * calls-module separation (mirrors wsHandlers/huddles.ts for group calls).
 * Handles: call_initiate, call_accept, call_cancel, call_reject, call_end,
 * call_signal, call_subscribe, call_ready, call_reconnect, call_reaction,
 * call_add_participant.
 *
 * Dependencies (db, tenantId, senderId, sendToUser, ws, etc.) are injected so
 * this module never imports ws.ts (avoids a circular dependency). Logic is
 * moved verbatim from the original `handleChatMessage` dispatcher — this is a
 * pure structural refactor, no behaviour changes.
 */
import { logger, logPushCallLifecycle } from "../logger";
import { pushNotifications } from "../../services/pushNotifications";
import { withIdempotency, withIdempotentCallAction } from "../wsIdempotency";
import * as signalStore from "../../realtime/signalStore";
const statusService = require("../../services/status");
import {
  DbLike,
  ExtWS,
  SendToUser,
  recordCallTransitionFailure,
  identifyCallSignal,
  isConversationMember,
  replayCallSignals,
  emitCallHistoryMessage,
  hasOpenSocket,
} from "./shared";

export interface CallHandlerArgs {
  db: DbLike;
  senderId: number;
  tenantId: number | null;
  msg: any;
  ws: ExtWS;
  sendToUser: SendToUser;
}

export async function handleCallInitiate({
  db,
  senderId,
  tenantId,
  msg,
  ws,
  sendToUser,
}: CallHandlerArgs): Promise<void> {
  // Caller initiates a call → create call_log, notify participants.
  // T038: gate this with idempotency so reconnect replays don't create
  // duplicate ringing rows/invites.
  const {
    conversationId,
    callType,
    clientMsgId: rawCallInitiateId,
  } = msg.data || {};
  // Reject a malformed initiate EXPLICITLY. A silent `return` here left the
  // caller's screen "Ringing…" for the full 35s no-answer timeout while the
  // receiver never rang (e.g. a Calls-tab / call-info entry that carried a
  // null conversation_id serialises to the string "null" → NaN client-side
  // and an unusable id here). The NACK lets the client fail fast with a
  // real error instead of ringing into the void.
  const convIdNum = Number(conversationId);
  if (
    !conversationId ||
    !Number.isFinite(convIdNum) ||
    convIdNum <= 0 ||
    !["voice", "video"].includes(callType)
  ) {
    logger.warn(
      { senderId, conversationId, callType, tenantId },
      "call_initiate: invalid payload, sending call_error",
    );
    sendToUser(tenantId, senderId, "call_error", {
      conversationId: conversationId ?? null,
      reason: "invalid_payload",
    });
    return;
  }

  await withIdempotency(
    {
      tenantId,
      senderId,
      type: "call_initiate",
      clientMsgId: rawCallInitiateId,
    },
    async () => {
      const participant = (
        await db.query(
          "SELECT 1 FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2",
          [conversationId, senderId],
        )
      ).rows[0];
      if (!participant) {
        logger.warn(
          { senderId, conversationId },
          "call_initiate: sender not a participant",
        );
        // NACK the caller — a silent drop left their screen ringing for the
        // full no-answer timeout with the receiver never notified.
        sendToUser(tenantId, senderId, "call_error", {
          conversationId,
          reason: "not_participant",
        });
        recordCallTransitionFailure({
          event: "call_transition_failed",
          action: "initiate",
          tenantId,
          senderId,
          conversationId,
          reason: "sender_not_participant",
        });
        return;
      }

      // Group conversations use the meeting mesh flow for n-way reliability.
      // Direct call_initiate is p2p and cannot connect all participants.
      const isGroupConv = (
        await db.query("SELECT is_group FROM conversations WHERE id = $1", [
          conversationId,
        ])
      ).rows[0]?.is_group;
      if (isGroupConv) {
        logger.info(
          { senderId, conversationId, tenantId },
          "call_initiate: group conversation blocked; use meeting flow",
        );
        sendToUser(tenantId, senderId, "call_ended", {
          conversationId,
          reason: "group_unsupported",
        });
        recordCallTransitionFailure({
          event: "call_transition_failed",
          action: "initiate",
          tenantId,
          senderId,
          conversationId,
          reason: "group_unsupported",
        });
        return;
      }

      // P0.3 — call_busy on 1:1 collision. For NON-group conversations we
      // ring at most one callee; if that callee already has an active
      // (ringing/answered) call we must NOT create another ringing row.
      // Instead tell the caller the callee is busy and bail out.
      {
        const targetRow = (
          await db.query(
            `SELECT user_id FROM conversation_participants
                       WHERE conversation_id = $1 AND user_id != $2
                       ORDER BY user_id ASC
                       LIMIT 1`,
            [conversationId, senderId],
          )
        ).rows[0];
        if (targetRow) {
          const targetUserId = targetRow.user_id;
          // Only treat the callee as busy for a GENUINELY active call.
          // Critical guards (a too-broad check here silently blocks all
          // future calls + push notifications to that user):
          //   • Exclude THIS conversation — in a 1:1 chat both users are
          //     participants of it, so a leftover row in the same convo
          //     would make the callee look "busy" to their own caller.
          //   • Freshness window — a crashed/killed client can leave a
          //     row stuck in 'ringing'/'answered' forever (the stale-call
          //     sweep is the authoritative cleanup, but we must also not
          //     trust rows older than the TTL here, or a user gets pinned
          //     "busy" until the next sweep / indefinitely for 'answered').
          //   • 'ringing' counts only within the ring TTL (~45s).
          //   • 'answered' counts only within a max PLAUSIBLE live-call
          //     window. This used to be 12h from created_at, which meant a
          //     single abandoned 'answered' row (client crashed / app killed
          //     mid-call so call_end never arrived) pinned the callee as
          //     "busy" for up to 12 HOURS — every caller got call_busy and
          //     the callee's phone NEVER RANG (a primary "receiver never
          //     rings" cause when the stale-call sweep isn't running, e.g.
          //     no Redis/BullMQ). 1:1 calls realistically don't exceed a
          //     couple of hours (group calls use the meeting mesh), so we
          //     tighten the window to 2h and anchor it on started_at (the
          //     moment the call actually connected) falling back to
          //     created_at. The 20s stale-call sweep remains the
          //     authoritative cleanup; this is the defensive bound.
          const busy = (
            await db.query(
              `SELECT 1 FROM call_logs cl
                           JOIN conversation_participants cp ON cp.conversation_id = cl.conversation_id
                           WHERE cp.user_id = $1
                             AND cl.conversation_id != $2
                             AND (
                                   (cl.status = 'ringing'
                                     AND cl.created_at > NOW() - INTERVAL '45 seconds')
                                OR (cl.status = 'answered'
                                     AND COALESCE(cl.started_at, cl.created_at) > NOW() - INTERVAL '2 hours')
                                 )
                           LIMIT 1`,
              [targetUserId, conversationId],
            )
          ).rows[0];
          if (busy) {
            logger.info(
              { senderId, conversationId, targetUserId, tenantId },
              "call_initiate: callee busy, sending call_busy",
            );
            // Optionally record a missed-call row for history.
            try {
              await db.query(
                `INSERT INTO call_logs (conversation_id, caller_id, call_type, status, ended_at)
                                   VALUES ($1, $2, $3, 'missed', NOW())`,
                [conversationId, senderId, callType],
              );
            } catch (err: any) {
              logger.warn(
                { err: err?.message, conversationId, senderId },
                "call_initiate: failed to record missed busy call log",
              );
            }
            sendToUser(tenantId, senderId, "call_busy", {
              conversationId,
              targetUserId,
              reason: "busy",
            });
            recordCallTransitionFailure({
              event: "call_transition_failed",
              action: "initiate",
              tenantId,
              senderId,
              conversationId,
              reason: "callee_busy",
            });
            return;
          }
        }
      }

      const [callLogResult, callerResult, convResult] = await Promise.all([
        db.query(
          `INSERT INTO call_logs (conversation_id, caller_id, call_type, status)
                       VALUES ($1, $2, $3, 'ringing') RETURNING id, created_at`,
          [conversationId, senderId, callType],
        ),
        db.query("SELECT full_name, avatar FROM users WHERE id = $1", [
          senderId,
        ]),
        db.query("SELECT name, is_group FROM conversations WHERE id = $1", [
          conversationId,
        ]),
      ]);

      const callLog = callLogResult.rows[0];
      const caller = callerResult.rows[0];
      const conv = convResult.rows[0];

      // For NON-group (1:1) conversations we ring at most ONE other user.
      const participantsQuery = conv?.is_group
        ? `SELECT user_id FROM conversation_participants
                     WHERE conversation_id = $1 AND user_id != $2`
        : `SELECT user_id FROM conversation_participants
                     WHERE conversation_id = $1 AND user_id != $2
                     ORDER BY user_id ASC
                     LIMIT 1`;
      const participants = (
        await db.query(participantsQuery, [conversationId, senderId])
      ).rows;

      logger.info(
        {
          senderId,
          callId: callLog.id,
          conversationId,
          callType,
          participantCount: participants.length,
          tenantId,
        },
        "call_initiate: notifying participants",
      );

      for (const p of participants) {
        sendToUser(tenantId, p.user_id, "call_incoming", {
          callId: callLog.id,
          conversationId,
          callerId: senderId,
          callerName: caller?.full_name,
          callerAvatar: caller?.avatar,
          callType,
          isGroup: conv?.is_group || false,
          groupName: conv?.name,
        });

        // Send push notification to recipient if they have registered devices
        pushNotifications
          .sendCallNotification(db.query as any, p.user_id, tenantId, {
            callId: callLog.id,
            conversationId,
            callerId: senderId,
            callerName: caller?.full_name || "Unknown",
            callerAvatar: caller?.avatar,
            callType: callType as "voice" | "video",
            isGroup: conv?.is_group || false,
            groupName: conv?.name,
          })
          .then(() => {
            logPushCallLifecycle(
              {
                event: "push_send_result",
                tenantId,
                userId: p.user_id,
                callId: callLog.id,
                conversationId,
                status: "success",
              },
              "debug",
            );
          })
          .catch((err: any) => {
            logger.warn(
              { err: err.message, userId: p.user_id, callId: callLog.id },
              "Failed to send call push notification",
            );
            logPushCallLifecycle(
              {
                event: "push_send_result",
                tenantId,
                userId: p.user_id,
                callId: callLog.id,
                conversationId,
                status: "failed",
                failureReason: err.message || "unknown",
              },
              "warn",
            );
          });
      }

      // Confirm call started to caller
      sendToUser(tenantId, senderId, "call_started", {
        callId: callLog.id,
        conversationId,
        callType,
      });

      // Status service v2: mark THIS device of the caller as in_call.
      if (ws._statusSessionKey) {
        statusService
          .setSessionActivity(
            { db, tenantId },
            ws._statusSessionKey,
            "in_call",
            callLog.id,
          )
          .catch((err: any) =>
            logger.warn(
              { err: err.message, callId: callLog.id },
              "setSessionActivity(in_call) failed",
            ),
          );
        ws._callActivityRefId = callLog.id;
      }
    },
  );
}

export async function handleCallAccept({
  db,
  senderId,
  tenantId,
  msg,
  ws,
  sendToUser,
}: CallHandlerArgs): Promise<void> {
  // Callee accepts → update call log, notify caller with acceptance
  const { callId, conversationId, clientMsgId: rawIdAccept } = msg.data || {};
  if (!callId || !conversationId) return;

  await withIdempotentCallAction(
    {
      tenantId,
      senderId,
      callId,
      action: "answer",
      clientMsgId: rawIdAccept,
    },
    async () => {
      const [callLogResult, participantResult] = await Promise.all([
        db.query(
          `SELECT * FROM call_logs WHERE id = $1 AND conversation_id = $2`,
          [callId, conversationId],
        ),
        db.query(
          "SELECT 1 FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2",
          [conversationId, senderId],
        ),
      ]);

      const callLog = callLogResult.rows[0];
      if (!callLog) {
        logger.warn(
          { senderId, callId, conversationId },
          "call_accept: call log not found",
        );
        recordCallTransitionFailure({
          event: "call_transition_failed",
          action: "answer",
          tenantId,
          senderId,
          callId,
          conversationId,
          reason: "call_not_found",
        });
        return;
      }
      if (callLog.status !== "ringing") {
        logger.info(
          { senderId, callId, conversationId, status: callLog.status },
          "call_accept: terminal/invalid state; ignoring",
        );
        recordCallTransitionFailure({
          event: "call_transition_failed",
          action: "answer",
          tenantId,
          senderId,
          callId,
          conversationId,
          fromStatus: callLog.status,
          reason: "invalid_transition",
        });
        return;
      }
      if (!participantResult.rows[0]) {
        logger.warn(
          { senderId, callId, conversationId },
          "call_accept: sender not a participant",
        );
        recordCallTransitionFailure({
          event: "call_transition_failed",
          action: "answer",
          tenantId,
          senderId,
          callId,
          conversationId,
          reason: "sender_not_participant",
        });
        return;
      }

      const [updatedCall, accepterResult] = await Promise.all([
        db.query(
          `UPDATE call_logs
                       SET status = 'answered', started_at = NOW()
                       WHERE id = $1 AND status = 'ringing'
                       RETURNING id`,
          [callId],
        ),
        db.query("SELECT full_name, avatar FROM users WHERE id = $1", [
          senderId,
        ]),
      ]);

      if (!updatedCall.rows[0]) {
        logger.info(
          { senderId, callId, conversationId },
          "call_accept: transition already applied by another action",
        );
        recordCallTransitionFailure({
          event: "call_transition_failed",
          action: "answer",
          tenantId,
          senderId,
          callId,
          conversationId,
          reason: "transition_race",
        });
        return;
      }

      const accepter = accepterResult.rows[0];

      logPushCallLifecycle(
        {
          event: "native_call_action_applied",
          tenantId,
          userId: senderId,
          callId,
          conversationId,
          action: "answer",
          status: "success",
        },
        "info",
      );

      logger.info(
        {
          senderId,
          callerId: callLog.caller_id,
          callId,
          conversationId,
          tenantId,
        },
        "call_accept: notifying caller",
      );

      // Notify the caller that call was accepted
      sendToUser(tenantId, callLog.caller_id, "call_accepted", {
        callId,
        conversationId,
        userId: senderId,
        userName: accepter?.full_name,
        userAvatar: accepter?.avatar,
      });

      // Multi-session support: the accepter may have other active sessions
      // (e.g. desktop + browser) where the incoming-call PiP is still
      // ringing. Tell every one of the accepter's sessions that the call
      // has been handled so non-accepting devices dismiss their PiP.
      // The accepting session itself has already cleared its PiP locally
      // and ignores this event (see CallContext handler).
      sendToUser(tenantId, senderId, "call_handled_elsewhere", {
        callId,
        conversationId,
        action: "accepted",
      });

      // Push-cancel the accepter's OTHER devices (e.g. a locked /
      // backgrounded twin phone) so the native incoming-call ring is
      // dismissed there. The WS dismiss above only reaches sessions
      // with a live socket; a killed/locked device relies on this
      // data-only "call handled elsewhere" push.
      pushNotifications
        .sendCallCancellation(db.query as any, senderId, tenantId, {
          callId,
          conversationId,
          reason: "accepted",
        })
        .catch((err: any) =>
          logger.warn(
            { err: err.message, callId, userId: senderId },
            "Failed to push-cancel accepter devices on accept",
          ),
        );

      // Status service v2: mark the accepting device (only) as in_call.
      if (ws._statusSessionKey) {
        statusService
          .setSessionActivity(
            { db, tenantId },
            ws._statusSessionKey,
            "in_call",
            callId,
          )
          .catch((err: any) =>
            logger.warn(
              { err: err.message, callId },
              "setSessionActivity(in_call) failed",
            ),
          );
        ws._callActivityRefId = callId;
      }

      // P0 — Reliable delivery: replay any OFFER/ICE the caller sent
      // BEFORE this callee's socket/screen was ready (buffered in
      // call_signal). This is the key fix for "answered from push but
      // never connects": the caller fired its offer the instant it saw
      // call_accepted, but the callee was still mounting; the buffered
      // offer is now delivered so negotiation actually starts.
      await replayCallSignals(tenantId, Number(callId), senderId, (fromUserId, signal) => {
        sendToUser(tenantId, senderId, "call_signal", {
          conversationId,
          fromUserId,
          signal,
        });
      });
    },
  );
}

export async function handleCallCancel({
  db,
  senderId,
  tenantId,
  msg,
  ws,
  sendToUser,
}: CallHandlerArgs): Promise<void> {
  // Caller cancels — either media acquisition failed after call_initiate
  // was sent, OR the caller backed out / the outgoing ring timed out
  // before the callee answered (mobile sends this when it has no callId
  // yet). Idempotent via the optional clientMsgId so a retried frame on a
  // flaky link doesn't double-cancel.
  const { conversationId, clientMsgId: rawCallCancelId } = msg.data || {};
  if (!conversationId) return;

  await withIdempotency(
    {
      tenantId,
      senderId,
      type: "call_cancel",
      clientMsgId: rawCallCancelId,
    },
    async () => {
      const callLog = (
        await db.query(
          `SELECT id, call_type FROM call_logs WHERE conversation_id = $1 AND caller_id = $2 AND status = 'ringing' ORDER BY created_at DESC LIMIT 1`,
          [conversationId, senderId],
        )
      ).rows[0];
      if (!callLog) return;

      const updated = await db.query(
        `UPDATE call_logs SET status = 'missed', ended_at = NOW() WHERE id = $1 AND status = 'ringing' RETURNING id`,
        [callLog.id],
      );
      if (!updated.rows[0]) return;

      const participants = (
        await db.query(
          "SELECT user_id FROM conversation_participants WHERE conversation_id = $1 AND user_id != $2",
          [conversationId, senderId],
        )
      ).rows;

      for (const p of participants) {
        sendToUser(tenantId, p.user_id, "call_ended", {
          callId: callLog.id,
          conversationId,
        });

        // Push-cancel the callee's devices (locked/backgrounded twin)
        // so a native incoming-call ring is dismissed when the caller
        // cancels.
        pushNotifications
          .sendCallCancellation(db.query as any, p.user_id, tenantId, {
            callId: callLog.id,
            conversationId,
            reason: "cancelled",
          })
          .catch((err: any) =>
            logger.warn(
              { err: err.message, callId: callLog.id, userId: p.user_id },
              "Failed to push-cancel callee devices on cancel",
            ),
          );
      }

      // Echo to the caller's OTHER devices so their outgoing-ring UI is
      // dismissed too (e.g. desktop + mobile both showing the call).
      sendToUser(tenantId, senderId, "call_ended", {
        callId: callLog.id,
        conversationId,
      });

      // Status service v2: caller cancelled; their device was briefly
      // marked in_call by call_initiate. Sweep every session
      // referencing this call.
      statusService
        .clearActivityForRef({ db, tenantId }, "in_call", callLog.id)
        .catch((err: any) =>
          logger.warn(
            { err: err.message, callId: callLog.id },
            "clearActivityForRef(in_call) on cancel failed",
          ),
        );
      ws._callActivityRefId = null;
      // Inline "missed" call-history row in the chat thread (the callee never
      // answered before the caller cancelled / the ring timed out).
      await emitCallHistoryMessage(
        db,
        tenantId,
        Number(conversationId),
        senderId,
        callLog.call_type || "voice",
        "missed",
        null,
        sendToUser,
      );
      // P0 — drop any buffered signals for this now-dead call.
      await signalStore.clearCallSignals(tenantId, callLog.id);
    },
  );
}

export async function handleCallReject({
  db,
  senderId,
  tenantId,
  msg,
  sendToUser,
}: CallHandlerArgs): Promise<void> {
  // Callee rejects → update call log, notify caller
  const { callId, conversationId, clientMsgId: rawIdReject } = msg.data || {};
  if (!callId || !conversationId) return;

  await withIdempotentCallAction(
    {
      tenantId,
      senderId,
      callId,
      action: "reject",
      clientMsgId: rawIdReject,
    },
    async () => {
      // Verify sender is a participant in this conversation
      const isParticipant = (
        await db.query(
          "SELECT 1 FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2",
          [conversationId, senderId],
        )
      ).rows[0];
      if (!isParticipant) return;

      const callLog = (
        await db.query(
          `SELECT * FROM call_logs WHERE id = $1 AND conversation_id = $2`,
          [callId, conversationId],
        )
      ).rows[0];
      if (!callLog) {
        recordCallTransitionFailure({
          event: "call_transition_failed",
          action: "reject",
          tenantId,
          senderId,
          callId,
          conversationId,
          reason: "call_not_found",
        });
        return;
      }
      if (callLog.status !== "ringing") {
        logger.info(
          { senderId, callId, conversationId, status: callLog.status },
          "call_reject: terminal/invalid state; ignoring",
        );
        recordCallTransitionFailure({
          event: "call_transition_failed",
          action: "reject",
          tenantId,
          senderId,
          callId,
          conversationId,
          fromStatus: callLog.status,
          reason: "invalid_transition",
        });
        return;
      }

      const updated = await db.query(
        `UPDATE call_logs
                   SET status = 'declined', ended_at = NOW()
                   WHERE id = $1 AND status = 'ringing'
                   RETURNING id`,
        [callId],
      );
      if (!updated.rows[0]) {
        recordCallTransitionFailure({
          event: "call_transition_failed",
          action: "reject",
          tenantId,
          senderId,
          callId,
          conversationId,
          reason: "transition_race",
        });
        return;
      }

      const rejecter = (
        await db.query("SELECT full_name FROM users WHERE id = $1", [
          senderId,
        ])
      ).rows[0];

      logPushCallLifecycle(
        {
          event: "native_call_action_applied",
          tenantId,
          userId: senderId,
          callId,
          conversationId,
          action: "reject",
          status: "success",
        },
        "info",
      );

      // Notify other participants
      const participants = (
        await db.query(
          "SELECT user_id FROM conversation_participants WHERE conversation_id = $1 AND user_id != $2",
          [conversationId, senderId],
        )
      ).rows;

      for (const p of participants) {
        sendToUser(tenantId, p.user_id, "call_rejected", {
          callId,
          conversationId,
          userId: senderId,
          userName: rejecter?.full_name,
        });
      }

      // Multi-session support: dismiss the ringing PiP on the rejecter's
      // other devices (e.g. desktop + browser). The session that pressed
      // "reject" has already cleared its PiP locally.
      sendToUser(tenantId, senderId, "call_handled_elsewhere", {
        callId,
        conversationId,
        action: "rejected",
      });

      // Push-cancel the rejecter's OTHER devices (locked/backgrounded
      // twin) so their native ring is dismissed, plus the caller's
      // devices so a backgrounded caller stops its outgoing ring.
      pushNotifications
        .sendCallCancellation(db.query as any, senderId, tenantId, {
          callId,
          conversationId,
          reason: "rejected",
        })
        .catch((err: any) =>
          logger.warn(
            { err: err.message, callId, userId: senderId },
            "Failed to push-cancel rejecter devices on reject",
          ),
        );
      pushNotifications
        .sendCallCancellation(db.query as any, callLog.caller_id, tenantId, {
          callId,
          conversationId,
          reason: "rejected",
        })
        .catch((err: any) =>
          logger.warn(
            { err: err.message, callId, userId: callLog.caller_id },
            "Failed to push-cancel caller devices on reject",
          ),
        );

      // Status service v2: if the callee had been auto-flagged in_call by a
      // racy accept (or the caller's device was still marked from initiate),
      // clear it for every session referencing this call.
      statusService
        .clearActivityForRef({ db, tenantId }, "in_call", callId)
        .catch((err: any) =>
          logger.warn(
            { err: err.message, callId },
            "clearActivityForRef(in_call) on reject failed",
          ),
        );

      // Inline "declined" call-history row in the chat thread.
      await emitCallHistoryMessage(
        db,
        tenantId,
        Number(conversationId),
        callLog.caller_id,
        callLog.call_type,
        "declined",
        null,
        sendToUser,
      );
      await signalStore.clearCallSignals(tenantId, Number(callId));
    },
  );
}

export async function handleCallEnd({
  db,
  senderId,
  tenantId,
  msg,
  ws,
  sendToUser,
}: CallHandlerArgs): Promise<void> {
  // Either party ends the call → update log, notify others
  const { callId, conversationId, clientMsgId: rawIdEnd } = msg.data || {};
  if (!callId || !conversationId) return;

  await withIdempotentCallAction(
    { tenantId, senderId, callId, action: "end", clientMsgId: rawIdEnd },
    async () => {
      // Verify sender is a participant in this conversation
      const isParticipant = (
        await db.query(
          "SELECT 1 FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2",
          [conversationId, senderId],
        )
      ).rows[0];
      if (!isParticipant) {
        recordCallTransitionFailure({
          event: "call_transition_failed",
          action: "end",
          tenantId,
          senderId,
          callId,
          conversationId,
          reason: "sender_not_participant",
        });
        return;
      }

      const callLog = (
        await db.query(
          `SELECT * FROM call_logs WHERE id = $1 AND conversation_id = $2`,
          [callId, conversationId],
        )
      ).rows[0];
      if (!callLog) {
        recordCallTransitionFailure({
          event: "call_transition_failed",
          action: "end",
          tenantId,
          senderId,
          callId,
          conversationId,
          reason: "call_not_found",
        });
        return;
      }
      if (["ended", "missed", "declined"].includes(callLog.status)) {
        logger.info(
          { senderId, callId, conversationId, status: callLog.status },
          "call_end: terminal state; ignoring duplicate",
        );
        recordCallTransitionFailure({
          event: "call_transition_failed",
          action: "end",
          tenantId,
          senderId,
          callId,
          conversationId,
          fromStatus: callLog.status,
          reason: "already_terminal",
        });
        return;
      }

      // Calculate duration if call was answered
      let duration: number | null = null;
      if (callLog.started_at) {
        duration = Math.round(
          (Date.now() - new Date(callLog.started_at).getTime()) / 1000,
        );
      }

      const updated = await db.query(
        `UPDATE call_logs
                   SET status = CASE WHEN status = 'ringing' THEN 'missed' ELSE 'ended' END,
                       ended_at = NOW(),
                       duration = $2
                   WHERE id = $1
                   RETURNING id`,
        [callId, duration],
      );
      if (!updated.rows[0]) {
        recordCallTransitionFailure({
          event: "call_transition_failed",
          action: "end",
          tenantId,
          senderId,
          callId,
          conversationId,
          reason: "transition_race",
        });
        return;
      }

      // Notify all participants about call end
      const allParticipants = (
        await db.query(
          "SELECT user_id FROM conversation_participants WHERE conversation_id = $1",
          [conversationId],
        )
      ).rows;

      for (const p of allParticipants) {
        if (p.user_id !== senderId) {
          sendToUser(tenantId, p.user_id, "call_ended", {
            callId,
            conversationId,
            endedBy: senderId,
            duration,
          });

          // P2.13 — Decline/end teardown parity. The WS `call_ended`
          // above only reaches sessions with a live socket. A
          // locked/backgrounded/killed twin (e.g. the call was ended
          // while it was still ringing, or a second device never
          // joined) keeps its native incoming-call ring / ongoing-call
          // notification until this data-only "call handled elsewhere"
          // push dismisses it — matching the call_cancel / call_reject
          // / stale-sweep teardown paths.
          pushNotifications
            .sendCallCancellation(db.query as any, p.user_id, tenantId, {
              callId,
              conversationId,
              reason: "ended",
            })
            .catch((err: any) =>
              logger.warn(
                { err: err.message, callId, userId: p.user_id },
                "Failed to push-cancel participant devices on end",
              ),
            );
        }
      }

      // Status service v2: clear in_call for every session referencing
      // this call (caller + all callees, across all their devices).
      statusService
        .clearActivityForRef({ db, tenantId }, "in_call", callId)
        .catch((err: any) =>
          logger.warn(
            { err: err.message, callId },
            "clearActivityForRef(in_call) on end failed",
          ),
        );
      if (ws._callActivityRefId === callId) ws._callActivityRefId = null;
      // Inline call-history row in the chat thread (Signal parity). A
      // call that was never answered (still `ringing`) is a MISSED
      // call; otherwise it `ended` with the measured duration.
      await emitCallHistoryMessage(
        db,
        tenantId,
        Number(conversationId),
        callLog.caller_id,
        callLog.call_type,
        callLog.status === "ringing" ? "missed" : "ended",
        duration,
        sendToUser,
      );
      // P0 — drop any buffered signals for this now-ended call.
      await signalStore.clearCallSignals(tenantId, Number(callId));
    },
  );
}

export async function handleCallSignal({
  db,
  senderId,
  tenantId,
  msg,
  sendToUser,
}: CallHandlerArgs): Promise<void> {
  // WebRTC signaling relay: offer, answer, ICE candidates
  const { conversationId, targetUserId, signal } = msg.data || {};
  if (!conversationId || !targetUserId || !signal) return;

  // Validate signal type against whitelist
  const VALID_SIGNAL_TYPES = [
    "offer",
    "answer",
    "ice-candidate",
    "video-state",
    "audio-state",
    "screen-share-state",
    "quality-state",
    "request-video-state",
  ];
  if (!signal.type || !VALID_SIGNAL_TYPES.includes(signal.type)) {
    logger.warn(
      { senderId, signalType: signal?.type },
      "call_signal: rejected unknown signal type",
    );
    return;
  }

  // Validate signal payload per type
  if (signal.type === "offer" || signal.type === "answer") {
    if (
      typeof signal.sdp !== "string" ||
      signal.sdp.length === 0 ||
      signal.sdp.length > 100000
    ) {
      logger.warn(
        { senderId, signalType: signal.type, sdpLen: signal.sdp?.length },
        "call_signal: invalid SDP",
      );
      return;
    }
  } else if (signal.type === "ice-candidate") {
    if (
      signal.candidate != null &&
      (typeof signal.candidate !== "object" ||
        typeof signal.candidate.candidate !== "string")
    ) {
      logger.warn(
        { senderId },
        "call_signal: invalid ICE candidate structure",
      );
      return;
    }
  } else if (signal.type === "video-state") {
    if (typeof signal.videoOff !== "boolean") return;
  } else if (signal.type === "quality-state") {
    // Self-reported connection quality so the peer can surface a
    // "<name>'s connection is unstable" banner (Teams/Meet parity).
    // Mobile already emits this every time its measured quality changes;
    // it MUST be whitelisted here or the relay drops every frame.
    if (!["good", "fair", "poor", "unknown"].includes(signal.quality)) {
      logger.warn(
        { senderId, quality: signal.quality },
        "call_signal: invalid quality-state",
      );
      return;
    }
  }

  // Verify BOTH sender and target are members of the conversation for
  // EVERY signal type (not just offer/answer). ICE/state frames were
  // previously relayed with no membership check, letting any tenant user
  // inject signaling to an arbitrary userId. Cached to survive ICE bursts.
  const senderOk = await isConversationMember(db, tenantId, conversationId, senderId);
  const targetOk = await isConversationMember(
    db,
    tenantId,
    conversationId,
    targetUserId,
  );
  if (!senderOk || !targetOk) {
    logger.warn(
      {
        senderId,
        targetUserId,
        conversationId,
        senderOk,
        targetOk,
        signalType: signal.type,
      },
      "call_signal: participant check failed",
    );
    return;
  }

  logger.debug(
    {
      senderId,
      targetUserId,
      conversationId,
      signalType: signal.type,
      tenantId,
    },
    "call_signal: relaying",
  );

  const callIdForBuffer = Number(msg.data?.callId) || 0;
  const identifiedSignal = identifyCallSignal(
    tenantId,
    callIdForBuffer,
    Number(conversationId),
    senderId,
    Number(targetUserId),
    signal,
  );

  // RELIABLE DELIVERY (Signal-Android parity): if the target has NO open
  // socket on this instance, buffer the OFFER / ICE so we can replay it the
  // moment they subscribe/accept/become ready. This is the core fix for
  // "answered but never connects / black screen / can't connect from push":
  // the caller fires its offer the instant `call_accepted` arrives, but the
  // callee's call screen needs 1–5s to mount + subscribe. Without buffering
  // that offer (and early ICE) was silently dropped and the call hung.
  // We STILL relay (sendToUser also publishes cross-instance) so a callee on
  // another instance / already-subscribed still receives it immediately.
  if (
    (signal.type === "offer" || signal.type === "ice-candidate") &&
    !hasOpenSocket(tenantId, targetUserId)
  ) {
    if (callIdForBuffer) {
      await signalStore.bufferCallSignal(
        tenantId,
        callIdForBuffer,
        senderId,
        targetUserId,
        identifiedSignal,
      );
      logger.debug(
        {
          senderId,
          targetUserId,
          conversationId,
          callId: callIdForBuffer,
          signalType: signal.type,
        },
        "call_signal: buffered for offline target",
      );
    }
  }

  // Relay the signal to the target user
  sendToUser(tenantId, targetUserId, "call_signal", {
    conversationId,
    fromUserId: senderId,
    signal: identifiedSignal,
  });
}

export async function handleCallSubscribe({
  db,
  senderId,
  tenantId,
  msg,
  sendToUser,
}: CallHandlerArgs): Promise<void> {
  // P0 — Reliable-delivery handshake. The callee's call screen sends this
  // the moment it mounts + subscribes to `call_signal`. We (1) replay any
  // OFFER/ICE that was buffered while they had no socket (single-instance
  // fast path) and (2) tell the OTHER participant(s) to re-send their offer
  // (`call_peer_ready`) so a cross-instance / never-buffered caller offer
  // is (re)delivered. The caller's offer creation is idempotent via Perfect
  // Negotiation so a duplicate is harmless.
  const { callId, conversationId } = msg.data || {};
  if (!callId || !conversationId) return;
  const isParticipant = await isConversationMember(
    db,
    tenantId,
    conversationId,
    senderId,
  );
  if (!isParticipant) return;
  // Replay buffered signals to THIS subscriber.
  await replayCallSignals(tenantId, Number(callId), senderId, (fromUserId, signal) => {
    sendToUser(tenantId, senderId, "call_signal", {
      conversationId,
      fromUserId,
      signal,
    });
  });
  // Ask the other participant(s) to (re)send their offer.
  const others = (
    await db.query(
      "SELECT user_id FROM conversation_participants WHERE conversation_id = $1 AND user_id != $2",
      [conversationId, senderId],
    )
  ).rows;
  for (const p of others) {
    sendToUser(tenantId, p.user_id, "call_peer_ready", {
      callId,
      conversationId,
      userId: senderId,
    });
  }
}

export async function handleCallReady({
  db,
  senderId,
  tenantId,
  msg,
  sendToUser,
}: CallHandlerArgs): Promise<void> {
  // P0 — The callee signals its PeerConnection exists and it is ready to
  // receive an offer. Relay to the other participant(s) so the caller
  // (re)sends its offer immediately (idempotent via Perfect Negotiation),
  // and replay any locally-buffered signals to the now-ready user.
  const { callId, conversationId } = msg.data || {};
  if (!callId || !conversationId) return;
  const isParticipant = await isConversationMember(
    db,
    tenantId,
    conversationId,
    senderId,
  );
  if (!isParticipant) return;
  await replayCallSignals(tenantId, Number(callId), senderId, (fromUserId, signal) => {
    sendToUser(tenantId, senderId, "call_signal", {
      conversationId,
      fromUserId,
      signal,
    });
  });
  const others = (
    await db.query(
      "SELECT user_id FROM conversation_participants WHERE conversation_id = $1 AND user_id != $2",
      [conversationId, senderId],
    )
  ).rows;
  for (const p of others) {
    sendToUser(tenantId, p.user_id, "call_peer_ready", {
      callId,
      conversationId,
      userId: senderId,
    });
  }
}

export async function handleCallReconnect({
  db,
  senderId,
  tenantId,
  msg,
  sendToUser,
}: CallHandlerArgs): Promise<void> {
  // User refreshed the page during an active call — notify the other party to re-offer
  const { callId, conversationId } = msg.data || {};
  if (!callId || !conversationId) return;

  const callLog = (
    await db.query(
      `SELECT * FROM call_logs WHERE id = $1 AND conversation_id = $2 AND status = 'answered'`,
      [callId, conversationId],
    )
  ).rows[0];
  if (!callLog) return;

  // Verify sender is in the conversation
  const participant = (
    await db.query(
      "SELECT 1 FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2",
      [conversationId, senderId],
    )
  ).rows[0];
  if (!participant) return;

  // Find the other participant(s) and tell them to re-offer
  const others = (
    await db.query(
      "SELECT user_id FROM conversation_participants WHERE conversation_id = $1 AND user_id != $2",
      [conversationId, senderId],
    )
  ).rows;

  for (const p of others) {
    sendToUser(tenantId, p.user_id, "call_reconnect", {
      callId,
      conversationId,
      userId: senderId,
    });
  }
}

export async function handleCallReaction({
  db,
  senderId,
  tenantId,
  msg,
  sendToUser,
}: CallHandlerArgs): Promise<void> {
  const { conversationId, targetUserId, emoji } = msg.data || {};
  if (!conversationId || !targetUserId || !emoji) return;
  const allowedEmojis = [
    "\u{1F44D}",
    "\u{1F44F}",
    "\u{2764}\u{FE0F}",
    "\u{1F602}",
    "\u{1F389}",
    "\u{1F914}",
  ];
  if (!allowedEmojis.includes(emoji)) return;
  // Both sender AND target must be in the conversation — otherwise a
  // participant could spam reactions at arbitrary users (privacy/harassment).
  const senderInConv = await isConversationMember(
    db,
    tenantId,
    conversationId,
    senderId,
  );
  if (!senderInConv) return;
  const targetInConv = await isConversationMember(
    db,
    tenantId,
    conversationId,
    targetUserId,
  );
  if (!targetInConv) return;
  sendToUser(tenantId, targetUserId, "call_reaction", {
    conversationId,
    fromUserId: senderId,
    emoji,
  });
}

export async function handleCallAddParticipant({
  db,
  senderId,
  tenantId,
  msg,
  sendToUser,
}: CallHandlerArgs): Promise<void> {
  // Add a participant to an ongoing GROUP call.
  // We only allow this on existing group conversations so a 1:1 DM
  // can never be silently mutated into a group.
  const { callId, conversationId, targetUserId } = msg.data || {};
  if (!callId || !conversationId || !targetUserId) return;

  const callLog = (
    await db.query("SELECT * FROM call_logs WHERE id = $1 AND status = $2", [
      callId,
      "answered",
    ])
  ).rows[0];
  if (!callLog) return;

  // Verify sender is in the call conversation
  const senderOk = (
    await db.query(
      "SELECT 1 FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2",
      [conversationId, senderId],
    )
  ).rows[0];
  if (!senderOk) return;

  // Refuse to upgrade a 1:1 conversation into a group via this path.
  const conv = (
    await db.query("SELECT is_group FROM conversations WHERE id = $1", [
      conversationId,
    ])
  ).rows[0];
  if (!conv || !conv.is_group) {
    logger.warn(
      { senderId, callId, conversationId, targetUserId },
      "call_add_participant: rejected — conversation is not a group",
    );
    return;
  }

  // Add target to conversation (no-op if they were already a member)
  await db.query(
    `INSERT INTO conversation_participants (conversation_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [conversationId, targetUserId],
  );

  const caller = (
    await db.query("SELECT full_name, avatar FROM users WHERE id = $1", [
      senderId,
    ])
  ).rows[0];

  // Notify target as incoming call
  sendToUser(tenantId, targetUserId, "call_incoming", {
    callId,
    conversationId,
    callerId: senderId,
    callerName: caller?.full_name,
    callerAvatar: caller?.avatar,
    callType: callLog.call_type,
    isGroup: true,
    isJoining: true,
  });

  // Send push notification for group call participant addition
  pushNotifications
    .sendCallNotification(db.query as any, targetUserId, tenantId, {
      callId,
      conversationId,
      callerId: senderId,
      callerName: caller?.full_name || "Unknown",
      callerAvatar: caller?.avatar,
      callType: callLog.call_type as "voice" | "video",
      isGroup: true,
    })
    .catch((err: any) => {
      logger.warn(
        { err: err.message, userId: targetUserId, callId },
        "Failed to send group call push notification",
      );
    });
}

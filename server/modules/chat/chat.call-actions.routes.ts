/** HTTP adapters and delivery side effects for chat endpoints. */
import express from "express";
import type { Request, Response } from "express";
const auth = require("../../middleware/auth");
const { loadUserContext } = require("../../middleware/rbac");
const { sendToUser, emitCallHistoryMessage } = require("../../utils/ws");
const redis = require("../../redis");
const { getUploadKey, getUploadUrl, getKeyFromUrl } = require("../../utils/uploadPath");
const { getStorage } = require("../../platform/storage");
import { enqueueChatMediaPipelineJob } from "../../jobs";
import { broadcastMediaJobUpdate, processChatMediaJob } from "../../services/chatMediaPipeline";
import { buildUploadedMediaMetadata, copyForwardedMediaMetadata } from "../../utils/chatMediaMetadata";
const { canDo, loadGroupContext } = require("../../utils/groupPerms");
import { ChatError } from "./chat.types";
import { parseMessageId, parseConversationId, parseCreateGroupConversation, parseDirectConversationUserId, parseEmoji, parseUserId } from "./chat.schema";
import { service, db, type DbLike, chatUpload, chatFilename, deleteChatObject, verifyParticipant, verifyReplyTarget, getUserOrg, emitSystemMessage } from "./chat.shared";

const router = express.Router();

router.post(
  "/calls/:callId/reject",
  auth,
  async (req: Request, res: Response) => {
    try {
      const callId = parseInt(String(req.params.callId), 10);
      const conversationId = parseInt(
        String((req.body || {}).conversationId),
        10,
      );
      const senderId = req.userId!;
      const tenantId = req.tenantId!;
      if (isNaN(callId) || isNaN(conversationId)) {
        return res
          .status(400)
          .json({ error: "callId and conversationId are required" });
      }

      // Verify the rejecter is a participant in the conversation.
      const isParticipant = (
        await service.query(req.db!, "q001", [conversationId, senderId])
      ).rows[0];
      if (!isParticipant)
        return res.status(403).json({ error: "Not a participant" });

      const callLog = (
        await service.query(req.db!, "q079", [callId, conversationId])
      ).rows[0];
      if (!callLog) return res.status(404).json({ error: "Call not found" });

      // Already handled (answered/declined/ended). Treat as success so the
      // client can stop ringing without erroring.
      if (callLog.status !== "ringing") {
        return res.json({ ok: true, status: callLog.status });
      }

      const updated = await service.query(req.db!, "q080", [callId]);
      if (!updated.rows[0]) {
        // Lost the race to another path — still a success from the client's view.
        return res.json({ ok: true, status: "declined" });
      }

      const rejecter = (
        await service.query(req.db!, "q011", [
          senderId,
        ])
      ).rows[0];

      // Notify the other participants so the caller's ring stops.
      const participants = (
        await service.query(req.db!, "q033", [conversationId, senderId])
      ).rows;
      for (const p of participants) {
        sendToUser(tenantId, p.user_id, "call_rejected", {
          callId,
          conversationId,
          userId: senderId,
          userName: rejecter?.full_name,
        });
      }

      // Dismiss the ringing PiP on the rejecter's OTHER devices.
      sendToUser(tenantId, senderId, "call_handled_elsewhere", {
        callId,
        conversationId,
        action: "rejected",
      });

      // Push-cancel the rejecter's OTHER devices (locked/backgrounded twin)
      // and the caller's devices so a backgrounded ring is dismissed even
      // when the WS dismiss above doesn't reach a killed/locked device.
      try {
        const { pushNotifications } = require("../../services/pushNotifications");
        pushNotifications
          .sendCallCancellation(req.db!.query, senderId, tenantId, {
            callId,
            conversationId,
            reason: "rejected",
          })
          .catch((err: any) =>
            req.log.warn(
              { err: err.message, callId, userId: senderId },
              "Failed to push-cancel rejecter devices on HTTP reject",
            ),
          );
        pushNotifications
          .sendCallCancellation(req.db!.query, callLog.caller_id, tenantId, {
            callId,
            conversationId,
            reason: "rejected",
          })
          .catch((err: any) =>
            req.log.warn(
              { err: err.message, callId, userId: callLog.caller_id },
              "Failed to push-cancel caller devices on HTTP reject",
            ),
          );
      } catch {
        /* push cancellation is best-effort */
      }

      // Clear any in_call status that a racy accept/initiate may have set.
      try {
        const statusService = require("../../services/status");
        await statusService.clearActivityForRef(
          { db: req.db, tenantId },
          "in_call",
          callId,
        );
      } catch {
        /* status update is best-effort */
      }

      res.json({ ok: true, status: "declined" });
    } catch (err) {
      req.log.error({ err }, "HTTP call reject error");
      res.status(500).json({ error: "Failed to reject call" });
    }
  },
);

router.post(
  "/calls/:callId/accept",
  auth,
  async (req: Request, res: Response) => {
    try {
      const callId = parseInt(String(req.params.callId), 10);
      const conversationId = parseInt(
        String((req.body || {}).conversationId),
        10,
      );
      const senderId = req.userId!;
      const tenantId = req.tenantId!;
      if (isNaN(callId) || isNaN(conversationId)) {
        return res
          .status(400)
          .json({ error: "callId and conversationId are required" });
      }

      const [callLogResult, participantResult] = await Promise.all([
        service.query(req.db!, "q079", [callId, conversationId]),
        service.query(req.db!, "q001", [conversationId, senderId]),
      ]);
      const callLog = callLogResult.rows[0];
      if (!callLog) return res.status(404).json({ error: "Call not found" });
      if (!participantResult.rows[0])
        return res.status(403).json({ error: "Not a participant" });
      if (callLog.status !== "ringing") {
        return res.json({ ok: true, status: callLog.status });
      }

      const [updatedCall, accepterResult] = await Promise.all([
        service.query(req.db!, "q081", [callId]),
        service.query(req.db!, "q082", [
          senderId,
        ]),
      ]);
      if (!updatedCall.rows[0]) {
        return res.json({ ok: true, status: "answered" });
      }
      const accepter = accepterResult.rows[0];

      // Notify the caller that the call was accepted so they create the offer.
      sendToUser(tenantId, callLog.caller_id, "call_accepted", {
        callId,
        conversationId,
        userId: senderId,
        userName: accepter?.full_name,
        userAvatar: accepter?.avatar,
      });

      // Dismiss the ring on the accepter's OTHER devices.
      sendToUser(tenantId, senderId, "call_handled_elsewhere", {
        callId,
        conversationId,
        action: "accepted",
      });

      // Push-cancel the accepter's OTHER devices (locked/backgrounded twin)
      // so the native incoming-call ring stops once accepted here.
      try {
        const { pushNotifications } = require("../../services/pushNotifications");
        pushNotifications
          .sendCallCancellation(req.db!.query, senderId, tenantId, {
            callId,
            conversationId,
            reason: "accepted",
          })
          .catch((err: any) =>
            req.log.warn(
              { err: err.message, callId, userId: senderId },
              "Failed to push-cancel accepter devices on HTTP accept",
            ),
          );
      } catch {
        /* push cancellation is best-effort */
      }

      res.json({ ok: true, status: "answered" });
    } catch (err) {
      req.log.error({ err }, "HTTP call accept error");
      res.status(500).json({ error: "Failed to accept call" });
    }
  },
);

router.post("/calls/:callId/end", auth, async (req: Request, res: Response) => {
  try {
    const callId = parseInt(String(req.params.callId), 10);
    const conversationId = parseInt(
      String((req.body || {}).conversationId),
      10,
    );
    const senderId = req.userId!;
    const tenantId = req.tenantId!;
    if (isNaN(callId) || isNaN(conversationId)) {
      return res
        .status(400)
        .json({ error: "callId and conversationId are required" });
    }

    const isParticipant = (
      await service.query(req.db!, "q001", [conversationId, senderId])
    ).rows[0];
    if (!isParticipant)
      return res.status(403).json({ error: "Not a participant" });

    const callLog = (
      await service.query(req.db!, "q079", [callId, conversationId])
    ).rows[0];
    if (!callLog) return res.status(404).json({ error: "Call not found" });

    // Already terminal — treat as success so the client can move on.
    if (["ended", "missed", "declined"].includes(callLog.status)) {
      return res.json({ ok: true, status: callLog.status });
    }

    let duration: number | null = null;
    if (callLog.started_at) {
      duration = Math.round(
        (Date.now() - new Date(callLog.started_at).getTime()) / 1000,
      );
    }

    const updated = await service.query(req.db!, "q083", [callId, duration]);
    if (!updated.rows[0]) {
      return res.json({ ok: true, status: "ended" });
    }

    // Notify the other participants so their call UI / banner clears.
    const allParticipants = (
      await service.query(req.db!, "q006", [conversationId])
    ).rows;
    for (const p of allParticipants) {
      if (p.user_id !== senderId) {
        sendToUser(tenantId, p.user_id, "call_ended", {
          callId,
          conversationId,
          endedBy: senderId,
          duration,
        });

        // P2.13 — Decline/end teardown parity. The WS `call_ended` above
        // only reaches sessions with a live socket; a locked/backgrounded/
        // killed twin keeps its native incoming-call ring / ongoing-call
        // notification until this data-only "call handled elsewhere" push
        // dismisses it. Mirrors the WS call_end handler + reject/cancel
        // HTTP fallbacks so HTTP-end (WS-down) tears down twins too.
        try {
          const {
            pushNotifications,
          } = require("../../services/pushNotifications");
          pushNotifications
            .sendCallCancellation(req.db!.query, p.user_id, tenantId, {
              callId,
              conversationId,
              reason: "ended",
            })
            .catch((err: any) =>
              req.log.warn(
                { err: err.message, callId, userId: p.user_id },
                "Failed to push-cancel participant devices on HTTP end",
              ),
            );
        } catch {
          /* push is best-effort */
        }
      }
    }

    // Clear in_call for every session referencing this call (caller + all
    // callees, across devices) so presence + the active-call liveness guard
    // both stop reporting the call as live.
    try {
      const statusService = require("../../services/status");
      await statusService.clearActivityForRef(
        { db: req.db, tenantId },
        "in_call",
        callId,
      );
    } catch {
      /* status update is best-effort */
    }

    // Inline call-history row in the chat thread (parity with the WS call_end
    // handler) so a call ended via this HTTP fallback still appears inline.
    try {
      await emitCallHistoryMessage(
        req.db,
        tenantId,
        conversationId,
        callLog.caller_id,
        callLog.call_type,
        callLog.status === "ringing" ? "missed" : "ended",
        duration,
      );
    } catch {
      /* best-effort */
    }

    res.json({ ok: true, status: "ended" });
  } catch (err) {
    req.log.error({ err }, "HTTP call end error");
    res.status(500).json({ error: "Failed to end call" });
  }
});

export default router;

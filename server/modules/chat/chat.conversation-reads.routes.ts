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

router.get("/conversations", auth, async (req: Request, res: Response) => {
  try {
    const rows = (
      await service.query(req.db!, "q030", [req.userId])
    ).rows;

    // Overlay Redis unread counts if available (faster than the SQL subquery)
    if (rows.length > 0) {
      const convIds = rows.map((r: { id: number }) => r.id);
      const redisCounts = await redis.getUnreadCounts(
        req.tenantId,
        req.userId,
        convIds,
      );
      if (redisCounts) {
        for (const row of rows) {
          row.unread_count = redisCounts[row.id] ?? row.unread_count;
        }
      }
    }

    res.json(rows);
  } catch (err) {
    req.log.error({ err }, "List conversations error");
    res.status(500).json({ error: "Failed to list conversations" });
  }
});

router.get(
  "/conversations/:id/messages",
  auth,
  async (req: Request, res: Response) => {
    try {
      const convId = parseInt(String(req.params.id), 10);
      if (isNaN(convId))
        return res.status(400).json({ error: "Invalid conversation" });

      if (
        !(await verifyParticipant(
          convId,
          req.userId,
          req.db as unknown as DbLike,
        ))
      ) {
        return res.status(403).json({ error: "Not a participant" });
      }

      const limit = Math.min(parseInt(String(req.query.limit), 10) || 50, 100);
      const before = parseInt(String(req.query.before), 10) || null;

      const rows = (
        await service.listMessages(req.db!, req.userId!, convId, before, limit)
      ).rows;

      // Fetch reactions for these messages
      if (rows.length > 0) {
        const msgIds = rows.map((r: { id: number }) => r.id);
        const reactions = (
          await service.query(req.db!, "q031", [msgIds])
        ).rows;

        const reactionMap: Record<
          number,
          Array<{ emoji: string; userId: number; fullName: string }>
        > = {};
        for (const r of reactions) {
          if (!reactionMap[r.message_id]) reactionMap[r.message_id] = [];
          reactionMap[r.message_id].push({
            emoji: r.emoji,
            userId: r.user_id,
            fullName: r.full_name,
          });
        }
        for (const row of rows) {
          row.reactions = row.deleted_at ? [] : reactionMap[row.id] || [];
        }
      }

      res.json(rows.reverse());
    } catch (err) {
      req.log.error({ err }, "Get messages error");
      res.status(500).json({ error: "Failed to get messages" });
    }
  },
);

router.post(
  "/conversations/:id/read",
  auth,
  async (req: Request, res: Response) => {
    try {
      const convId = parseInt(String(req.params.id), 10);
      if (isNaN(convId))
        return res.status(400).json({ error: "Invalid conversation" });

      if (
        !(await verifyParticipant(
          convId,
          req.userId,
          req.db as unknown as DbLike,
        ))
      ) {
        return res.status(403).json({ error: "Not a participant" });
      }

      await service.query(req.db!, "q032", [convId, req.userId]);
      redis.resetUnread(req.tenantId, req.userId, convId);

      // Notify others about read receipt
      const participants = (
        await service.query(req.db!, "q033", [convId, req.userId])
      ).rows;
      for (const p of participants) {
        sendToUser(req.tenantId, p.user_id, "chat_read_receipt", {
          conversationId: convId,
          userId: req.userId,
          readAt: new Date().toISOString(),
        });
      }

      res.json({ ok: true });
    } catch (err) {
      req.log.error({ err }, "Mark read error");
      res.status(500).json({ error: "Failed to mark as read" });
    }
  },
);

router.get(
  "/conversations/:id/read-status",
  auth,
  async (req: Request, res: Response) => {
    try {
      const convId = parseInt(String(req.params.id), 10);
      if (isNaN(convId))
        return res.status(400).json({ error: "Invalid conversation" });
      if (
        !(await verifyParticipant(
          convId,
          req.userId,
          req.db as unknown as DbLike,
        ))
      ) {
        return res.status(403).json({ error: "Not a participant" });
      }

      // Reciprocal read receipts (Signal parity): if the CALLER has turned
      // receipts off they see nobody's read state; and readers who turned
      // their receipts off are excluded from everyone's results.
      //
      // Both conditions are folded into a SINGLE statement. This used to be
      // two sequential round-trips (fetch caller's pref, then the receipts),
      // which doubled the latency of an endpoint that sits on the
      // conversation-open path. The `me` CTE short-circuits via the WHERE:
      // if the caller has receipts off, the cross join yields no rows.
      const rows = (
        await service.query(req.db!, "q034", [convId, req.userId])
      ).rows;

      res.json(rows);
    } catch (err) {
      req.log.error({ err }, "Read status error");
      res.status(500).json({ error: "Failed to get read status" });
    }
  },
);

export default router;

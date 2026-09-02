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
  "/media-jobs/:id/cancel",
  auth,
  async (req: Request, res: Response) => {
    try {
      const mediaJobId = parseInt(String(req.params.id), 10);
      if (isNaN(mediaJobId))
        return res.status(400).json({ error: "Invalid media job" });
      const row = (
        await service.query(req.db!, "q044", [mediaJobId])
      ).rows[0];
      if (!row) return res.status(404).json({ error: "Media job not found" });
      if (
        !(await verifyParticipant(
          row.conversation_id,
          req.userId,
          req.db as unknown as DbLike,
        ))
      ) {
        return res.status(403).json({ error: "Not a participant" });
      }
      if (!["queued", "processing"].includes(row.status)) {
        return res.status(400).json({ error: "Media job cannot be cancelled" });
      }
      await service.query(req.db!, "q045", [mediaJobId]);
      const participants = (
        await service.query(req.db!, "q006", [row.conversation_id])
      ).rows;
      broadcastMediaJobUpdate({
        tenantId: req.tenantId ? Number(req.tenantId) : null,
        participants,
        messageId: row.message_id,
        conversationId: row.conversation_id,
        mediaJobId,
        status: "cancelled",
        stage: "cancelled",
        progress: 0,
        failureReason: "cancelled-by-user",
        pipelineMeta: { stage: "cancelled" },
      });
      res.json({ ok: true });
    } catch (err) {
      req.log.error({ err }, "Cancel media job error");
      res.status(500).json({ error: "Failed to cancel media job" });
    }
  },
);

router.post(
  "/media-jobs/:id/retry",
  auth,
  async (req: Request, res: Response) => {
    try {
      const mediaJobId = parseInt(String(req.params.id), 10);
      if (isNaN(mediaJobId))
        return res.status(400).json({ error: "Invalid media job" });
      const row = (
        await service.query(req.db!, "q046", [mediaJobId])
      ).rows[0];
      if (!row) return res.status(404).json({ error: "Media job not found" });
      if (
        !(await verifyParticipant(
          row.conversation_id,
          req.userId,
          req.db as unknown as DbLike,
        ))
      ) {
        return res.status(403).json({ error: "Not a participant" });
      }
      if (row.sender_id !== req.userId) {
        return res
          .status(403)
          .json({ error: "Only sender can retry media job" });
      }
      if (!["failed", "cancelled"].includes(row.status)) {
        return res.status(400).json({ error: "Media job is not retryable" });
      }

      await service.query(req.db!, "q047", [mediaJobId]);
      const participants = (
        await service.query(req.db!, "q006", [row.conversation_id])
      ).rows;
      broadcastMediaJobUpdate({
        tenantId: req.tenantId ? Number(req.tenantId) : null,
        participants,
        messageId: row.message_id,
        conversationId: row.conversation_id,
        mediaJobId,
        status: "queued",
        stage: "queued",
        progress: 0,
        failureReason: null,
        pipelineMeta: { stage: "queued" },
      });

      setTimeout(() => {
        const tenantDbName = String(req.tenant?.db_name || "");
        const run = tenantDbName
          ? enqueueChatMediaPipelineJob({
              tenantId: Number(req.tenant?.id || req.tenantId || 0),
              tenantDbName,
              tenantDbHost: (req.tenant?.db_host as string | null) || null,
              mediaJobId,
              messageId: row.message_id,
              conversationId: row.conversation_id,
            })
          : processChatMediaJob({
              query: (req.db as unknown as DbLike).query,
              tenantId: req.tenantId ? Number(req.tenantId) : null,
              mediaJobId,
              messageId: row.message_id,
              conversationId: row.conversation_id,
            });
        run.catch((err) => {
          req.log.error({ err, mediaJobId }, "Retry media job pipeline failed");
        });
      }, 0);

      res.json({ ok: true, mediaJobId });
    } catch (err) {
      req.log.error({ err }, "Retry media job error");
      res.status(500).json({ error: "Failed to retry media job" });
    }
  },
);

export default router;

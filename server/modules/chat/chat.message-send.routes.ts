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

      const conversation = (
        await service.query(req.db!, "q035", [convId])
      ).rows[0];

      // Block enforcement (direct chats only, Signal parity): if either side
      // has blocked the other, the message is rejected. Group messages are
      // NOT filtered (matches Signal).
      if (conversation && !conversation.is_group) {
        const blockedPair = (
          await service.query(req.db!, "q036", [convId, req.userId])
        ).rows[0];
        if (blockedPair) {
          return res
            .status(403)
            .json({ error: "Cannot send message", code: "blocked" });
        }
      }

      const content = String(req.body.content ?? "").trim();
      if (!content)
        return res.status(400).json({ error: "Message content required" });
      if (content.length > 5000) {
        return res.status(400).json({ error: "Message too long" });
      }
      const replyToId = req.body.replyToId
        ? parseInt(String(req.body.replyToId), 10)
        : null;
      if (
        (replyToId !== null && !Number.isInteger(replyToId)) ||
        !(await verifyReplyTarget(
          convId,
          replyToId,
          req.db as unknown as DbLike,
        ))
      ) {
        return res.status(400).json({ error: "Invalid reply target" });
      }

      const result = (
        await service.query(req.db!, "q037", [convId, req.userId, content, replyToId])
      ).rows[0];

      await service.query(req.db!, "q005", [convId]);
      await service.query(req.db!, "q038", [convId, req.userId, result.created_at]);

      const sender = (
        await service.query(req.db!, "q039", [req.userId])
      ).rows[0];

      // Reply context (so the recipient's bubble can render the quoted message).
      let replyContent: string | null = null;
      let replySenderName: string | null = null;
      let replyFileUrl: string | null = null;
      let replyFileType: string | null = null;
      let replyFileName: string | null = null;
      if (replyToId) {
        const replyMsg = (
          await service.query(req.db!, "q040", [replyToId, convId])
        ).rows[0];
        if (replyMsg) {
          replyContent = replyMsg.content;
          replySenderName = replyMsg.sender_name;
          replyFileUrl = replyMsg.file_url;
          replyFileType = replyMsg.file_type;
          replyFileName = replyMsg.file_name;
        }
      }

      const participants = (
        await service.query(req.db!, "q006", [convId])
      ).rows;

      // WebSocket payload — camelCase (matches the WS chat_message handler so
      // the client maps these to snake_case message fields identically).
      const wsMsg = {
        id: result.id,
        conversationId: convId,
        senderId: req.userId,
        senderName: sender?.full_name,
        senderAvatar: sender?.avatar,
        senderUsername: sender?.username,
        content,
        replyToId,
        replyContent,
        replySenderName,
        replyFileUrl,
        replyFileType,
        replyFileName,
        createdAt: result.created_at,
      };

      for (const p of participants) {
        sendToUser(req.tenantId, p.user_id, "chat_message", wsMsg);
        if (p.user_id !== req.userId) {
          redis.incrUnread(req.tenantId, p.user_id, convId);
          // Recipient total-unread badge + message push (best-effort; must
          // not block the send). Mirrors the WS handler's push dispatch.
          void (async () => {
            let unreadTotal: number | undefined;
            try {
              const row = (
                await service.query(req.db!, "q041", [p.user_id])
              ).rows[0];
              unreadTotal = row?.unread ?? undefined;
            } catch (err: any) {
              req.log.warn(
                { err: err?.message, userId: p.user_id },
                "Failed to compute total unread for badge",
              );
            }
            try {
              const {
                pushNotifications,
              } = require("../../services/pushNotifications");
              await pushNotifications.sendMessageNotification(
                (req.db as unknown as DbLike).query,
                p.user_id,
                req.tenantId,
                {
                  conversationId: convId,
                  messageId: result.id,
                  senderId: req.userId,
                  senderName: sender?.full_name || "Unknown",
                  senderAvatar: sender?.avatar,
                  isGroup: Boolean(conversation?.is_group),
                  groupName: conversation?.group_name || undefined,
                  messagePreview: content.substring(0, 150),
                  unreadCount: unreadTotal,
                },
              );
            } catch (err: any) {
              req.log.warn(
                { err: err?.message, userId: p.user_id, messageId: result.id },
                "Failed to send message push notification",
              );
            }
          })();
        }
      }

      // HTTP response — snake_case, matching GET /messages so the client can
      // reconcile the optimistic bubble 1:1.
      res.status(201).json({
        id: result.id,
        conversation_id: convId,
        sender_id: req.userId,
        sender_name: sender?.full_name,
        sender_avatar: sender?.avatar,
        sender_username: sender?.username,
        content,
        created_at: result.created_at,
        reply_to_id: replyToId,
        reply_to_content: replyContent,
        reply_to_sender_name: replySenderName,
        reply_to_file_url: replyFileUrl,
        reply_to_file_type: replyFileType,
        reply_to_file_name: replyFileName,
        reactions: [],
        delivered_to: [],
      });
    } catch (err) {
      req.log.error({ err }, "Send message error");
      res.status(500).json({ error: "Failed to send message" });
    }
  },
);

router.post(
  "/conversations/:id/files",
  auth,
  loadUserContext,
  chatUpload.single("file"),
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

      if (!req.file) return res.status(400).json({ error: "No file uploaded" });

      // Sanitize the display name: strip control chars, path separators, limit length
      const safeName =
        (req.file.originalname || "file")
          .replace(/[^\x20-\x7E\u00A0-\uFFFF]/g, "") // strip control characters
          .replace(/[/\\]/g, "_") // no path separators
          .slice(0, 255) || "file";

      const storedName = chatFilename(req.userId, req.file.mimetype);
      const fileKey = getUploadKey(
        req.tenantId,
        req.userOrgId,
        "chat",
        storedName,
      );
      const fileUrl = getUploadUrl(
        req.tenantId,
        req.userOrgId,
        "chat",
        storedName,
      );

      // Store the object BEFORE inserting the message so a row can never
      // reference a key that does not exist.
      try {
        await getStorage().put(fileKey, req.file.buffer, {
          contentType: req.file.mimetype,
        });
      } catch (err) {
        req.log.error({ err, key: fileKey }, "Chat attachment upload failed");
        return res.status(500).json({ error: "Failed to store attachment" });
      }

      const content = req.body.content || null;
      const replyToId = req.body.replyToId
        ? parseInt(req.body.replyToId, 10)
        : null;
      if (
        (replyToId !== null && !Number.isInteger(replyToId)) ||
        !(await verifyReplyTarget(
          convId,
          replyToId,
          req.db as unknown as DbLike,
        ))
      ) {
        return res.status(400).json({ error: "Invalid reply target" });
      }
      // View-once (disappearing media): the composer sends viewOnce="true".
      // We persist it in the message metadata JSONB (no schema change) and
      // strip the file URL for a recipient once they've opened it.
      const metadata = buildUploadedMediaMetadata(req.body);

      const result = (
        await service.query(req.db!, "q042", [
            convId,
            req.userId,
            content,
            fileUrl,
            safeName,
            req.file.mimetype,
            req.file.size,
            replyToId,
            metadata ? JSON.stringify(metadata) : null,
          ])
      ).rows[0];
      const mediaJob = (
        await service.query(req.db!, "q043", [result.id, convId, req.userId])
      ).rows[0];

      await service.query(req.db!, "q005", [convId]);
      await service.query(req.db!, "q038", [convId, req.userId, result.created_at]);

      const sender = (
        await service.query(req.db!, "q039", [req.userId])
      ).rows[0];

      // Reply context (so the recipient's bubble can render the quoted message
      // when replying WITH a file/image).
      let replyContent: string | null = null;
      let replySenderName: string | null = null;
      let replyFileUrl: string | null = null;
      let replyFileType: string | null = null;
      let replyFileName: string | null = null;
      if (replyToId) {
        const replyMsg = (
          await service.query(req.db!, "q040", [replyToId, convId])
        ).rows[0];
        if (replyMsg) {
          replyContent = replyMsg.content;
          replySenderName = replyMsg.sender_name;
          replyFileUrl = replyMsg.file_url;
          replyFileType = replyMsg.file_type;
          replyFileName = replyMsg.file_name;
        }
      }

      const participants = (
        await service.query(req.db!, "q006", [convId])
      ).rows;

      // WebSocket payload — camelCase (the client WS handler maps these to
      // snake_case message fields). Broadcast to all participants.
      const wsMsg = {
        id: result.id,
        conversationId: convId,
        senderId: req.userId,
        senderName: sender.full_name,
        senderAvatar: sender.avatar,
        senderUsername: sender.username,
        content,
        fileUrl,
        fileName: safeName,
        fileType: req.file.mimetype,
        fileSize: req.file.size,
        replyToId,
        replyContent,
        replySenderName,
        replyFileUrl,
        replyFileType,
        replyFileName,
        createdAt: result.created_at,
        metadata,
        mediaJobId: mediaJob.id,
        mediaState: mediaJob.status,
        mediaStage: mediaJob.stage,
        mediaProgress: mediaJob.progress,
        mediaPipelineMeta: mediaJob.pipeline_meta,
      };

      for (const p of participants) {
        sendToUser(req.tenantId, p.user_id, "chat_message", wsMsg);
        if (p.user_id !== req.userId) {
          redis.incrUnread(req.tenantId, p.user_id, convId);
        }
      }

      // HTTP response — snake_case, matching GET /messages exactly so the
      // optimistic media message can be replaced 1:1 without losing
      // file_url / created_at / media_* (prevents "Invalid date" and the
      // disappearing-image-until-reopen bug).
      const outMsg = {
        id: result.id,
        conversation_id: convId,
        sender_id: req.userId,
        sender_name: sender.full_name,
        sender_avatar: sender.avatar,
        sender_username: sender.username,
        content,
        created_at: result.created_at,
        file_url: fileUrl,
        file_name: safeName,
        file_type: req.file.mimetype,
        file_size: req.file.size,
        reply_to_id: replyToId,
        reply_to_content: replyContent,
        reply_to_sender_name: replySenderName,
        reply_to_file_url: replyFileUrl,
        reply_to_file_type: replyFileType,
        reply_to_file_name: replyFileName,
        metadata,
        media_job_id: mediaJob.id,
        media_state: mediaJob.status,
        media_stage: mediaJob.stage,
        media_progress: mediaJob.progress,
        media_pipeline_meta: mediaJob.pipeline_meta,
        reactions: [],
        delivered_to: [],
      };

      // Queue staged media processing in BullMQ (prepare -> transform ->
      // upload -> finalize). Falls back to immediate processing when queues
      // are unavailable.
      setTimeout(() => {
        const tenantDbName = String(req.tenant?.db_name || "");
        const run = tenantDbName
          ? enqueueChatMediaPipelineJob({
              tenantId: Number(req.tenant?.id || req.tenantId || 0),
              tenantDbName,
              tenantDbHost: (req.tenant?.db_host as string | null) || null,
              mediaJobId: mediaJob.id,
              messageId: result.id,
              conversationId: convId,
            })
          : processChatMediaJob({
              query: (req.db as unknown as DbLike).query,
              tenantId: req.tenantId ? Number(req.tenantId) : null,
              mediaJobId: mediaJob.id,
              messageId: result.id,
              conversationId: convId,
            });
        run.catch((err) => {
          req.log.error(
            { err, mediaJobId: mediaJob.id },
            "Media job pipeline failed",
          );
        });
      }, 0);

      res.status(201).json(outMsg);
    } catch (err) {
      req.log.error({ err }, "File upload error");
      res.status(500).json({ error: "Failed to upload file" });
    }
  },
);

export default router;

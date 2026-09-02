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

router.put("/messages/:id", auth, async (req: Request, res: Response) => {
  try {
    const msgId = parseInt(String(req.params.id), 10);
    if (isNaN(msgId)) return res.status(400).json({ error: "Invalid message" });

    const { content } = req.body;
    if (
      !content ||
      typeof content !== "string" ||
      content.trim().length === 0 ||
      content.length > 5000
    ) {
      return res.status(400).json({ error: "Invalid content" });
    }

    const msg = (
      await service.query(req.db!, "q048", [msgId])
    ).rows[0];
    if (!msg) return res.status(404).json({ error: "Message not found" });
    if (msg.sender_id !== req.userId)
      return res.status(403).json({ error: "Can only edit own messages" });
    if (msg.deleted_at)
      return res.status(400).json({ error: "Message is deleted" });

    await service.query(req.db!, "q049", [content.trim(), msgId]);

    const participants = (
      await service.query(req.db!, "q006", [msg.conversation_id])
    ).rows;

    for (const p of participants) {
      sendToUser(req.tenantId, p.user_id, "chat_edit", {
        messageId: msgId,
        conversationId: msg.conversation_id,
        content: content.trim(),
        editedAt: new Date().toISOString(),
      });
    }

    res.json({ ok: true });
  } catch (err) {
    req.log.error({ err }, "Edit message error");
    res.status(500).json({ error: "Failed to edit message" });
  }
});

router.delete("/messages/:id", auth, async (req: Request, res: Response) => {
  try {
    const msgId = parseInt(String(req.params.id), 10);
    if (isNaN(msgId)) return res.status(400).json({ error: "Invalid message" });

    const msg = (
      await service.query(req.db!, "q048", [msgId])
    ).rows[0];
    if (!msg) return res.status(404).json({ error: "Message not found" });
    if (msg.sender_id !== req.userId)
      return res.status(403).json({ error: "Can only delete own messages" });
    if (msg.deleted_at)
      return res.status(400).json({ error: "Already deleted" });

    await service.query(req.db!, "q050", [msgId]);
    await service.query(req.db!, "q051", [
      msgId,
    ]);

    const participants = (
      await service.query(req.db!, "q006", [msg.conversation_id])
    ).rows;

    for (const p of participants) {
      sendToUser(req.tenantId, p.user_id, "chat_delete", {
        messageId: msgId,
        conversationId: msg.conversation_id,
      });
    }

    // Pass the message id: its own row is soft-deleted above, but the check
    // must not count it regardless of statement ordering.
    await deleteChatObject(msg.file_url, req.db as unknown as DbLike, msgId);

    res.json({ ok: true });
  } catch (err) {
    req.log.error({ err }, "Delete message error");
    res.status(500).json({ error: "Failed to delete message" });
  }
});

router.get("/search-messages", auth, async (req: Request, res: Response) => {
  try {
    const { q, convId } = req.query as { q?: string; convId?: string };
    if (!q || q.trim().length < 2) return res.json([]);

    const orgId = await getUserOrg(req.userId, req.db as unknown as DbLike);
    if (!orgId) return res.json([]);

    const searchPattern = `%${q.trim().replace(/[%_]/g, (c) => `\\${c}`)}%`;
    let conversationId: number | null = null;

    if (convId) {
      const cId = parseInt(convId, 10);
      if (isNaN(cId))
        return res.status(400).json({ error: "Invalid conversation" });
      if (
        !(await verifyParticipant(cId, req.userId, req.db as unknown as DbLike))
      ) {
        return res.status(403).json({ error: "Not a participant" });
      }

      conversationId = cId;
    }

    const rows = (
      await service.searchMessages(req.db!, req.userId!, conversationId, searchPattern)
    ).rows;
    res.json(rows);
  } catch (err) {
    req.log.error({ err }, "Search messages error");
    res.status(500).json({ error: "Search failed" });
  }
});

router.post(
  "/messages/:id/forward",
  auth,
  async (req: Request, res: Response) => {
    try {
      const msgId = parseInt(String(req.params.id), 10);
      if (isNaN(msgId))
        return res.status(400).json({ error: "Invalid message" });

      const { conversationIds } = req.body;
      if (!Array.isArray(conversationIds) || conversationIds.length === 0) {
        return res.status(400).json({ error: "No conversations selected" });
      }
      if (conversationIds.length > 20) {
        return res.status(400).json({
          error: "Cannot forward to more than 20 conversations at once",
        });
      }

      const original = (
        await service.query(req.db!, "q052", [msgId])
      ).rows[0];
      if (!original)
        return res.status(404).json({ error: "Message not found" });
      if (
        !(await verifyParticipant(
          original.conversation_id,
          req.userId,
          req.db as unknown as DbLike,
        ))
      ) {
        return res.status(403).json({ error: "Not a participant" });
      }

      const sender = (
        await service.query(req.db!, "q039", [req.userId])
      ).rows[0];
      const forwardedMetadata = copyForwardedMediaMetadata(original.metadata);

      for (const cId of conversationIds) {
        const convIdNum = parseInt(cId, 10);
        if (isNaN(convIdNum)) continue;
        if (
          !(await verifyParticipant(
            convIdNum,
            req.userId,
            req.db as unknown as DbLike,
          ))
        )
          continue;

        const result = (
          await service.query(req.db!, "q053", [
              convIdNum,
              req.userId,
              original.content,
              original.file_url,
              original.file_name,
              original.file_type,
              original.file_size,
              msgId,
              forwardedMetadata ? JSON.stringify(forwardedMetadata) : null,
            ])
        ).rows[0];

        await service.query(req.db!, "q005", [convIdNum]);

        await service.query(req.db!, "q054", [convIdNum, req.userId, result.created_at]);

        const participants = (
          await service.query(req.db!, "q006", [convIdNum])
        ).rows;

        const outMsg = {
          id: result.id,
          conversationId: convIdNum,
          senderId: req.userId,
          senderName: sender.full_name,
          senderAvatar: sender.avatar,
          senderUsername: sender.username,
          content: original.content,
          fileUrl: original.file_url,
          fileName: original.file_name,
          fileType: original.file_type,
          fileSize: original.file_size,
          forwardedFromId: msgId,
          metadata: forwardedMetadata,
          createdAt: result.created_at,
        };

        for (const p of participants) {
          sendToUser(req.tenantId, p.user_id, "chat_message", outMsg);
          if (p.user_id !== req.userId) {
            redis.incrUnread(req.tenantId, p.user_id, convIdNum);
          }
        }
      }

      res.json({ ok: true });
    } catch (err) {
      req.log.error({ err }, "Forward message error");
      res.status(500).json({ error: "Failed to forward message" });
    }
  },
);

export default router;

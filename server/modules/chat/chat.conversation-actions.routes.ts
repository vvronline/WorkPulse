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

router.get(
  "/conversations/:id/files",
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

      const rows = (
        await service.query(req.db!, "q064", [convId])
      ).rows;

      res.json(rows);
    } catch (err) {
      req.log.error({ err }, "Get shared files error");
      res.status(500).json({ error: "Failed to get shared files" });
    }
  },
);

router.post(
  "/conversations/:id/unread",
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
      // Find the latest message NOT sent by this user; set last_read_at to
      // one second before it so it (and anything newer) counts as unread.
      const latest = (
        await service.query(req.db!, "q065", [convId, req.userId])
      ).rows[0];
      if (!latest) {
        // Nothing from others to mark unread.
        return res.json({ ok: true, unread: false });
      }
      await service.query(req.db!, "q066", [convId, req.userId, latest.created_at]);
      redis.resetUnread(req.tenantId, req.userId, convId);
      res.json({ ok: true, unread: true });
    } catch (err) {
      req.log.error({ err }, "Mark unread error");
      res.status(500).json({ error: "Failed to mark unread" });
    }
  },
);

router.delete(
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

      // Only group creator or 1-on-1 participants can clear all messages
      const conv = (
        await service.query(req.db!, "q067", [convId])
      ).rows[0];
      if (conv?.is_group && conv.created_by && conv.created_by !== req.userId) {
        return res
          .status(403)
          .json({ error: "Only the group creator can clear all messages" });
      }

      await service.query(req.db!, "q068", [
        convId,
      ]);
      await service.query(req.db!, "q005", [convId]);

      // Notify all participants
      const participants = (
        await service.query(req.db!, "q006", [convId])
      ).rows;

      for (const p of participants) {
        sendToUser(req.tenantId, p.user_id, "chat_cleared", {
          conversationId: convId,
        });
      }

      res.json({ ok: true });
    } catch (err) {
      req.log.error({ err }, "Clear chat error");
      res.status(500).json({ error: "Failed to clear chat" });
    }
  },
);

router.delete(
  "/conversations/:id",
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

      // Only group creator can delete group conversations; 1-on-1 chats can be deleted by either party
      const conv = (
        await service.query(req.db!, "q067", [convId])
      ).rows[0];
      if (conv?.is_group && conv.created_by && conv.created_by !== req.userId) {
        return res.status(403).json({
          error: "Only the group creator can delete this conversation",
        });
      }

      // Notify other participants before deletion
      const participants = (
        await service.query(req.db!, "q033", [convId, req.userId])
      ).rows;

      // Delete the conversation (all children CASCADE automatically)
      await service.query(req.db!, "q069", [convId]);

      for (const p of participants) {
        sendToUser(req.tenantId, p.user_id, "chat_conv_deleted", {
          conversationId: convId,
        });
      }

      res.json({ ok: true });
    } catch (err) {
      req.log.error({ err }, "Delete conversation error");
      res.status(500).json({ error: "Failed to delete conversation" });
    }
  },
);

router.post(
  "/messages/:id/delivered",
  auth,
  async (req: Request, res: Response) => {
    try {
      const msgId = parseInt(String(req.params.id), 10);
      if (isNaN(msgId))
        return res.status(400).json({ error: "Invalid message" });

      // Verify user is a participant in the message's conversation
      const msg = (
        await service.query(req.db!, "q070", [req.userId, msgId])
      ).rows[0];
      if (!msg) return res.status(403).json({ error: "Not a participant" });

      await service.query(req.db!, "q071", [JSON.stringify([req.userId]), msgId]);

      res.json({ ok: true });
    } catch (err) {
      req.log.error({ err }, "Delivery ack error");
      res.status(500).json({ error: "Failed" });
    }
  },
);

router.post("/messages/:id/view", auth, async (req: Request, res: Response) => {
  try {
    const msgId = parseInt(String(req.params.id), 10);
    if (isNaN(msgId)) return res.status(400).json({ error: "Invalid message" });

    const msg = (
      await service.query(req.db!, "q072", [msgId])
    ).rows[0];
    if (!msg) return res.status(404).json({ error: "Message not found" });
    if (
      !(await verifyParticipant(
        msg.conversation_id,
        req.userId,
        req.db as unknown as DbLike,
      ))
    ) {
      return res.status(403).json({ error: "Not a participant" });
    }

    const metadata = msg.metadata || {};
    if (!metadata.viewOnce) {
      // Not a view-once message — just return the URL.
      return res.json({ fileUrl: msg.file_url });
    }

    // The sender can always re-open their own view-once media.
    const isSender = msg.sender_id === req.userId;
    if (isSender) return res.json({ fileUrl: msg.file_url });

    // Atomically claim the recipient's one allowed view. The previous
    // read-then-write sequence allowed two concurrent requests to both observe
    // "not viewed" and both receive the URL. This conditional JSONB update lets
    // exactly one request append the viewer id and return the protected URL.
    const claimed = (
      await service.query(req.db!, "q073", [msgId, req.userId])
    ).rows[0];

    if (!claimed) return res.json({ viewed: true });

    // Tell the other participants this viewer has consumed the media so their
    // UI can collapse to "Viewed".
    const participants = (
      await service.query(req.db!, "q006", [msg.conversation_id])
    ).rows;
    for (const p of participants) {
      sendToUser(req.tenantId, p.user_id, "chat_view_once", {
        messageId: msgId,
        conversationId: msg.conversation_id,
        viewerId: req.userId,
      });
    }

    res.json({ fileUrl: claimed.file_url });
  } catch (err) {
    req.log.error({ err }, "View-once consume error");
    res.status(500).json({ error: "Failed to view media" });
  }
});

export default router;

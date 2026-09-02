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
  "/conversations/:id/polls",
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

      const { question, options, multiSelect } = req.body;
      if (!question || !question.trim())
        return res.status(400).json({ error: "Question is required" });
      if (
        !Array.isArray(options) ||
        options.length < 2 ||
        options.length > 10
      ) {
        return res.status(400).json({ error: "2-10 options required" });
      }

      const cleanOpts = options
        .map((o) => String(o).trim().slice(0, 200))
        .filter(Boolean);
      if (cleanOpts.length < 2)
        return res.status(400).json({ error: "At least 2 non-empty options" });

      const poll = (
        await service.query(req.db!, "q055", [
            convId,
            req.userId,
            question.trim().slice(0, 500),
            JSON.stringify(cleanOpts),
            !!multiSelect,
          ])
      ).rows[0];

      // Insert a message of type 'poll' referencing this poll
      const result = (
        await service.query(req.db!, "q056", [
            convId,
            req.userId,
            question.trim().slice(0, 500),
            JSON.stringify({ pollId: poll.id }),
          ])
      ).rows[0];

      await service.query(req.db!, "q005", [convId]);

      const sender = (
        await service.query(req.db!, "q039", [req.userId])
      ).rows[0];
      const participants = (
        await service.query(req.db!, "q006", [convId])
      ).rows;

      const outMsg = {
        id: result.id,
        conversationId: convId,
        senderId: req.userId,
        senderName: sender.full_name,
        senderAvatar: sender.avatar,
        content: question.trim(),
        formatType: "poll",
        metadata: {
          pollId: poll.id,
          question: poll.question,
          options: cleanOpts,
          multiSelect: !!multiSelect,
          votes: {},
        },
        createdAt: result.created_at,
      };

      for (const p of participants) {
        sendToUser(req.tenantId, p.user_id, "chat_message", outMsg);
      }

      res.status(201).json({ ok: true, poll, messageId: result.id });
    } catch (err) {
      req.log.error({ err }, "Create poll error");
      res.status(500).json({ error: "Failed to create poll" });
    }
  },
);

router.post("/polls/:id/vote", auth, async (req: Request, res: Response) => {
  try {
    const pollId = parseInt(String(req.params.id), 10);
    if (isNaN(pollId)) return res.status(400).json({ error: "Invalid poll" });

    const poll = (
      await service.query(req.db!, "q057", [pollId])
    ).rows[0];
    if (!poll) return res.status(404).json({ error: "Poll not found" });
    if (poll.closed_at)
      return res.status(400).json({ error: "Poll is closed" });
    if (
      !(await verifyParticipant(
        poll.conversation_id,
        req.userId,
        req.db as unknown as DbLike,
      ))
    ) {
      return res.status(403).json({ error: "Not a participant" });
    }

    const { optionIdx } = req.body;
    const opts = poll.options;
    if (
      typeof optionIdx !== "number" ||
      optionIdx < 0 ||
      optionIdx >= opts.length
    ) {
      return res.status(400).json({ error: "Invalid option" });
    }

    // Toggle vote
    const existing = (
      await service.query(req.db!, "q058", [pollId, req.userId, optionIdx])
    ).rows[0];

    if (existing) {
      await service.query(req.db!, "q059", [
        existing.id,
      ]);
    } else {
      if (!poll.multi_select) {
        await service.query(req.db!, "q060", [pollId, req.userId]);
      }
      await service.query(req.db!, "q061", [pollId, req.userId, optionIdx]);
    }

    // Fetch updated vote counts
    const votes = (
      await service.query(req.db!, "q062", [pollId])
    ).rows;
    const voteMap: Record<number, number[]> = {};
    for (const v of votes) voteMap[v.option_idx] = v.user_ids;

    // Broadcast poll update
    const participants = (
      await service.query(req.db!, "q006", [poll.conversation_id])
    ).rows;
    for (const p of participants) {
      sendToUser(req.tenantId, p.user_id, "chat_poll_vote", {
        pollId,
        conversationId: poll.conversation_id,
        votes: voteMap,
        voterId: req.userId,
        optionIdx,
        isRemoval: !!existing,
      });
    }

    res.json({ ok: true, votes: voteMap });
  } catch (err) {
    req.log.error({ err }, "Poll vote error");
    res.status(500).json({ error: "Failed to vote" });
  }
});

router.get("/polls/:id", auth, async (req: Request, res: Response) => {
  try {
    const pollId = parseInt(String(req.params.id), 10);
    if (isNaN(pollId)) return res.status(400).json({ error: "Invalid poll" });

    const poll = (
      await service.query(req.db!, "q057", [pollId])
    ).rows[0];
    if (!poll) return res.status(404).json({ error: "Poll not found" });
    if (
      !(await verifyParticipant(
        poll.conversation_id,
        req.userId,
        req.db as unknown as DbLike,
      ))
    ) {
      return res.status(403).json({ error: "Not a participant" });
    }

    const votes = (
      await service.query(req.db!, "q063", [pollId])
    ).rows;

    const voteMap: Record<
      number,
      Array<{ userId: number; fullName: string }>
    > = {};
    for (const v of votes) {
      if (!voteMap[v.option_idx]) voteMap[v.option_idx] = [];
      voteMap[v.option_idx].push({ userId: v.user_id, fullName: v.full_name });
    }

    res.json({ ...poll, votes: voteMap });
  } catch (err) {
    req.log.error({ err }, "Get poll error");
    res.status(500).json({ error: "Failed to get poll" });
  }
});

export default router;

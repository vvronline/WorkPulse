/** HTTP adapter for the chat reactions/pin/star module slice. */
import express from "express";
import type { Request, Response } from "express";
import auth from "../../middleware/auth";
const { sendToUser } = require("../../utils/ws");
import { createChatService } from "./chat.service";
import { ChatError } from "./chat.types";
import type { ChatDb } from "./chat.types";
import { parseMessageId, parseConversationId, parseEmoji } from "./chat.schema";

const router = express.Router();
const service = createChatService();

function db(req: Request): ChatDb {
    return req.db as unknown as ChatDb;
}

/**
 * POST /api/chat/messages/:id/reactions  { emoji }
 */
router.post("/messages/:id/reactions", auth, async (req: Request, res: Response) => {
    try {
        const msgId = parseMessageId(req.params.id);
        const emoji = parseEmoji(req.body);

        const result = await service.toggleReaction(db(req), req.userId!, msgId, emoji);

        for (const participantId of result.participantIds) {
            sendToUser(req.tenantId, participantId, "chat_reaction", {
                messageId: msgId,
                conversationId: result.conversationId,
                userId: req.userId,
                fullName: result.senderName,
                emoji,
                action: result.action,
            });
        }

        res.json({ ok: true, action: result.action });
    } catch (err) {
        if (err instanceof ChatError) return res.status(err.statusCode).json({ error: err.message });
        req.log.error({ err }, "Reaction error");
        res.status(500).json({ error: "Failed to toggle reaction" });
    }
});

/**
 * POST /api/chat/messages/:id/pin
 */
router.post("/messages/:id/pin", auth, async (req: Request, res: Response) => {
    try {
        const msgId = parseMessageId(req.params.id);

        const result = await service.togglePin(db(req), req.userId!, msgId);

        for (const participantId of result.participantIds) {
            sendToUser(req.tenantId, participantId, "chat_pin", {
                messageId: msgId,
                conversationId: result.conversationId,
                pinned: result.pinned,
                pinnedBy: req.userId,
                pinnedByName: result.pinnedByName,
            });
        }

        res.json({ ok: true, pinned: result.pinned });
    } catch (err) {
        if (err instanceof ChatError) return res.status(err.statusCode).json({ error: err.message });
        req.log.error({ err }, "Pin message error");
        res.status(500).json({ error: "Failed to pin message" });
    }
});

/**
 * GET /api/chat/conversations/:id/pinned
 */
router.get("/conversations/:id/pinned", auth, async (req: Request, res: Response) => {
    try {
        const convId = parseConversationId(req.params.id);
        res.json(await service.listPinned(db(req), req.userId!, convId));
    } catch (err) {
        if (err instanceof ChatError) return res.status(err.statusCode).json({ error: err.message });
        req.log.error({ err }, "Get pinned error");
        res.status(500).json({ error: "Failed to get pinned messages" });
    }
});

/**
 * POST /api/chat/messages/:id/star
 */
router.post("/messages/:id/star", auth, async (req: Request, res: Response) => {
    try {
        const msgId = parseMessageId(req.params.id);
        const result = await service.toggleStar(db(req), req.userId!, msgId);
        res.json({ ok: true, starred: result.starred });
    } catch (err) {
        if (err instanceof ChatError) return res.status(err.statusCode).json({ error: err.message });
        req.log.error({ err }, "Star message error");
        res.status(500).json({ error: "Failed to star message" });
    }
});

/**
 * GET /api/chat/starred
 */
router.get("/starred", auth, async (req: Request, res: Response) => {
    try {
        res.json(await service.listStarred(db(req), req.userId!));
    } catch (err) {
        req.log.error({ err }, "Get starred error");
        res.status(500).json({ error: "Failed to get starred messages" });
    }
});

export default router;

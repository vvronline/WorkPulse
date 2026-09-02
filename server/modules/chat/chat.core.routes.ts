/** HTTP adapters and delivery side effects for chat endpoints. */
import express from "express";
import type { Request, Response } from "express";
const auth = require("../../middleware/auth");
const { loadUserContext } = require("../../middleware/rbac");
const { sendToUser, emitCallHistoryMessage } = require("../../utils/ws");
const redis = require("../../redis");
const { getUploadKey, getUploadUrl, getKeyFromUrl } = require("../../utils/uploadPath");
const { getStorage } = require("../../platform/storage");
const { getLocalToday, getTzModifier } = require("../../utils/timezone");
import { enqueueChatMediaPipelineJob } from "../../jobs";
import { broadcastMediaJobUpdate, processChatMediaJob } from "../../services/chatMediaPipeline";
import { buildUploadedMediaMetadata, copyForwardedMediaMetadata } from "../../utils/chatMediaMetadata";
const { canDo, loadGroupContext } = require("../../utils/groupPerms");
import { ChatError } from "./chat.types";
import { parseMessageId, parseConversationId, parseCreateGroupConversation, parseDirectConversationUserId, parseEmoji, parseUserId } from "./chat.schema";
import { service, db, type DbLike, chatUpload, chatFilename, deleteChatObject, verifyParticipant, verifyReplyTarget, getUserOrg, emitSystemMessage } from "./chat.shared";

const router = express.Router();

const { buildIceServers } = require("../../utils/coturn");

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

router.get("/starred", auth, async (req: Request, res: Response) => {
    try {
        res.json(await service.listStarred(db(req), req.userId!));
    } catch (err) {
        req.log.error({ err }, "Get starred error");
        res.status(500).json({ error: "Failed to get starred messages" });
    }
});

router.get("/blocked", auth, async (req: Request, res: Response) => {
    try {
        res.json(await service.listBlocked(db(req), req.userId!));
    } catch (err) {
        req.log.error({ err }, "Get blocked users error");
        res.status(500).json({ error: "Failed to get blocked users" });
    }
});

router.post("/users/:userId/block", auth, async (req: Request, res: Response) => {
    try {
        const targetId = parseUserId(req.params.userId);
        await service.blockUser(db(req), req.userId!, targetId);

        // Cross-device sync for the blocker only. Signal never notifies the
        // blocked party.
        sendToUser(req.tenantId, req.userId, "chat_user_blocked", {
            userId: targetId,
            blocked: true,
        });

        res.json({ ok: true, blocked: true });
    } catch (err) {
        if (err instanceof ChatError) return res.status(err.statusCode).json({ error: err.message });
        req.log.error({ err }, "Block user error");
        res.status(500).json({ error: "Failed to block user" });
    }
});

router.delete("/users/:userId/block", auth, async (req: Request, res: Response) => {
    try {
        const targetId = parseUserId(req.params.userId);
        await service.unblockUser(db(req), req.userId!, targetId);

        sendToUser(req.tenantId, req.userId, "chat_user_blocked", {
            userId: targetId,
            blocked: false,
        });

        res.json({ ok: true, blocked: false });
    } catch (err) {
        if (err instanceof ChatError) return res.status(err.statusCode).json({ error: err.message });
        req.log.error({ err }, "Unblock user error");
        res.status(500).json({ error: "Failed to unblock user" });
    }
});

router.post("/conversations", auth, async (req: Request, res: Response) => {
    try {
        const otherUserId = parseDirectConversationUserId(req.body);
        const conversation = await service.findOrCreateDirectConversation(
            db(req),
            req.userId!,
            otherUserId,
        );
        res.status(conversation.existed ? 200 : 201).json({ conversationId: conversation.id });
    } catch (err) {
        if (err instanceof ChatError) return res.status(err.statusCode).json({ error: err.message });
        req.log.error({ err }, "Create conversation error");
        res.status(500).json({ error: "Failed to create conversation" });
    }
});

router.post("/conversations/group", auth, async (req: Request, res: Response) => {
    try {
        const { name, userIds } = parseCreateGroupConversation(req.body);
        const result = await service.createGroupConversation(db(req), req.userId!, name, userIds);

        for (const userId of result.participantIds) {
            sendToUser(req.tenantId, userId, "chat_group_created", {
                conversationId: result.conversation.id,
                name: name.trim(),
            });
        }
        res.status(201).json({ conversationId: result.conversation.id });
    } catch (err) {
        if (err instanceof ChatError) return res.status(err.statusCode).json({ error: err.message });
        req.log.error({ err }, "Create group error");
        res.status(500).json({ error: "Failed to create group" });
    }
});

router.get("/conversations/:id/members", auth, async (req: Request, res: Response) => {
    try {
        const conversationId = parseConversationId(req.params.id);
        res.json(await service.listConversationMembers(db(req), req.userId!, conversationId));
    } catch (err) {
        if (err instanceof ChatError) return res.status(err.statusCode).json({ error: err.message });
        req.log.error({ err }, "Get members error");
        res.status(500).json({ error: "Failed to get members" });
    }
});

router.post("/conversations/:id/pin", auth, async (req: Request, res: Response) => {
    try {
        const conversationId = parseConversationId(req.params.id);
        const pinned = await service.toggleConversationPin(db(req), req.userId!, conversationId);
        res.json({ pinned });
    } catch (err) {
        if (err instanceof ChatError) return res.status(err.statusCode).json({ error: err.message });
        req.log.error({ err }, "Pin conversation error");
        res.status(500).json({ error: "Failed to pin conversation" });
    }
});

router.post("/conversations/:id/favourite", auth, async (req: Request, res: Response) => {
    try {
        const conversationId = parseConversationId(req.params.id);
        const favourite = await service.toggleConversationFavourite(db(req), req.userId!, conversationId);
        res.json({ favourite });
    } catch (err) {
        if (err instanceof ChatError) return res.status(err.statusCode).json({ error: err.message });
        req.log.error({ err }, "Favourite conversation error");
        res.status(500).json({ error: "Failed to favourite conversation" });
    }
});

router.post("/conversations/:id/mute", auth, async (req: Request, res: Response) => {
    try {
        const conversationId = parseConversationId(req.params.id);
        const result = await service.setConversationMute(
            db(req),
            req.userId!,
            conversationId,
            (req.body || {}).duration,
        );
        sendToUser(req.tenantId, req.userId, "chat_conv_muted", {
            conversationId,
            muted: result.is_muted,
            mutedUntil: result.muted_until || null,
        });
        res.json({ muted: result.is_muted, mutedUntil: result.muted_until || null });
    } catch (err) {
        if (err instanceof ChatError) return res.status(err.statusCode).json({ error: err.message });
        req.log.error({ err }, "Mute conversation error");
        res.status(500).json({ error: "Failed to mute conversation" });
    }
});

router.post("/conversations/:id/archive", auth, async (req: Request, res: Response) => {
    try {
        const conversationId = parseConversationId(req.params.id);
        const archived = await service.toggleConversationArchive(db(req), req.userId!, conversationId);
        sendToUser(req.tenantId, req.userId, "chat_conv_archived", { conversationId, archived });
        res.json({ archived });
    } catch (err) {
        if (err instanceof ChatError) return res.status(err.statusCode).json({ error: err.message });
        req.log.error({ err }, "Archive conversation error");
        res.status(500).json({ error: "Failed to archive conversation" });
    }
});

router.get("/ice-config", auth, async (req: Request, res: Response) => {
  try {
    const { iceServers, ttl, mode, expiresAt, allowPublicFallback } =
      await buildIceServers(req.userId);
    // P1.9 — surface whether the client may use its hard-coded public Open
    // Relay TURN fallback. STUN is always allowed; this gates ONLY the
    // public-TURN relay so a deployment with DISABLE_PUBLIC_TURN=true never
    // relays through openrelay.metered.ca from the client either.
    const payload: Record<string, unknown> = {
      iceServers,
      mode,
      allowPublicFallback,
    };
    // expiresAt is set directly by the Cloudflare path (absolute epoch);
    // for everything else we derive it from the relative ttl.
    if (expiresAt) payload.expiresAt = expiresAt;
    else if (ttl) payload.expiresAt = Math.floor(Date.now() / 1000) + ttl;
    // Prevent caching so each call gets fresh ephemeral creds
    res.set("Cache-Control", "no-store");
    res.json(payload);
  } catch (err) {
    req.log.error({ err }, "ice-config error");
    res.status(500).json({ error: "Failed to build ICE config" });
  }
});

router.get("/search", auth, async (req: Request, res: Response) => {
  try {
    const { q } = req.query as { q?: string };
    if (!q || q.trim().length < 2) return res.json([]);

    const orgId = await getUserOrg(req.userId, req.db as unknown as DbLike);
    if (!orgId) return res.json([]);

    const term = `%${q.trim().replace(/[%_]/g, (c) => `\\${c}`)}%`;
    // `hidden_from_directory = FALSE` excludes synthetic Platform
    // Inspector users that back the impersonation flow — they live
    // in the same `users` table but must never surface in chat
    // search / @mention pickers / DM-start dialogs.
    const rows = (
      await service.query(req.db!, "q007", [orgId, term, req.userId])
    ).rows;

    res.json(rows);
  } catch (err) {
    req.log.error({ err }, "Chat search error");
    res.status(500).json({ error: "Search failed" });
  }
});

router.get("/presence", auth, async (req: Request, res: Response) => {
  try {
    const { userIds } = req.query as { userIds?: string };
    if (!userIds) return res.json({});
    const ids = userIds
      .split(",")
      .map(Number)
      .filter((n) => n > 0);
    if (ids.length === 0) return res.json({});

    // Org isolation — never leak presence across orgs.
    const orgId = await getUserOrg(req.userId, req.db as unknown as DbLike);
    if (!orgId) return res.json({});
    const orgMembers = (
      await service.query(req.db!, "q008", [ids, orgId])
    ).rows.map((r: { id: number }) => r.id);
    const orgMemberSet = new Set(orgMembers);
    const allowedIds = ids.filter((id) => orgMemberSet.has(id));
    if (allowedIds.length === 0) return res.json({});

    const statusService = require("../../services/status");
    const payloads = await statusService.getEffectiveBulk(
      { db: req.db, tenantId: req.tenantId || null },
      allowedIds,
    );

    // Current work mode (office/remote/hybrid) per user, derived from today's
    // attendance clock-in. Only surfaced while the user is still "logged in"
    // (has an open work session — the last entry today is not a clock_out); a
    // logged-out user reports null. Tenants without the attendance feature
    // simply have no time_entries, so every user resolves to null. This is a
    // single indexed lookup and must never fail the presence response.
    const workModeByUser: Record<number, string | null> = {};
    try {
      const tzMod = getTzModifier(req);
      const today = getLocalToday(req);
      const entryRows = (
        await service.query(req.db!, "q009", [allowedIds, tzMod, today])
      ).rows as Array<{
        user_id: number;
        entry_type: string;
        work_mode: string | null;
      }>;
      const entriesByUser: Record<
        number,
        Array<{ entry_type: string; work_mode: string | null }>
      > = {};
      for (const r of entryRows) {
        (entriesByUser[r.user_id] ||= []).push(r);
      }
      for (const id of allowedIds) {
        const ue = entriesByUser[id];
        if (!ue || ue.length === 0) {
          workModeByUser[id] = null;
          continue;
        }
        // "Logged in" = clocked in and not yet clocked out (on floor or on break).
        const loggedIn = ue[ue.length - 1].entry_type !== "clock_out";
        const clockIn = ue.find((e) => e.entry_type === "clock_in");
        workModeByUser[id] =
          loggedIn && clockIn?.work_mode ? clockIn.work_mode : null;
      }
    } catch (err) {
      req.log.warn(
        { err: (err as Error).message },
        "presence: work-mode lookup failed",
      );
    }

    const result: Record<
      number,
      { presence: string; userStatus: string; workMode: string | null }
    > = {};
    for (const id of allowedIds) {
      const p = payloads[id];
      result[id] = {
        presence: p?.presence || "offline",
        userStatus: p?.effective || "offline",
        workMode: workModeByUser[id] ?? null,
      };
    }
    res.json(result);
  } catch (err) {
    req.log.error({ err }, "Presence error");
    res.status(500).json({ error: "Failed to get presence" });
  }
});

export default router;

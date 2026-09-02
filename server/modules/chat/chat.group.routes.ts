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

router.put(
  "/conversations/:id/group",
  auth,
  loadUserContext,
  async (req: Request, res: Response) => {
    try {
      const convId = parseInt(String(req.params.id), 10);
      if (isNaN(convId))
        return res.status(400).json({ error: "Invalid conversation" });

      const conv = (
        await service.query(req.db!, "q010", [convId])
      ).rows[0];
      if (!conv) return res.status(404).json({ error: "Group not found" });

      const ctx = await loadGroupContext(
        req.db as unknown as DbLike,
        convId,
        req.userId,
        req.roleLevel || 1,
      );
      // Must be a participant OR an org-governance user (>= hr_admin).
      if (!ctx || (!ctx.role && (req.roleLevel || 1) < 4)) {
        return res.status(403).json({ error: "Not a participant" });
      }

      const {
        name,
        description,
        avatar,
        postPolicy,
        addPolicy,
        addUserIds,
        removeUserIds,
      } = req.body;

      const actor = (
        await service.query(req.db!, "q011", [
          req.userId,
        ])
      ).rows[0];
      const actorName = actor?.full_name || "Someone";

      // ── Rename ──
      if (name !== undefined) {
        if (!canDo("rename", ctx))
          return res
            .status(403)
            .json({ error: "Only admins can rename this group" });
        const newName = String(name).trim().slice(0, 100);
        await service.query(req.db!, "q012", [
          newName,
          convId,
        ]);
        await emitSystemMessage(
          req.db as unknown as DbLike,
          req.tenantId,
          convId,
          req.userId,
          {
            type: "group_renamed",
            actorId: req.userId,
            name: newName,
            text: `${actorName} renamed the group to "${newName}"`,
          },
        );
      }

      // ── Description / avatar ──
      if (description !== undefined || avatar !== undefined) {
        if (!canDo("set_metadata", ctx))
          return res
            .status(403)
            .json({ error: "Only admins can edit group info" });
        if (description !== undefined) {
          await service.query(req.db!, "q013", [
              description === null ? null : String(description).slice(0, 500),
              convId,
            ]);
        }
        if (avatar !== undefined) {
          await service.query(req.db!, "q014", [avatar === null ? null : String(avatar).slice(0, 1024), convId]);
        }
        await emitSystemMessage(
          req.db as unknown as DbLike,
          req.tenantId,
          convId,
          req.userId,
          {
            type: "group_info_updated",
            actorId: req.userId,
            text: `${actorName} updated the group info`,
          },
        );
      }

      // ── Policies (owner / governance only) ──
      if (postPolicy !== undefined || addPolicy !== undefined) {
        if (!canDo("set_policy", ctx))
          return res
            .status(403)
            .json({ error: "Only the owner can change group policies" });
        if (postPolicy === "all" || postPolicy === "admins") {
          await service.query(req.db!, "q015", [postPolicy, convId]);
          ctx.postPolicy = postPolicy;
        }
        if (addPolicy === "all" || addPolicy === "admins") {
          await service.query(req.db!, "q016", [addPolicy, convId]);
          ctx.addPolicy = addPolicy;
        }
      }

      // ── Add members ──
      if (Array.isArray(addUserIds) && addUserIds.length > 0) {
        if (!canDo("add_member", ctx))
          return res
            .status(403)
            .json({ error: "You don't have permission to add members" });
        const valid = (
          await service.query(req.db!, "q017", [addUserIds.map(Number), conv.org_id])
        ).rows;
        for (const u of valid) {
          const ins = await service.query(req.db!, "q018", [convId, u.id]);
          sendToUser(req.tenantId, u.id, "chat_group_added", {
            conversationId: convId,
          });
          if ((ins.rowCount ?? 0) > 0) {
            await emitSystemMessage(
              req.db as unknown as DbLike,
              req.tenantId,
              convId,
              req.userId,
              {
                type: "member_added",
                actorId: req.userId,
                targetId: u.id,
                text: `${actorName} added ${u.full_name}`,
              },
            );
          }
        }
      }

      // ── Remove members ──
      if (Array.isArray(removeUserIds) && removeUserIds.length > 0) {
        if (!canDo("remove_member", ctx))
          return res
            .status(403)
            .json({ error: "You don't have permission to remove members" });
        const validRemove = (
          await service.query(req.db!, "q019", [removeUserIds.map(Number), conv.org_id, convId])
        ).rows;

        for (const u of validRemove) {
          if (u.id === req.userId) continue; // use /leave to remove self
          // An admin cannot remove the owner; only owner / governance can.
          if (
            u.role === "owner" &&
            ctx.role !== "owner" &&
            (req.roleLevel || 1) < 4
          ) {
            continue;
          }
          await service.query(req.db!, "q020", [convId, u.id]);
          sendToUser(req.tenantId, u.id, "chat_group_removed", {
            conversationId: convId,
          });
          await emitSystemMessage(
            req.db as unknown as DbLike,
            req.tenantId,
            convId,
            req.userId,
            {
              type: "member_removed",
              actorId: req.userId,
              targetId: u.id,
              text: `${actorName} removed ${u.full_name}`,
            },
          );
        }
      }

      res.json({ ok: true });
    } catch (err) {
      req.log.error({ err }, "Update group error");
      res.status(500).json({ error: "Failed to update group" });
    }
  },
);

router.post(
  "/conversations/:id/leave",
  auth,
  loadUserContext,
  async (req: Request, res: Response) => {
    try {
      const convId = parseInt(String(req.params.id), 10);
      if (isNaN(convId))
        return res.status(400).json({ error: "Invalid conversation" });
      const conv = (
        await service.query(req.db!, "q021", [convId])
      ).rows[0];
      if (!conv || !conv.is_group)
        return res.status(404).json({ error: "Group not found" });

      const me = (
        await service.query(req.db!, "q022", [convId, req.userId])
      ).rows[0];
      if (!me) return res.status(403).json({ error: "Not a participant" });

      // Owner leaving → promote a successor first (oldest admin, else oldest member).
      if (me.role === "owner") {
        const successor = (
          await service.query(req.db!, "q023", [convId, req.userId])
        ).rows[0];
        if (successor) {
          await service.query(req.db!, "q024", [convId, successor.user_id]);
          await service.query(req.db!, "q025", [successor.user_id, convId]);
        }
      }

      await service.query(req.db!, "q020", [convId, req.userId]);

      const actor = (
        await service.query(req.db!, "q011", [
          req.userId,
        ])
      ).rows[0];
      await emitSystemMessage(
        req.db as unknown as DbLike,
        req.tenantId,
        convId,
        req.userId,
        {
          type: "member_left",
          actorId: req.userId,
          text: `${actor?.full_name || "Someone"} left the group`,
        },
      );
      sendToUser(req.tenantId, req.userId, "chat_group_removed", {
        conversationId: convId,
      });

      res.json({ ok: true });
    } catch (err) {
      req.log.error({ err }, "Leave group error");
      res.status(500).json({ error: "Failed to leave group" });
    }
  },
);

router.put(
  "/conversations/:id/participants/:userId/role",
  auth,
  loadUserContext,
  async (req: Request, res: Response) => {
    try {
      const convId = parseInt(String(req.params.id), 10);
      const targetId = parseInt(String(req.params.userId), 10);
      if (isNaN(convId) || isNaN(targetId))
        return res.status(400).json({ error: "Invalid request" });
      const role = String(req.body.role || "");
      if (!["admin", "member"].includes(role))
        return res.status(400).json({ error: "Invalid role" });

      const ctx = await loadGroupContext(
        req.db as unknown as DbLike,
        convId,
        req.userId,
        req.roleLevel || 1,
      );
      if (!ctx || !ctx.isGroup)
        return res.status(404).json({ error: "Group not found" });
      if (!canDo("set_role", ctx))
        return res
          .status(403)
          .json({ error: "Only the owner can change roles" });

      const target = (
        await service.query(req.db!, "q026", [convId, targetId])
      ).rows[0];
      if (!target)
        return res.status(404).json({ error: "User is not a member" });
      if (target.role === "owner")
        return res
          .status(400)
          .json({ error: "Cannot change the owner's role" });

      await service.query(req.db!, "q027", [role, convId, targetId]);

      const actor = (
        await service.query(req.db!, "q011", [
          req.userId,
        ])
      ).rows[0];
      await emitSystemMessage(
        req.db as unknown as DbLike,
        req.tenantId,
        convId,
        req.userId,
        {
          type: "role_changed",
          actorId: req.userId,
          targetId,
          role,
          text: `${actor?.full_name || "Someone"} ${
            role === "admin" ? "promoted" : "demoted"
          } ${target.full_name}${role === "admin" ? " to admin" : ""}`,
        },
      );
      sendToUser(req.tenantId, targetId, "chat_group_role_changed", {
        conversationId: convId,
        role,
      });

      res.json({ ok: true, role });
    } catch (err) {
      req.log.error({ err }, "Set role error");
      res.status(500).json({ error: "Failed to set role" });
    }
  },
);

router.post(
  "/conversations/:id/transfer-owner",
  auth,
  loadUserContext,
  async (req: Request, res: Response) => {
    try {
      const convId = parseInt(String(req.params.id), 10);
      const newOwnerId = parseInt(String(req.body.userId), 10);
      if (isNaN(convId) || isNaN(newOwnerId))
        return res.status(400).json({ error: "Invalid request" });

      const ctx = await loadGroupContext(
        req.db as unknown as DbLike,
        convId,
        req.userId,
        req.roleLevel || 1,
      );
      if (!ctx || !ctx.isGroup)
        return res.status(404).json({ error: "Group not found" });
      if (!canDo("transfer_owner", ctx))
        return res
          .status(403)
          .json({ error: "Only the owner can transfer ownership" });

      const target = (
        await service.query(req.db!, "q028", [convId, newOwnerId])
      ).rows[0];
      if (!target)
        return res.status(404).json({ error: "User is not a member" });

      await (req.db as unknown as DbLike).transaction(async (client) => {
        await service.query(client, "q029", [convId, req.userId]);
        await service.query(client, "q024", [convId, newOwnerId]);
        await service.query(client, "q025", [newOwnerId, convId]);
      });

      const actor = (
        await service.query(req.db!, "q011", [
          req.userId,
        ])
      ).rows[0];
      await emitSystemMessage(
        req.db as unknown as DbLike,
        req.tenantId,
        convId,
        req.userId,
        {
          type: "owner_transferred",
          actorId: req.userId,
          targetId: newOwnerId,
          text: `${actor?.full_name || "Someone"} made ${
            target.full_name
          } the owner`,
        },
      );

      res.json({ ok: true });
    } catch (err) {
      req.log.error({ err }, "Transfer owner error");
      res.status(500).json({ error: "Failed to transfer ownership" });
    }
  },
);

export default router;

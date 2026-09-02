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

router.get("/calls", auth, async (req: Request, res: Response) => {
  try {
    const userId = req.userId;
    const rows = (
      await service.query(req.db!, "q074", [userId])
    ).rows;
    const total = Number(rows[0]?.total_count || 0);
    const calls = rows.map(({ total_count: _totalCount, ...call }) => call);
    // Keep the response body backward-compatible for existing clients while
    // exposing the complete selectable count (including rows beyond LIMIT 100).
    res.setHeader("X-Total-Count", String(total));
    res.json(calls);
  } catch (err) {
    req.log.error({ err }, "Get all call history error");
    res.status(500).json({ error: "Failed to get call history" });
  }
});

router.post("/calls/delete", auth, async (req: Request, res: Response) => {
  try {
    const userId = req.userId;
    const deleteAll = req.body?.all === true;
    const ids = Array.isArray(req.body?.ids)
      ? Array.from(
          new Set(
            (req.body.ids as unknown[])
              .map((v) => parseInt(String(v), 10))
              .filter((n) => Number.isInteger(n) && n > 0),
          ),
        )
      : [];
    if (!deleteAll && ids.length === 0) {
      return res.status(400).json({ error: "No call ids provided" });
    }
    // Select-all is evaluated on the server rather than expanding the newest
    // 100 client rows into an ID payload. This makes it include older calls and
    // avoids the JSON body-size ceiling for long histories.
    const result = deleteAll
      ? await service.query(req.db!, "q075", [userId])
      : await service.query(req.db!, "q076", [ids, userId]);
    res.json({ ok: true, deleted: result.rowCount ?? 0 });
  } catch (err) {
    req.log.error({ err }, "Delete call history error");
    res.status(500).json({ error: "Failed to delete call history" });
  }
});

router.get("/calls/active", auth, async (req: Request, res: Response) => {
  try {
    const userId = req.userId;
    const row = (
      await service.query(req.db!, "q077", [userId])
    ).rows[0];
    res.json(row || null);
  } catch (err) {
    req.log.error({ err }, "Get active call error");
    res.status(500).json({ error: "Failed to get active call" });
  }
});

router.get(
  "/conversations/:id/calls",
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
        await service.query(req.db!, "q078", [convId])
      ).rows;

      res.json(rows);
    } catch (err) {
      req.log.error({ err }, "Get call history error");
      res.status(500).json({ error: "Failed to get call history" });
    }
  },
);

export default router;

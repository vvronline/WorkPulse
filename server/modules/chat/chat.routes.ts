/** Chat HTTP route composition; public paths remain mounted at /api/chat. */
import express from "express";
import coreRoutes from "./chat.core.routes";
import groupRoutes from "./chat.group.routes";
import conversationReadsRoutes from "./chat.conversation-reads.routes";
import messageSendRoutes from "./chat.message-send.routes";
import mediaJobRoutes from "./chat.media-jobs.routes";
import messageActionRoutes from "./chat.message-actions.routes";
import pollRoutes from "./chat.polls.routes";
import conversationActionRoutes from "./chat.conversation-actions.routes";
import callHistoryRoutes from "./chat.call-history.routes";
import callActionRoutes from "./chat.call-actions.routes";
import linkPreviewRoutes from "./chat.link-preview.routes";

const router = express.Router();
router.use("/", coreRoutes);
router.use("/", groupRoutes);
router.use("/", conversationReadsRoutes);
router.use("/", messageSendRoutes);
router.use("/", mediaJobRoutes);
router.use("/", messageActionRoutes);
router.use("/", pollRoutes);
router.use("/", conversationActionRoutes);
router.use("/", callHistoryRoutes);
router.use("/", callActionRoutes);
router.use("/", linkPreviewRoutes);

export default router;

/**
 * Chat module composition: tenant/feature gates and the public /api/chat mount.
 * HTTP endpoint registrations live in modules/chat/*.routes.ts.
 */
import express from "express";
const { requireTenant, requireFeature } = require("../middleware/tenant");
import chatModuleRoutes from "../modules/chat/chat.routes";
const router = express.Router();
router.use(requireTenant, requireFeature("chat"));
router.use("/", chatModuleRoutes);
export = router;
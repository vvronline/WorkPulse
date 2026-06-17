"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.maintenanceModeMiddleware = maintenanceModeMiddleware;
exports.invalidateMaintenanceCache = invalidateMaintenanceCache;
const { isMaintenanceMode, getMaintenanceMessage } = require("../utils/platformConfig");
const logger_1 = require("../utils/logger");
let cachedMode = false;
let cachedMessage = "";
let lastCheck = 0;
const CACHE_TTL_MS = 30_000;
async function refreshCache() {
    const now = Date.now();
    if (now - lastCheck < CACHE_TTL_MS)
        return;
    lastCheck = now;
    try {
        cachedMode = await isMaintenanceMode();
        if (cachedMode) {
            cachedMessage = await getMaintenanceMessage();
        }
    }
    catch (err) {
        logger_1.logger.warn({ err: err.message }, "maintenance: failed to refresh cache");
    }
}
async function maintenanceModeMiddleware(req, res, next) {
    await refreshCache();
    if (!cachedMode)
        return next();
    if (req.user?.role === "platform_admin")
        return next();
    if (req.path === "/api/health" || req.path === "/api/auth/login")
        return next();
    return res.status(503).json({
        error: "maintenance",
        message: cachedMessage || "The system is currently under maintenance. Please try again later.",
    });
}
function invalidateMaintenanceCache() {
    lastCheck = 0;
}
//# sourceMappingURL=maintenanceMode.js.map
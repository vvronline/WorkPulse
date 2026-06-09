import type { Response, NextFunction } from "express";
const { isMaintenanceMode, getMaintenanceMessage } = require("../utils/platformConfig");
import { logger } from "../utils/logger";

let cachedMode = false;
let cachedMessage = "";
let lastCheck = 0;
const CACHE_TTL_MS = 30_000;

async function refreshCache(): Promise<void> {
    const now = Date.now();
    if (now - lastCheck < CACHE_TTL_MS) return;
    lastCheck = now;
    try {
        cachedMode = await isMaintenanceMode();
        if (cachedMode) {
            cachedMessage = await getMaintenanceMessage();
        }
    } catch (err: any) {
        logger.warn({ err: err.message }, "maintenance: failed to refresh cache");
    }
}

async function maintenanceModeMiddleware(req: any, res: Response, next: NextFunction): Promise<void | Response> {
    await refreshCache();

    if (!cachedMode) return next();

    if (req.user?.role === "platform_admin") return next();

    if (req.path === "/api/health" || req.path === "/api/auth/login") return next();

    return res.status(503).json({
        error: "maintenance",
        message: cachedMessage || "The system is currently under maintenance. Please try again later.",
    });
}

function invalidateMaintenanceCache(): void {
    lastCheck = 0;
}

export { maintenanceModeMiddleware, invalidateMaintenanceCache };
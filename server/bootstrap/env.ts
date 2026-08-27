import path from "path";
import fs from "fs";

/** Load server-local `.env` first, then fall back to the process cwd. */
function loadEnvironment(serverDir: string): void {
    const envPath = path.join(serverDir, ".env");
    if (fs.existsSync(envPath)) {
        require("dotenv").config({ path: envPath });
    } else {
        require("dotenv").config();
    }
}

/** Fail fast on configuration that would make authentication/storage unsafe. */
function validateEnvironment(): void {
    // Resolve after loadEnvironment() so logger.ts observes NODE_ENV/LOG_LEVEL
    // from the server-local .env rather than process defaults.
    const { logger } = require("../utils/logger");
    if (!process.env.JWT_SECRET) {
        logger.fatal("JWT_SECRET environment variable is not set. Server cannot start.");
        throw new Error("JWT_SECRET environment variable is not set");
    }
    if (process.env.NODE_ENV === "production" && process.env.JWT_SECRET.length < 32) {
        logger.fatal("JWT_SECRET must be at least 32 characters in production. Server cannot start.");
        throw new Error("JWT_SECRET must be at least 32 characters in production");
    }
    if (process.env.NODE_ENV === "production" && !process.env.REDIS_URL) {
        logger.fatal("REDIS_URL is required in production. Server cannot start.");
        throw new Error("REDIS_URL is required in production");
    }

    // Local disk cannot be shared between replicas. Surface this at boot rather
    // than after one instance writes a file another cannot see.
    if (process.env.NODE_ENV !== "test") {
        const { assertProductionStorage } = require("../platform/storage");
        assertProductionStorage();
    }
}

export { loadEnvironment, validateEnvironment };
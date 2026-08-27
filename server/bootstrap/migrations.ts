import { logger } from "../utils/logger";
import { masterQuery } from "../db";
import * as redis from "../redis";

let bootstrapPromise: Promise<void> | null = null;

/**
 * Runtime dependency bootstrap. Schema/data migrations run exclusively in the
 * Railway pre-deploy command (`node migrate.js`) and must finish before a new
 * application deployment is promoted.
 */
function bootstrap(): Promise<void> {
    if (bootstrapPromise) return bootstrapPromise;

    bootstrapPromise = (async () => {
        // Connectivity check only — never DDL from a web/realtime/worker pod.
        await masterQuery("SELECT 1");
        // Production roles must not become ready until both Redis command and
        // subscriber connections answer PING. Otherwise rate limits, presence,
        // Pub/Sub and realtime signal state silently fragment by replica.
        await redis.initRedis();
        logger.info("Runtime dependencies ready (database + Redis)");
    })();
    return bootstrapPromise;
}

export { bootstrap };
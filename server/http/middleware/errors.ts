import type { Express, Response, NextFunction } from "express";
import { logger } from "../../utils/logger";

function installErrorHandler(app: Express): void {
    app.use((err: unknown, req: any, res: Response, _next: NextFunction) => {
        (req.log || logger).error({ err }, "Unhandled error");
        res.status(500).json({ error: "Internal server error" });
    });
}

export { installErrorHandler };
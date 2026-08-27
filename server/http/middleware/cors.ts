import type { Express, Request, Response, NextFunction } from "express";

function installCors(app: Express): void {
    const port = process.env.PORT || 5000;
    app.use((req: Request, res: Response, next: NextFunction) => {
        const origin = req.headers.origin;
        const allowed = (() => {
            if (!origin) return true;
            if (process.env.CORS_ORIGIN) {
                const explicit = process.env.CORS_ORIGIN.split(",").map((s) => s.trim());
                if (explicit.includes(origin)) return true;
            }
            const host = req.headers.host;
            if (host && (origin === `https://${host}` || origin === `http://${host}`)) return true;
            // Accept both schemes until all legacy desktop builds have updated.
            if (origin.startsWith("workpulse://") || origin.startsWith("aino://")) return true;
            if (process.env.NODE_ENV !== "production") {
                return [
                    `http://localhost:${port}`, "http://localhost", "https://localhost",
                    "http://localhost:3000", "http://localhost:3001",
                    "http://localhost:3002", "http://localhost:5173",
                ].includes(origin);
            }
            return false;
        })();

        if (!allowed) return res.status(403).json({ error: "Not allowed by CORS" });
        if (origin) {
            res.setHeader("Access-Control-Allow-Origin", origin);
            res.setHeader("Access-Control-Allow-Credentials", "true");
            res.setHeader("Access-Control-Allow-Methods", "GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS");
            res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With, x-timezone-offset");
            res.setHeader("Access-Control-Expose-Headers", "X-Total-Count");
        }
        if (req.method === "OPTIONS") return res.sendStatus(204);
        next();
    });
}

export { installCors };
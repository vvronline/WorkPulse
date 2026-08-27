import path from "path";
import express from "express";
import type { Express, Request, Response, NextFunction } from "express";

/**
 * Serve the current Vite SPA. Phase F moves these bytes to R2/Cloudflare; this
 * module preserves today's behavior until that cutover.
 */
function installStaticSpa(app: Express, serverRoot: string): string {
    const clientDist = path.join(serverRoot, "..", "client", "dist");
    app.use(express.static(clientDist, {
        setHeaders(res: Response, filePath: string) {
            if (filePath.endsWith(".html") || filePath.endsWith("sw.js")) {
                res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
            } else if (/\.(?:js|mjs|css|map|woff2?|ttf|eot|otf|png|jpe?g|gif|svg|webp|ico|avif)$/i.test(filePath)) {
                res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
            }
        },
    }));
    return clientDist;
}

function installSpaFallback(app: Express, clientDist: string): void {
    app.get(/^[^.]*$/, (_req: Request, res: Response, next: NextFunction) => {
        res.sendFile(path.join(clientDist, "index.html"), (err) => {
            if (err) next(err);
        });
    });
}

export { installStaticSpa, installSpaFallback };
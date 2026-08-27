/** Authenticated, tenant-isolated upload serving. */
import path from "path";
import type { Express, Response, NextFunction } from "express";
import { logger } from "../../utils/logger";
import { getTenantPool } from "../../utils/tenantManager";

function installUploadServing(app: Express, serverRoot: string): void {
const authMiddleware = require("../../middleware/auth");
    // Per-tenant uploads enforcement.
    //
    // Canonical layout (written by server/utils/uploadPath.js):
    //   /uploads/tenant_<tenantId>/org_<orgId>/<kind>/<file>
    //
    // Rules:
    //   1. Path must stay inside the uploads root (no traversal).
    //   2. If the path has a `tenant_<id>` segment, it MUST equal req.tenantId.
    //   3. If the path has an `org_<id>` segment, it MUST equal the user's org.
    //   4. Legacy paths without a tenant prefix (e.g. /uploads/org_X/avatars/...
    //      or the very old /uploads/chat/...) are still served, but only with
    //      the org check above. New uploads always carry the tenant prefix.
    app.use("/uploads", authMiddleware, async (req: any, res: Response, next: NextFunction) => {
        const resolved = path.resolve(serverRoot, "uploads", req.path.replace(/^\//, ""));
        if (!resolved.startsWith(path.resolve(serverRoot, "uploads"))) {
            return res.status(403).json({ error: "Forbidden" });
        }
    
        // Enforce tenant isolation when the URL is tenant-prefixed.
        const tenantMatch = req.path.match(/^\/tenant_(\d+)\//);
        if (tenantMatch) {
            const pathTenantId = parseInt(tenantMatch[1], 10);
            if (!req.tenantId || req.tenantId !== pathTenantId) {
                return res.status(403).json({ error: "Forbidden" });
            }
        } else if (req.tenantId) {
            // The user is in a tenant context but the requested file lives at a
            // legacy non-tenant path. Only allow if no other tenant could have
            // written there — i.e. it's an org-scoped legacy path. Reject any
            // request that has neither a tenant_ nor org_ segment, because
            // those files (e.g. /uploads/chat/foo) are not safe to share
            // across tenants.
            const hasOrgSegment = /\/org_(\d+)\//.test(req.path);
            if (!hasOrgSegment) {
                return res.status(403).json({ error: "Forbidden" });
            }
        }
    
        // Chat attachments are conversation-private. Tenant/org membership is not
        // sufficient: a colleague who is not a participant must not be able to
        // retrieve a file merely by learning its upload URL.
        if (/\/chat\//.test(req.path)) {
            const fileUrl = `/uploads${req.path}`;
            try {
                const allowed = (
                    await req.db.query(
                        `SELECT 1
                           FROM messages m
                           JOIN conversation_participants cp
                             ON cp.conversation_id = m.conversation_id
                            AND cp.user_id = $1
                          WHERE m.file_url = $2
                            AND m.deleted_at IS NULL
                          LIMIT 1`,
                        [req.userId, fileUrl],
                    )
                ).rows[0];
                if (!allowed) {
                    return res.status(403).json({ error: "Forbidden" });
                }
            } catch (err) {
                // Attachment access must fail closed if tenant DB authorization is
                // unavailable rather than falling back to organization membership.
                (req.log || logger).warn({ err }, "chat attachment check failed — denying");
                return res.status(403).json({ error: "Forbidden" });
            }
        }
    
        // Enforce org isolation whenever the URL contains an `org_<id>` segment.
        const orgMatch = req.path.match(/\/org_(\d+)\//);
        if (orgMatch) {
            const pathOrgId = parseInt(orgMatch[1], 10);
            try {
                const user = (await req.db.query("SELECT org_id FROM users WHERE id = $1", [req.userId])).rows[0];
                if (!user || user.org_id !== pathOrgId) {
                    return res.status(403).json({ error: "Forbidden" });
                }
            } catch (err) {
                // Fail CLOSED: if the org check can't run (e.g. master context on a
                // pure multi-tenant deploy has no `users` table), never serve the file.
                (req.log || logger).warn({ err }, "uploads org check failed — denying");
                return res.status(403).json({ error: "Forbidden" });
            }
        }
        // Uploaded files may include user-supplied SVGs (avatars, chat files,
        // logos) which the browser executes as an active document if opened
        // directly — a stored-XSS vector. Forbid MIME sniffing and sandbox the
        // response so embedded script can't run. (Does not affect <img> embedding.)
        res.setHeader("X-Content-Type-Options", "nosniff");
        res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; sandbox");
        next();
    }, async (req: any, res: Response) => {
        // ── A3: serve from object storage, not local disk ───────────────────────
        //
        // Every authorization check above (tenant prefix, org prefix, chat
        // participant) has already passed by this point. Only now do we mint a
        // credential for the object.
        //
        // R2  -> 302 to a 60-second presigned URL. The bytes never touch the Node
        //        event loop, which is what lets the API scale horizontally.
        // local (dev) -> getSignedUrl() returns null, so we stream the buffer.
        const { getStorage, urlToKey } = require("../../platform/storage");
        const key = urlToKey(req.path);
        if (!key) return res.status(400).json({ error: "Invalid path" });
    
        try {
            const storage = getStorage();
            const signed = await storage.getSignedUrl(key, 60);
            if (signed) {
                // Presigned URLs are per-user and short-lived — never cache them
                // in a shared proxy.
                res.setHeader("Cache-Control", "private, no-store");
                return res.redirect(302, signed);
            }
    
            // Local dev fallback: stream the object through the app.
            const body = await storage.get(key);
            if (!body) return res.status(404).json({ error: "Not found" });
    
            const meta = await storage.stat(key);
            if (meta?.contentType) res.setHeader("Content-Type", meta.contentType);
            res.setHeader("Cache-Control", "private, max-age=300");
            return res.send(body);
        } catch (err) {
            (req.log || logger).error({ err, key }, "Failed to serve upload from storage");
            return res.status(500).json({ error: "Failed to retrieve file" });
        }
    });
}

export { installUploadServing };

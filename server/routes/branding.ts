/**
 * Branding & email-template routes (Chunk 3).
 *
 * GET  /api/branding             — fetch the current org's logo + accent + email template overrides
 *                                  (anyone in the org — needed by ThemeContext to inject CSS vars)
 * PUT  /api/branding             — update logo URL (separate upload route below) + accent
 *                                  (super_admin / hr_admin / platform_admin)
 * POST /api/branding/logo        — multipart upload of a new logo (super_admin / hr_admin / platform_admin)
 * DELETE /api/branding/logo      — clear the logo (super_admin / hr_admin / platform_admin)
 *
 * GET  /api/branding/email-templates                 — list every template key with its current subject/body
 *                                                      (built-in defaults merged with org override)
 * PUT  /api/branding/email-templates/:templateKey    — upsert an override (super_admin / hr_admin)
 * DELETE /api/branding/email-templates/:templateKey  — revert to the built-in (delete the override row)
 * POST /api/branding/email-templates/:templateKey/preview — render the template against the current
 *                                                      branding + override draft (no DB write)
 */
import express from "express";
import type { Request, Response } from "express";
const fs = require("fs");
const fsPromises = require("fs").promises;
const path = require("path");
const multer = require("multer");

interface UploadedFile {
    mimetype: string;
    filename: string;
    path: string;
    originalname?: string;
    [key: string]: unknown;
}
type MulterCb<T> = (err: Error | null, value?: T) => void;

const auth = require("../middleware/auth");
const { loadUserContext, requireRole, requireSameOrg } = require("../middleware/rbac");
const { requireTenant } = require("../middleware/tenant");
const { logAction } = require("../utils/audit");
const { getUploadDir, getUploadUrl, UPLOADS_ROOT } = require("../utils/uploadPath");
const {
    templates,
    TEMPLATE_KEYS,
    TEMPLATE_PREVIEW_ARGS,
    applyBranding,
    invalidateBrandingCache,
    loadOrgBranding,
} = require("../utils/mailer");

const router = express.Router();
router.use(auth, loadUserContext, requireTenant);

// ── Multer for logo upload ───────────────────────────────────────────────
const storage = multer.diskStorage({
    destination(req: Request, _file: UploadedFile, cb: MulterCb<string>) {
        try {
            const dir = getUploadDir(req.tenantId, req.userOrgId, "branding");
            cb(null, dir);
        } catch (err) {
            cb(err as Error);
        }
    },
    filename(_req: Request, file: UploadedFile, cb: MulterCb<string>) {
        // Derive the stored extension from the validated MIME type, never from
        // the user-supplied originalname (which could carry a misleading or
        // unsafe extension). fileFilter below restricts mimetype to images.
        const MIME_EXT: Record<string, string> = {
            "image/png": ".png",
            "image/jpeg": ".jpg",
            "image/jpg": ".jpg",
            "image/gif": ".gif",
            "image/webp": ".webp",
            "image/svg+xml": ".svg",
        };
        const ext = MIME_EXT[String(file.mimetype).toLowerCase()] || ".png";
        cb(null, `logo-${Date.now()}${ext}`);
    },
});
const upload = multer({
    storage,
    limits: { fileSize: 2 * 1024 * 1024 }, // 2MB
    fileFilter(_req: Request, file: UploadedFile, cb: MulterCb<boolean>) {
        if (!/^image\/(png|jpe?g|gif|svg\+xml|webp)$/i.test(file.mimetype)) {
            return cb(new Error("Only image files are allowed"));
        }
        cb(null, true);
    },
});

function safeLogoPath(rel: string | null | undefined): string | null {
    if (!rel || rel.includes("..") || rel.includes("\0")) return null;
    const stripped = rel.replace(/^\/+/, "").replace(/^uploads\//, "");
    const abs = path.resolve(UPLOADS_ROOT, stripped);
    const root = fs.realpathSync(UPLOADS_ROOT);
    if (!abs.startsWith(root)) return null;
    return abs;
}

// ── GET branding (logo + accent + org name) ─────────────────────────────
router.get("/", requireSameOrg, async (req: Request, res: Response) => {
    try {
        const row = (await req.db!.query(
            `SELECT b.logo_url, b.accent_color, b.updated_at, o.name AS org_name
             FROM organizations o
             LEFT JOIN org_branding b ON b.org_id = o.id
             WHERE o.id = $1`,
            [req.userOrgId],
        )).rows[0];
        res.json({
            logo_url: row?.logo_url || null,
            accent_color: row?.accent_color || "#6366f1",
            org_name: row?.org_name || null,
            updated_at: row?.updated_at || null,
        });
    } catch (err) {
        req.log.error({ err }, "GET /branding failed");
        res.status(500).json({ error: "Failed to fetch branding" });
    }
});

// ── PUT branding (accent only — logo is uploaded separately) ────────────
router.put("/", requireRole("hr_admin"), requireSameOrg, async (req: Request, res: Response) => {
    try {
        const { accent_color } = req.body || {};
        if (!accent_color || !/^#[0-9a-fA-F]{6}$/.test(accent_color)) {
            return res.status(400).json({ error: "accent_color must be a #RRGGBB hex string" });
        }
        await req.db!.query(
            `INSERT INTO org_branding (org_id, accent_color, updated_by, updated_at)
             VALUES ($1, $2, $3, NOW())
             ON CONFLICT (org_id) DO UPDATE SET
                 accent_color = EXCLUDED.accent_color,
                 updated_by   = EXCLUDED.updated_by,
                 updated_at   = NOW()`,
            [req.userOrgId, accent_color.toLowerCase(), req.userId],
        );
        invalidateBrandingCache(req.tenantId, req.userOrgId);
        logAction(req, "update", "org_branding", req.userOrgId, { accent_color });
        const row = (await req.db!.query(
            `SELECT logo_url, accent_color, updated_at FROM org_branding WHERE org_id = $1`,
            [req.userOrgId],
        )).rows[0];
        res.json(row);
    } catch (err) {
        req.log.error({ err }, "PUT /branding failed");
        res.status(500).json({ error: "Failed to update branding" });
    }
});

// ── POST /branding/logo (multipart upload) ──────────────────────────────
router.post("/logo", requireRole("hr_admin"), requireSameOrg, upload.single("logo"), async (req: Request, res: Response) => {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });
    const newUrl = getUploadUrl(req.tenantId, req.userOrgId, "branding", req.file.filename);
    let oldLogo: string | null = null;
    try {
        const existing = (await req.db!.query(
            `SELECT logo_url FROM org_branding WHERE org_id = $1`,
            [req.userOrgId],
        )).rows[0];
        oldLogo = existing?.logo_url || null;

        await req.db!.query(
            `INSERT INTO org_branding (org_id, logo_url, updated_by, updated_at)
             VALUES ($1, $2, $3, NOW())
             ON CONFLICT (org_id) DO UPDATE SET
                 logo_url   = EXCLUDED.logo_url,
                 updated_by = EXCLUDED.updated_by,
                 updated_at = NOW()`,
            [req.userOrgId, newUrl, req.userId],
        );
        invalidateBrandingCache(req.tenantId, req.userOrgId);
        logAction(req, "update", "org_branding_logo", req.userOrgId, { logo_url: newUrl });

        if (oldLogo) {
            const oldPath = safeLogoPath(oldLogo);
            if (oldPath) { try { await fsPromises.unlink(oldPath); } catch { /* ignore */ } }
        }

        const row = (await req.db!.query(
            `SELECT logo_url, accent_color, updated_at FROM org_branding WHERE org_id = $1`,
            [req.userOrgId],
        )).rows[0];
        res.json(row);
    } catch (err) {
        req.log.error({ err }, "POST /branding/logo failed");
        // Clean up the orphan upload on error
        try { await fsPromises.unlink(req.file.path); } catch { /* ignore */ }
        res.status(500).json({ error: "Failed to update logo" });
    }
});

// ── DELETE /branding/logo ───────────────────────────────────────────────
router.delete("/logo", requireRole("hr_admin"), requireSameOrg, async (req: Request, res: Response) => {
    try {
        const existing = (await req.db!.query(
            `SELECT logo_url FROM org_branding WHERE org_id = $1`,
            [req.userOrgId],
        )).rows[0];
        await req.db!.query(
            `UPDATE org_branding SET logo_url = NULL, updated_by = $2, updated_at = NOW()
              WHERE org_id = $1`,
            [req.userOrgId, req.userId],
        );
        invalidateBrandingCache(req.tenantId, req.userOrgId);
        if (existing?.logo_url) {
            const oldPath = safeLogoPath(existing.logo_url);
            if (oldPath) { try { await fsPromises.unlink(oldPath); } catch { /* ignore */ } }
        }
        logAction(req, "delete", "org_branding_logo", req.userOrgId, {});
        res.json({ ok: true });
    } catch (err) {
        req.log.error({ err }, "DELETE /branding/logo failed");
        res.status(500).json({ error: "Failed to remove logo" });
    }
});

// ── Email templates ─────────────────────────────────────────────────────

/**
 * GET /branding/email-templates — list every built-in key with its current
 * effective subject/body. Returns the merged value (override if present, else
 * the built-in).
 */
router.get("/email-templates", requireRole("hr_admin"), requireSameOrg, async (req: Request, res: Response) => {
    try {
        const rows = (await req.db!.query(
            `SELECT template_key, subject, body_html, enabled, updated_at
               FROM org_email_templates WHERE org_id = $1`,
            [req.userOrgId],
        )).rows;
        const overrideMap = new Map<string, any>(rows.map((r: any) => [r.template_key, r]));

        const list = TEMPLATE_KEYS.map((key: string) => {
            const override = overrideMap.get(key);
            const sample = TEMPLATE_PREVIEW_ARGS[key]();
            const built = templates[key](...sample);
            return {
                template_key: key,
                builtin_subject: built.subject,
                builtin_body_html: built.body,
                subject: override?.subject ?? built.subject,
                body_html: override?.body_html ?? built.body,
                enabled: override ? override.enabled !== false : true,
                is_overridden: !!override,
                updated_at: override?.updated_at || null,
            };
        });
        res.json({ templates: list });
    } catch (err) {
        req.log.error({ err }, "GET /branding/email-templates failed");
        res.status(500).json({ error: "Failed to fetch templates" });
    }
});

/**
 * PUT /branding/email-templates/:templateKey — upsert an override.
 * Body: { subject, body_html, enabled? }
 */
router.put("/email-templates/:templateKey", requireRole("hr_admin"), requireSameOrg, async (req: Request, res: Response) => {
    try {
        const key = String(req.params.templateKey || "");
        if (!TEMPLATE_KEYS.includes(key)) {
            return res.status(400).json({ error: `Unknown template key. Allowed: ${TEMPLATE_KEYS.join(", ")}` });
        }
        const { subject, body_html, enabled } = req.body || {};
        if (!subject || typeof subject !== "string" || subject.length > 200) {
            return res.status(400).json({ error: "subject is required (max 200 chars)" });
        }
        if (!body_html || typeof body_html !== "string" || body_html.length > 30000) {
            return res.status(400).json({ error: "body_html is required (max 30000 chars)" });
        }
        const enabledFlag = enabled === false ? false : true;
        await req.db!.query(
            `INSERT INTO org_email_templates (org_id, template_key, subject, body_html, enabled, updated_by, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, NOW())
             ON CONFLICT (org_id, template_key) DO UPDATE SET
                 subject    = EXCLUDED.subject,
                 body_html  = EXCLUDED.body_html,
                 enabled    = EXCLUDED.enabled,
                 updated_by = EXCLUDED.updated_by,
                 updated_at = NOW()`,
            [req.userOrgId, key, subject, body_html, enabledFlag, req.userId],
        );
        invalidateBrandingCache(req.tenantId, req.userOrgId);
        logAction(req, "update", "org_email_template", req.userOrgId, { template_key: key });
        res.json({ ok: true, template_key: key });
    } catch (err) {
        req.log.error({ err }, "PUT /branding/email-templates failed");
        res.status(500).json({ error: "Failed to update template" });
    }
});

/** DELETE /branding/email-templates/:templateKey — revert to built-in. */
router.delete("/email-templates/:templateKey", requireRole("hr_admin"), requireSameOrg, async (req: Request, res: Response) => {
    try {
        const key = String(req.params.templateKey || "");
        if (!TEMPLATE_KEYS.includes(key)) return res.status(400).json({ error: "Unknown template key" });
        await req.db!.query(
            `DELETE FROM org_email_templates WHERE org_id = $1 AND template_key = $2`,
            [req.userOrgId, key],
        );
        invalidateBrandingCache(req.tenantId, req.userOrgId);
        logAction(req, "delete", "org_email_template", req.userOrgId, { template_key: key });
        res.json({ ok: true });
    } catch (err) {
        req.log.error({ err }, "DELETE /branding/email-templates failed");
        res.status(500).json({ error: "Failed to revert template" });
    }
});

/**
 * POST /branding/email-templates/:templateKey/preview
 * Body: { subject?, body_html? }   (when omitted, preview uses the saved override / built-in)
 *
 * Renders the template against this org's branding + a draft override and
 * returns { subject, html }. Used by the live-preview pane in the editor.
 */
router.post("/email-templates/:templateKey/preview", requireRole("hr_admin"), requireSameOrg, async (req: Request, res: Response) => {
    try {
        const key = String(req.params.templateKey || "");
        if (!TEMPLATE_KEYS.includes(key)) return res.status(400).json({ error: "Unknown template key" });

        const sample = TEMPLATE_PREVIEW_ARGS[key]();
        const built = templates[key](...sample);

        // Body: prefer the draft from the request, then the saved override, then the built-in.
        let subject = req.body?.subject;
        let body = req.body?.body_html;
        if (!subject || !body) {
            const saved = (await req.db!.query(
                `SELECT subject, body_html FROM org_email_templates WHERE org_id = $1 AND template_key = $2`,
                [req.userOrgId, key],
            )).rows[0];
            subject = subject || saved?.subject || built.subject;
            body = body || saved?.body_html || built.body;
        }

        const branding = await loadOrgBranding(req.db, req.tenantId, req.userOrgId);
        const html = applyBranding(body, branding);
        res.json({ subject, html });
    } catch (err) {
        req.log.error({ err }, "POST /branding/email-templates/:key/preview failed");
        res.status(500).json({ error: "Failed to render preview" });
    }
});

export = router;
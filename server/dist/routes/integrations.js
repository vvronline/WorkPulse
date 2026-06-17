"use strict";
// Per-org integrations management (Stage 3 — GitHub first).
//
//   GET    /api/integrations               — list provider rows for the org
//   POST   /api/integrations/github        — create/update GitHub integration
//                                            (manager+); generates a webhook
//                                            secret which is returned ONCE so
//                                            the user can paste it into GitHub.
//   GET    /api/integrations/:id/webhook   — returns the public webhook URL
//                                            for this integration
//   DELETE /api/integrations/:id           — remove an integration (manager+)
//
// Secrets live in `org_integration_secrets` and are NEVER serialised back to
// the client after creation. The only time the webhook secret is exposed is
// in the create response — losing it means rotating via POST again.
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
const express_1 = __importDefault(require("express"));
const crypto = require("crypto");
const auth = require("../middleware/auth");
const { loadUserContext, requireRole } = require("../middleware/rbac");
const { requireTenant, requireFeature } = require("../middleware/tenant");
const { logAction } = require("../utils/audit");
const github = require("../services/github");
const router = express_1.default.Router();
// ─── GitHub OAuth callback ─────────────────────────────────────────────────
// Mounted BEFORE requireTenant because the GitHub redirect lands without a
// tenant cookie context — we recover (orgId, userId, tenantId) from the
// signed `state` we persisted in Redis. Everything else still goes through
// requireTenant + auth.
router.get("/github/oauth/callback", async (req, res) => {
    try {
        if (!github.isConfigured()) {
            return res.status(500).send("GitHub OAuth is not configured on the server (missing GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET).");
        }
        const { code, state, error } = req.query;
        if (error)
            return res.status(400).send(`GitHub returned an error: ${error}`);
        if (!code || !state)
            return res.status(400).send("Missing code or state");
        const ctx = await github.consumeState(state);
        if (!ctx)
            return res.status(400).send("OAuth state expired or already used. Please restart the connection from WorkPulse.");
        // Resolve the tenant DB for the (tenantId) we stashed in state.
        const masterDb = require("../db");
        const { getTenantPool } = require("../utils/tenantManager");
        let db;
        if (ctx.tenantId) {
            const tenantRow = (await masterDb.masterQuery("SELECT db_name, db_host FROM tenants WHERE id = $1", [ctx.tenantId])).rows[0];
            if (!tenantRow)
                return res.status(404).send("Tenant not found");
            db = await getTenantPool(tenantRow.db_name, tenantRow.db_host);
        }
        else {
            db = { query: masterDb.masterQuery, transaction: masterDb.masterTransaction };
        }
        // Exchange code → token, then fetch viewer info.
        const tokenData = await github.exchangeCodeForToken(code, req);
        const viewer = await github.getViewer(tokenData.access_token);
        // Upsert integration row + secret (with token + identity).
        await db.transaction(async (client) => {
            const existing = (await client.query("SELECT id FROM org_integrations WHERE org_id = $1 AND provider = $2", [ctx.orgId, "github"])).rows[0];
            let integrationId;
            const config = {
                owner: viewer.login, // default to the connecting user; admin can edit later
                avatar_url: viewer.avatar_url,
                viewer_type: viewer.type, // 'User' or 'Organization'
                connected_at: new Date().toISOString(),
            };
            if (existing) {
                await client.query(`UPDATE org_integrations
                        SET config = $1, is_active = TRUE, updated_at = NOW()
                      WHERE id = $2`, [JSON.stringify(config), existing.id]);
                integrationId = existing.id;
            }
            else {
                integrationId = (await client.query(`INSERT INTO org_integrations (org_id, provider, config, created_by)
                     VALUES ($1, 'github', $2, $3)
                     RETURNING id`, [ctx.orgId, JSON.stringify(config), ctx.userId])).rows[0].id;
            }
            // We don't issue the webhook secret yet — that happens at
            // /repos/connect time so the secret rotates per-repo install.
            await client.query(`INSERT INTO org_integration_secrets
                    (integration_id, access_token, github_login, github_avatar, scopes, updated_at)
                 VALUES ($1, $2, $3, $4, $5, NOW())
                 ON CONFLICT (integration_id) DO UPDATE SET
                    access_token  = EXCLUDED.access_token,
                    github_login  = EXCLUDED.github_login,
                    github_avatar = EXCLUDED.github_avatar,
                    scopes        = EXCLUDED.scopes,
                    updated_at    = NOW()`, [integrationId, tokenData.access_token, viewer.login, viewer.avatar_url || null, tokenData.scope || null]);
        });
        // Close-the-popup HTML so the React opener can refresh its UI.
        res.send(`
            <!doctype html><html><body>
                <p>Connected to GitHub as <strong>${viewer.login}</strong>. You can close this window.</p>
                <script>
                  try { window.opener && window.opener.postMessage({ type: 'github-connected', login: '${viewer.login}' }, '*'); } catch(e){}
                  setTimeout(() => window.close(), 1200);
                </script>
            </body></html>
        `);
    }
    catch (err) {
        require("../utils/logger").logger.error({ err: err.message }, "GitHub OAuth callback failed");
        res.status(500).send("Failed to complete GitHub OAuth: " + (err.message || "unknown"));
    }
});
// Integration management requires the `webhooks` feature (Enterprise). The
// OAuth callback above is intentionally NOT gated — it has no tenant cookie
// and is a no-op for tenants that lost the feature (they simply can't act
// on the resulting integration).
router.use(requireTenant, requireFeature("webhooks"));
router.get("/", auth, loadUserContext, requireRole("manager"), async (req, res) => {
    try {
        const rows = (await req.db.query(`SELECT i.id, i.provider, i.config, i.is_active, i.created_at, i.updated_at,
                    (s.webhook_secret IS NOT NULL)  AS has_webhook_secret,
                    (s.access_token   IS NOT NULL)  AS has_access_token,
                    s.github_login,
                    s.github_avatar,
                    s.scopes
               FROM org_integrations i
          LEFT JOIN org_integration_secrets s ON s.integration_id = i.id
              WHERE i.org_id = $1
              ORDER BY i.provider`, [req.userOrgId])).rows;
        res.json(rows);
    }
    catch (err) {
        req.log.error({ err }, "Failed to list integrations");
        res.status(500).json({ error: "Failed to list integrations" });
    }
});
// ─── GitHub OAuth: kick off ──────────────────────────────────────────────
// Returns the GitHub authorize URL the client should redirect to (or open in
// a popup). The client persists the popup result via postMessage.
router.post("/github/oauth/start", auth, loadUserContext, requireRole("manager"), async (req, res) => {
    try {
        if (!github.isConfigured()) {
            return res.status(503).json({
                error: "GitHub OAuth is not configured. Set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET on the server.",
                docs: "https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/creating-an-oauth-app",
                callback_url: github.callbackUrl(req),
            });
        }
        const state = await github.issueState(req.userOrgId, req.userId, req.tenantId || null);
        res.json({
            authorize_url: github.buildAuthorizeUrl(req, state),
            callback_url: github.callbackUrl(req),
        });
    }
    catch (err) {
        req.log.error({ err }, "Failed to start GitHub OAuth");
        res.status(500).json({ error: "Failed to start GitHub OAuth" });
    }
});
// ─── Status of the current GitHub connection ─────────────────────────────
router.get("/github/status", auth, loadUserContext, requireRole("manager"), async (req, res) => {
    try {
        const row = (await req.db.query(`SELECT i.id, i.config, s.github_login, s.github_avatar,
                    (s.access_token IS NOT NULL) AS connected
               FROM org_integrations i
          LEFT JOIN org_integration_secrets s ON s.integration_id = i.id
              WHERE i.org_id = $1 AND i.provider = 'github'`, [req.userOrgId])).rows[0];
        if (!row)
            return res.json({ connected: false });
        const repos = (await req.db.query(`SELECT full_name, html_url, default_branch, hook_id, is_active
               FROM github_repo_connections
              WHERE integration_id = $1
              ORDER BY full_name`, [row.id])).rows;
        res.json({
            connected: !!row.connected,
            integration_id: row.id,
            github_login: row.github_login,
            github_avatar: row.github_avatar,
            config: row.config,
            repos,
        });
    }
    catch (err) {
        req.log.error({ err }, "Failed to fetch GitHub status");
        res.status(500).json({ error: "Failed to fetch GitHub status" });
    }
});
// ─── List repos available to the authed GitHub user ──────────────────────
router.get("/github/repos", auth, loadUserContext, requireRole("manager"), async (req, res) => {
    try {
        const secret = (await req.db.query(`SELECT s.access_token
               FROM org_integration_secrets s
               JOIN org_integrations i ON i.id = s.integration_id
              WHERE i.org_id = $1 AND i.provider = 'github'`, [req.userOrgId])).rows[0];
        if (!secret?.access_token) {
            return res.status(400).json({ error: "Connect a GitHub account first." });
        }
        const repos = await github.listAccessibleRepos(secret.access_token);
        res.json({ repos });
    }
    catch (err) {
        req.log.error({ err: err.message }, "Failed to list GitHub repos");
        res.status(err.status === 401 ? 401 : 500).json({ error: err.message || "Failed to list repos" });
    }
});
// ─── Connect specific repos: installs webhooks on each ───────────────────
router.post("/github/repos/connect", auth, loadUserContext, requireRole("manager"), async (req, res) => {
    try {
        const { repos } = req.body || {};
        if (!Array.isArray(repos) || repos.length === 0) {
            return res.status(400).json({ error: 'repos must be a non-empty array of "owner/repo" strings.' });
        }
        const integration = (await req.db.query(`SELECT i.id, s.access_token, s.webhook_secret
               FROM org_integrations i
          LEFT JOIN org_integration_secrets s ON s.integration_id = i.id
              WHERE i.org_id = $1 AND i.provider = 'github'`, [req.userOrgId])).rows[0];
        if (!integration?.access_token) {
            return res.status(400).json({ error: "Connect a GitHub account first." });
        }
        // Reuse existing webhook secret if we have one (so re-running the
        // connect flow doesn't break already-installed webhooks); otherwise
        // mint a new one and persist it.
        let webhookSecret = integration.webhook_secret;
        if (!webhookSecret) {
            webhookSecret = crypto.randomBytes(32).toString("hex");
            await req.db.query(`UPDATE org_integration_secrets SET webhook_secret = $1, updated_at = NOW() WHERE integration_id = $2`, [webhookSecret, integration.id]);
        }
        const hookUrl = github.webhookUrl(req, integration.id);
        const results = [];
        for (const fullName of repos) {
            try {
                // 1. Install / refresh the webhook on GitHub.
                const hookId = await github.ensureRepoWebhook(integration.access_token, fullName, hookUrl, webhookSecret);
                // 2. Persist the connection row.
                await req.db.query(`INSERT INTO github_repo_connections
                        (integration_id, full_name, html_url, hook_id, is_active, updated_at)
                     VALUES ($1, $2, $3, $4, TRUE, NOW())
                     ON CONFLICT (integration_id, full_name)
                     DO UPDATE SET hook_id = EXCLUDED.hook_id, is_active = TRUE, updated_at = NOW()`, [integration.id, fullName, `https://github.com/${fullName}`, hookId]);
                results.push({ full_name: fullName, ok: true, hook_id: hookId });
            }
            catch (e) {
                req.log.warn({ err: e.message, fullName }, "Failed to connect repo");
                results.push({ full_name: fullName, ok: false, error: e.message });
            }
        }
        logAction(req, "connect", "github_repos", integration.id, { count: results.filter(r => r.ok).length });
        res.json({ webhook_url: hookUrl, results });
    }
    catch (err) {
        req.log.error({ err }, "Failed to connect repos");
        res.status(500).json({ error: "Failed to connect repos" });
    }
});
// ─── Disconnect a single repo: removes the GitHub webhook ────────────────
// The repo full name (owner/repo) lives in the URL but contains a '/'.
// Express 5 dropped `*`-suffix syntax; the client must url-encode the slash
// so the param arrives as a single capture (e.g. owner%2Frepo). We decode
// here before lookup.
router.delete("/github/repos/:fullName", auth, loadUserContext, requireRole("manager"), async (req, res) => {
    try {
        const fullName = decodeURIComponent(String(req.params.fullName));
        const row = (await req.db.query(`SELECT rc.id, rc.hook_id, s.access_token, i.id AS integration_id
               FROM github_repo_connections rc
               JOIN org_integrations i ON i.id = rc.integration_id
          LEFT JOIN org_integration_secrets s ON s.integration_id = i.id
              WHERE i.org_id = $1 AND rc.full_name = $2`, [req.userOrgId, fullName])).rows[0];
        if (!row)
            return res.status(404).json({ error: "Repo connection not found" });
        if (row.hook_id && row.access_token) {
            await github.deleteRepoWebhook(row.access_token, fullName, row.hook_id);
        }
        await req.db.query("DELETE FROM github_repo_connections WHERE id = $1", [row.id]);
        logAction(req, "disconnect", "github_repo", row.integration_id, { full_name: fullName });
        res.json({ ok: true });
    }
    catch (err) {
        req.log.error({ err }, "Failed to disconnect repo");
        res.status(500).json({ error: "Failed to disconnect repo" });
    }
});
// ─── Disconnect the whole GitHub integration ─────────────────────────────
router.post("/github/disconnect", auth, loadUserContext, requireRole("manager"), async (req, res) => {
    try {
        const integration = (await req.db.query(`SELECT i.id, s.access_token
               FROM org_integrations i
          LEFT JOIN org_integration_secrets s ON s.integration_id = i.id
              WHERE i.org_id = $1 AND i.provider = 'github'`, [req.userOrgId])).rows[0];
        if (!integration)
            return res.json({ ok: true });
        // Best-effort remove every webhook we installed.
        if (integration.access_token) {
            const repos = (await req.db.query("SELECT full_name, hook_id FROM github_repo_connections WHERE integration_id = $1", [integration.id])).rows;
            for (const r of repos) {
                if (r.hook_id)
                    await github.deleteRepoWebhook(integration.access_token, r.full_name, r.hook_id);
            }
        }
        await req.db.query("DELETE FROM org_integrations WHERE id = $1", [integration.id]);
        logAction(req, "disconnect", "integration", integration.id, { provider: "github" });
        res.json({ ok: true });
    }
    catch (err) {
        req.log.error({ err }, "Failed to disconnect GitHub");
        res.status(500).json({ error: "Failed to disconnect GitHub" });
    }
});
// Build the absolute webhook URL the user pastes into GitHub. We use the
// request's host so the URL stays correct across custom domains / local
// dev / Railway deployments.
function buildWebhookUrl(req, integrationId) {
    const proto = req.headers["x-forwarded-proto"] || (req.secure ? "https" : "http");
    const host = req.headers["x-forwarded-host"] || req.headers.host;
    return `${proto}://${host}/api/webhooks/github/${integrationId}`;
}
router.post("/github", auth, loadUserContext, requireRole("manager"), async (req, res) => {
    try {
        if (!req.userOrgId)
            return res.status(400).json({ error: "Organization required" });
        const { owner, repos, default_branch } = req.body || {};
        if (!owner || typeof owner !== "string") {
            return res.status(400).json({ error: "owner (GitHub org/user name) is required" });
        }
        const config = {
            owner: String(owner).trim(),
            repos: Array.isArray(repos) ? repos.map((r) => String(r).trim()).filter(Boolean).slice(0, 100) : [],
            default_branch: default_branch ? String(default_branch).trim() : "main",
        };
        // Upsert the integration row.
        const integration = await req.db.transaction(async (client) => {
            const existing = (await client.query("SELECT id FROM org_integrations WHERE org_id = $1 AND provider = $2", [req.userOrgId, "github"])).rows[0];
            let row;
            if (existing) {
                row = (await client.query(`UPDATE org_integrations
                        SET config = $1, is_active = TRUE, updated_at = NOW()
                      WHERE id = $2
                      RETURNING *`, [JSON.stringify(config), existing.id])).rows[0];
            }
            else {
                row = (await client.query(`INSERT INTO org_integrations (org_id, provider, config, created_by)
                     VALUES ($1, 'github', $2, $3)
                     RETURNING *`, [req.userOrgId, JSON.stringify(config), req.userId])).rows[0];
            }
            // (Re)generate the webhook secret. 32 random bytes hex-encoded
            // gives the GitHub-recommended 64-character secret string.
            const secret = crypto.randomBytes(32).toString("hex");
            await client.query(`INSERT INTO org_integration_secrets (integration_id, webhook_secret, updated_at)
                 VALUES ($1, $2, NOW())
                 ON CONFLICT (integration_id) DO UPDATE
                   SET webhook_secret = EXCLUDED.webhook_secret, updated_at = NOW()`, [row.id, secret]);
            return { row, secret };
        });
        logAction(req, "configure", "integration", integration.row.id, { provider: "github", owner: config.owner });
        res.json({
            integration: integration.row,
            // These two are the user-facing setup payload — they're only
            // returned once at creation/rotation time and must be saved by
            // the user before they leave the screen.
            webhook_url: buildWebhookUrl(req, integration.row.id),
            webhook_secret: integration.secret,
            instructions: [
                "Open your GitHub repository (or org) → Settings → Webhooks → Add webhook.",
                "Payload URL: paste the webhook_url above.",
                "Content type: application/json.",
                "Secret: paste the webhook_secret above.",
                "SSL verification: enabled.",
                'Events: select "Send me everything" or at minimum: Branch or tag creation/deletion, Pull requests, Pushes.',
            ],
        });
    }
    catch (err) {
        req.log.error({ err }, "Failed to configure GitHub integration");
        res.status(500).json({ error: "Failed to configure GitHub integration" });
    }
});
router.get("/:id/webhook", auth, loadUserContext, requireRole("manager"), async (req, res) => {
    try {
        const id = parseInt(String(req.params.id), 10);
        if (isNaN(id))
            return res.status(400).json({ error: "Invalid id" });
        const exists = (await req.db.query("SELECT id FROM org_integrations WHERE id = $1 AND org_id = $2", [id, req.userOrgId])).rowCount;
        if (!exists)
            return res.status(404).json({ error: "Integration not found" });
        res.json({ webhook_url: buildWebhookUrl(req, id) });
    }
    catch (err) {
        req.log.error({ err }, "Failed to fetch webhook url");
        res.status(500).json({ error: "Failed to fetch webhook url" });
    }
});
router.delete("/:id", auth, loadUserContext, requireRole("manager"), async (req, res) => {
    try {
        const id = parseInt(String(req.params.id), 10);
        if (isNaN(id))
            return res.status(400).json({ error: "Invalid id" });
        const r = await req.db.query("DELETE FROM org_integrations WHERE id = $1 AND org_id = $2 RETURNING provider", [id, req.userOrgId]);
        if (r.rowCount === 0)
            return res.status(404).json({ error: "Integration not found" });
        logAction(req, "delete", "integration", id, { provider: r.rows[0].provider });
        res.json({ ok: true });
    }
    catch (err) {
        req.log.error({ err }, "Failed to delete integration");
        res.status(500).json({ error: "Failed to delete integration" });
    }
});
module.exports = router;
//# sourceMappingURL=integrations.js.map
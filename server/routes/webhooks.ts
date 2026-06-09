// Inbound webhook receivers (Stage 3).
//
//   POST /api/webhooks/github/:integrationId
//     - Body parsed as raw JSON (we re-stringify for HMAC verification).
//     - Verifies X-Hub-Signature-256 against the integration's stored secret.
//     - Recognised events: `create` (branch), `pull_request`, `push`.
//     - For every issue key found in the branch / PR title / commit message,
//       upserts a row into `task_git_refs` so the task page renders a
//       branch → PR → merged timeline.
//
// Webhook endpoints are mounted BEFORE the global JSON body parser by
// `server/index.js` so we get the raw payload for HMAC verification.

import express from "express";
import type { Request, Response } from "express";
const crypto = require("crypto");
const { logger } = require("../utils/logger");
const { getTenantPool } = require("../utils/tenantManager");
const { masterQuery } = require("../db");
const { isFeatureEnabled } = require("../utils/planCatalog");
const { extractIssueKeys, resolveIssueKeys } = require("./tasks/_helpers/issueKey");

const router = express.Router();

interface DbLike {
    query: (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount: number }>;
    transaction: <T = unknown>(fn: (client: any) => Promise<T>) => Promise<T>;
}

interface ResolvedIntegration {
    db: DbLike;
    orgId: number;
    tenantId: number | null;
}

interface GitRefUpsert {
    raw: string;
    ref_type: string;
    status: string;
    external_id: string;
    title: string | null;
    url: string | null;
    repository: string | null;
    ref_name: string | null;
    author_login: string | null;
    commit_sha?: string | null;
}

// NOTE: `requireFeature('webhooks')` was previously mounted here as router
// middleware. That was a bug — inbound GitHub webhooks land WITHOUT a tenant
// cookie / JWT, so `req.tenant` is null when `resolveTenant` runs, which
// causes `requireFeature` to short-circuit to next() (master context). The
// gate is therefore enforced INSIDE the handler, after we resolve the tenant
// from the integration id. See `getDbForIntegration` below.

// Constant-time signature check. GitHub computes:
//   `sha256=` + HEX(HMAC_SHA256(secret, raw_body))
function verifyGithubSignature(rawBody: Buffer, signatureHeader: unknown, secret: string): boolean {
    if (!signatureHeader || !secret) return false;
    const expected = "sha256=" + crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
    const a = Buffer.from(expected);
    const b = Buffer.from(String(signatureHeader));
    // timingSafeEqual throws if lengths differ — guard explicitly.
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Resolve the tenant DB for an integration row. The integration belongs to
// an org inside a tenant, so we need to look the tenant up via the master DB.
// For legacy single-DB deployments we fall back to the master pool's query
// helpers (re-exported as `db.query` / `db.transaction`).
async function getDbForIntegration(integrationId: number): Promise<ResolvedIntegration | null> {
    // Try every tenant pool. We could persist tenant_id on the integration
    // row, but that would require a master-side lookup table. For the MVP we
    // scan the active tenants and find the one that owns the integration row.
    // This is O(tenants) at webhook time, fine for hundreds of tenants and
    // can be optimised later by caching.
    const tenants = (await masterQuery(
        "SELECT id, slug, db_name, db_host FROM tenants WHERE status != 'deleted'"
    )).rows;
    for (const tenant of tenants) {
        try {
            const pool = await getTenantPool(tenant.db_name, tenant.db_host);
            const exists = (await pool.query(
                "SELECT id, org_id FROM org_integrations WHERE id = $1",
                [integrationId]
            )).rows[0];
            if (exists) return { db: pool, orgId: exists.org_id, tenantId: tenant.id };
        } catch (e: any) {
            // Tenant DB unreachable — skip and try the next.
            logger.warn({ err: e.message, tenant: tenant.slug }, "Tenant pool scan skipped");
        }
    }
    // Single-DB legacy fallback
    const db = require("../db");
    const exists = (await db.masterQuery(
        "SELECT id, org_id FROM org_integrations WHERE id = $1",
        [integrationId]
    )).rows[0];
    if (exists) return { db: { query: db.masterQuery, transaction: db.masterTransaction }, orgId: exists.org_id, tenantId: null };
    return null;
}

router.post("/github/:integrationId", express.raw({ type: "*/*", limit: "5mb" }), async (req: Request, res: Response) => {
    try {
        const integrationId = parseInt(String(req.params.integrationId), 10);
        if (isNaN(integrationId)) return res.status(400).send("Invalid integration id");

        const resolved = await getDbForIntegration(integrationId);
        if (!resolved) return res.status(404).send("Integration not found");
        const { db, orgId, tenantId } = resolved;

        // ── Plan gate ───────────────────────────────────────────────────
        // We can only check the gate AFTER tenant resolution; doing it via
        // router-level requireFeature() short-circuits because the inbound
        // GitHub request has no tenant cookie.
        if (tenantId) {
            const tenantRow = (await masterQuery(
                "SELECT plan, features, status FROM tenants WHERE id = $1",
                [tenantId]
            )).rows[0];
            if (!tenantRow || tenantRow.status === "deleted") {
                return res.status(404).send("Integration not found");
            }
            if (!isFeatureEnabled(tenantRow, "webhooks")) {
                logger.warn({
                    event: "feature_gate_rejected",
                    feature: "webhooks",
                    plan: tenantRow.plan,
                    tenantId,
                    integrationId,
                }, "GitHub webhook rejected — plan does not include webhooks");
                // Use 410 Gone so GitHub auto-disables redelivery rather than
                // retrying forever (a plain 403 would keep retrying).
                return res.status(410).send("Webhooks are not enabled for this organization's subscription plan.");
            }
        }

        // Load the stored secret to verify the signature.
        const secretRow = (await db.query(
            "SELECT webhook_secret FROM org_integration_secrets WHERE integration_id = $1",
            [integrationId]
        )).rows[0];
        const secret = secretRow?.webhook_secret;
        if (!secret) return res.status(401).send("No webhook secret configured");

        const rawBody = req.body as Buffer; // Buffer because of express.raw above
        const signature = req.headers["x-hub-signature-256"];
        if (!verifyGithubSignature(rawBody, signature, secret)) {
            logger.warn({ integrationId }, "GitHub webhook signature mismatch");
            return res.status(401).send("Invalid signature");
        }

        const event = String(req.headers["x-github-event"] || "unknown");
        let payload: any;
        try {
            payload = JSON.parse(rawBody.toString("utf8") || "{}");
        } catch {
            return res.status(400).send("Invalid JSON");
        }

        // Ignore GitHub's ping handshake.
        if (event === "ping") return res.json({ ok: true, pong: true });

        const repo = payload.repository?.full_name || null;
        const refsToUpsert: GitRefUpsert[] = [];

        if (event === "create" && payload.ref_type === "branch") {
            // Branch created.
            const branch = payload.ref;
            const keys = extractIssueKeys(branch);
            for (const k of keys) {
                refsToUpsert.push({
                    raw: k.raw,
                    ref_type: "branch",
                    status: "open",
                    external_id: branch,
                    title: branch,
                    url: payload.repository?.html_url ? `${payload.repository.html_url}/tree/${branch}` : null,
                    repository: repo,
                    ref_name: branch,
                    author_login: payload.sender?.login || null,
                });
            }
        } else if (event === "pull_request") {
            const pr = payload.pull_request || {};
            const action = payload.action; // opened / reopened / closed / synchronize / edited / ready_for_review
            const merged = !!pr.merged;
            const status = action === "closed"
                ? (merged ? "merged" : "closed")
                : (pr.draft ? "draft" : "open");
            const haystack = `${pr.title || ""}\n${pr.head?.ref || ""}\n${pr.body || ""}`;
            const keys = extractIssueKeys(haystack);
            for (const k of keys) {
                refsToUpsert.push({
                    raw: k.raw,
                    ref_type: "pull_request",
                    status,
                    external_id: String(pr.number || ""),
                    title: pr.title || null,
                    url: pr.html_url || null,
                    repository: repo,
                    ref_name: pr.head?.ref || null,
                    author_login: pr.user?.login || null,
                    commit_sha: pr.head?.sha || null,
                });
            }
        } else if (event === "push") {
            const commits = Array.isArray(payload.commits) ? payload.commits : [];
            for (const c of commits) {
                const keys = extractIssueKeys(c.message || "");
                for (const k of keys) {
                    refsToUpsert.push({
                        raw: k.raw,
                        ref_type: "commit",
                        status: "committed",
                        external_id: c.id,
                        title: (c.message || "").split("\n")[0].slice(0, 200),
                        url: c.url || null,
                        repository: repo,
                        ref_name: payload.ref || null,
                        author_login: c.author?.username || c.author?.name || null,
                        commit_sha: c.id,
                    });
                }
            }
        } else {
            // Unhandled event — ack so GitHub doesn't retry.
            return res.json({ ok: true, ignored: event });
        }

        if (refsToUpsert.length === 0) return res.json({ ok: true, linked: 0 });

        // Resolve every distinct issue key once.
        const distinctKeys = [...new Map(refsToUpsert.map(r => {
            const [projectKey, n] = r.raw.split("-");
            return [r.raw, { projectKey, taskNumber: parseInt(n, 10) }];
        })).values()];
        const resolvedKeys = await resolveIssueKeys(distinctKeys, orgId, db);
        const keyToTaskId = new Map<string, number>(resolvedKeys.map((r: any) => [r.key, r.task_id]));

        let linked = 0;
        for (const r of refsToUpsert) {
            const taskId = keyToTaskId.get(r.raw);
            if (!taskId) continue;
            await db.query(
                `INSERT INTO task_git_refs
                    (task_id, integration_id, ref_type, status, external_id, title, url,
                     repository, ref_name, author_login, commit_sha, payload, event_at, updated_at)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, NOW(), NOW())
                 ON CONFLICT (task_id, ref_type, external_id, repository)
                 DO UPDATE SET status = EXCLUDED.status, title = EXCLUDED.title, url = EXCLUDED.url,
                               ref_name = EXCLUDED.ref_name, author_login = EXCLUDED.author_login,
                               commit_sha = EXCLUDED.commit_sha, payload = EXCLUDED.payload,
                               event_at = NOW(), updated_at = NOW()`,
                [taskId, integrationId, r.ref_type, r.status, r.external_id, r.title, r.url,
                    r.repository, r.ref_name, r.author_login, r.commit_sha || null,
                    JSON.stringify({ event, action: payload.action })]
            );
            linked++;
        }

        res.json({ ok: true, linked, event });
    } catch (err: any) {
        logger.error({ err: err.message, stack: err.stack }, "GitHub webhook failed");
        // Always ack with 200 to avoid GitHub retry storms once we've parsed
        // the payload — the failure is logged for investigation. (Auth/signature
        // failures still return 401 above before we reach this catch.)
        res.status(202).json({ ok: false, error: "Failed processing webhook" });
    }
});

export = router;
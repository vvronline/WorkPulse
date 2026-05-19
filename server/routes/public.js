/**
 * Public (unauthenticated) routes (Chunk 5).
 *
 * These routes intentionally bypass auth + tenant resolution. They look up
 * resources by an unguessable token stored in the master DB and then fetch
 * the underlying record from the appropriate tenant pool.
 *
 *   GET /api/public/notes/:token
 *     → { title, content, sharedAt, orgName, branding: {logo_url, accent_color} }
 */
const express = require('express');
const { masterQuery } = require('../db');
const { getTenantById } = require('../utils/tenantManager');
const { getTenantPool } = require('../utils/tenantManager');
const { logger } = require('../utils/logger');

const router = express.Router();

/**
 * GET /api/public/branding
 *
 * Returns the resolved tenant's logo + accent color so the login / register /
 * forgot-password pages can match the org's theme BEFORE the user authenticates.
 *
 * Unlike GET /api/branding (which requires auth + a specific user's org_id),
 * this endpoint relies on tenant resolution via the Host header (custom
 * domain → tenant DB) that has already happened in middleware. It returns
 * branding for the first org found in the tenant DB; multi-org tenants will
 * naturally have one org per tenant DB so this is unambiguous.
 *
 * Returns defaults ({ logo_url: null, accent_color: null }) when:
 *   - request hits the master / default railway domain (no tenant context)
 *   - the tenant DB has no org_branding row yet
 *   - any error occurs (branding is best-effort, never blocks login)
 */
router.get('/branding', async (req, res) => {
    const EMPTY = { logo_url: null, accent_color: null };
    const BRANDING_SQL = `SELECT b.logo_url, b.accent_color
               FROM org_branding b
               JOIN organizations o ON o.id = b.org_id
              ORDER BY o.id ASC
              LIMIT 1`;

    // 1. Tenant already resolved from custom domain — use it directly.
    if (req.tenant && req.db && !req.isMasterRoute) {
        try {
            const row = (await req.db.query(BRANDING_SQL)).rows[0];
            return res.json({
                logo_url: row?.logo_url || null,
                accent_color: row?.accent_color || null,
            });
        } catch (err) {
            req.log?.warn?.({ err: err.message }, 'Public branding lookup failed');
            return res.json(EMPTY);
        }
    }

    // 2. Default domain — try slug query param for org-specific branding.
    const slug = (req.query.slug || '').trim().toLowerCase();
    if (!slug) return res.json(EMPTY);

    try {
        const tenantRow = (await masterQuery(
            `SELECT id, db_name, db_host FROM tenants WHERE slug = $1 AND status = 'active'`,
            [slug]
        )).rows[0];
        if (!tenantRow) return res.json(EMPTY);

        const tenantDb = await getTenantPool(tenantRow.db_name, tenantRow.db_host);
        const row = (await tenantDb.query(BRANDING_SQL)).rows[0];
        res.json({
            logo_url: row?.logo_url || null,
            accent_color: row?.accent_color || null,
        });
    } catch (err) {
        req.log?.warn?.({ err: err.message, slug }, 'Public branding slug lookup failed');
        res.json(EMPTY);
    }
});

router.get('/notes/:token', async (req, res) => {
    try {
        const token = String(req.params.token || '');
        if (!token || token.length < 16 || token.length > 200) {
            return res.status(404).json({ error: 'Not found' });
        }

        // 1. Look up the share token in the master DB.
        const tokenRow = (await masterQuery(
            `SELECT tenant_id, user_id, page_id, page_title, created_at
               FROM note_share_tokens WHERE token = $1`,
            [token]
        )).rows[0];
        if (!tokenRow) return res.status(404).json({ error: 'This share link is no longer active.' });

        // 2. Resolve the tenant + connect to its DB.
        const tenant = await getTenantById(tokenRow.tenant_id);
        if (!tenant || tenant.status !== 'active') {
            return res.status(404).json({ error: 'This share link is no longer active.' });
        }
        const tenantDb = await getTenantPool(tenant.db_name, tenant.db_host);

        // 3. Pull the user's notebook and locate the page.
        const notebookRow = (await tenantDb.query(
            `SELECT data, updated_at FROM notebooks WHERE user_id = $1`,
            [tokenRow.user_id]
        )).rows[0];
        if (!notebookRow) return res.status(404).json({ error: 'This share link is no longer active.' });

        let notebook;
        try { notebook = JSON.parse(notebookRow.data); } catch { notebook = null; }
        const page = notebook?.pages?.find(p => p.id === tokenRow.page_id && !p.archived);
        if (!page) return res.status(404).json({ error: 'This page is no longer shared or has been archived.' });

        // 4. Org-level branding (logo + accent) so the public viewer can match
        // the organisation's look. Falls back gracefully if branding tables
        // don't exist yet on this tenant.
        let branding = { logo_url: null, accent_color: '#6366f1' };
        let orgName = null;
        try {
            const userRow = (await tenantDb.query(
                `SELECT u.org_id, o.name AS org_name FROM users u
                  LEFT JOIN organizations o ON o.id = u.org_id
                  WHERE u.id = $1`,
                [tokenRow.user_id]
            )).rows[0];
            orgName = userRow?.org_name || tenant.org_name || null;
            if (userRow?.org_id) {
                const b = (await tenantDb.query(
                    `SELECT logo_url, accent_color FROM org_branding WHERE org_id = $1`,
                    [userRow.org_id]
                )).rows[0];
                if (b) branding = { logo_url: b.logo_url || null, accent_color: b.accent_color || '#6366f1' };
            }
        } catch { /* branding tables may not exist; defaults are fine */ }

        res.json({
            title: page.title || 'Untitled',
            content: page.content || '',
            updatedAt: page.updatedAt || notebookRow.updated_at,
            sharedAt: tokenRow.created_at,
            orgName,
            branding,
        });
    } catch (err) {
        logger.error({ err: err.message, token: req.params.token }, 'Public note share lookup failed');
        res.status(500).json({ error: 'Failed to load shared note.' });
    }
});

module.exports = router;
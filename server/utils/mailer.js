/**
 * Shared email service — used across all routes.
 * Supports two auth modes (auto-detected from env vars):
 *   1. Gmail OAuth2 (XOAUTH2) — recommended, token-based, no password stored
 *   2. Plain SMTP (username + password / app-password) — simpler fallback
 *
 * Per-tenant branding & template overrides:
 *   - When the caller passes `db` and `orgId` to `notifyByEmail` (or to
 *     `getEffectiveTemplate` directly) we look up:
 *       • org_branding(logo_url, accent_color)            → wraps every email
 *       • org_email_templates(subject, body_html, enabled) → swaps the
 *         built-in subject/body if a per-org override exists
 *   - When `db`/`orgId` are missing we fall back to the built-in templates
 *     (no DB hit). This keeps existing call sites working unchanged.
 */
const nodemailer = require('nodemailer');
const { logger } = require('./logger');

let transporter = null;

function getTransporter() {
    if (transporter) return transporter;

    // ── Mode 1: Gmail OAuth2 ────────────────────────────────────────
    if (process.env.GMAIL_CLIENT_ID && process.env.GMAIL_CLIENT_SECRET && process.env.GMAIL_REFRESH_TOKEN) {
        transporter = nodemailer.createTransport({
            host: 'smtp.gmail.com',
            port: 465,
            secure: true,
            auth: {
                type: 'OAuth2',
                user: process.env.SMTP_USER,
                clientId: process.env.GMAIL_CLIENT_ID,
                clientSecret: process.env.GMAIL_CLIENT_SECRET,
                refreshToken: process.env.GMAIL_REFRESH_TOKEN,
            },
        });
        // Verify connection at startup so OAuth errors surface early
        transporter.verify().then(() => {
            logger.info('Email transport: Gmail OAuth2 — verified');
        }).catch(err => {
            logger.error({ err: err.message }, 'Email transport: Gmail OAuth2 — verification FAILED (check refresh token / credentials)');
            transporter = null;
        });
        return transporter;
    }

    // ── Mode 2: Plain SMTP (app-password) ───────────────────────────
    if (process.env.SMTP_USER && process.env.SMTP_PASS) {
        transporter = nodemailer.createTransport({
            host: process.env.SMTP_HOST || 'smtp.gmail.com',
            port: Number(process.env.SMTP_PORT) || 587,
            secure: false,
            auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
        });
        logger.info('Email transport: SMTP (password)');
        return transporter;
    }

    return null;
}

const FROM = () => process.env.SMTP_FROM || (process.env.SMTP_USER ? `"WorkPulse" <${process.env.SMTP_USER}>` : '"WorkPulse" <noreply@workpulse.app>');

/** Escape user-controlled strings before embedding in HTML email templates. */
function esc(str) {
    if (str == null) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 3000;

/**
 * Send an email with automatic retry. Never throws.
 */
function sendMail({ to, subject, html }) {
    const mailer = getTransporter();
    if (!mailer) {
        logger.debug({ to, subject }, 'Email skipped (SMTP not configured)');
        return Promise.resolve(false);
    }
    if (!to || !to.includes('@')) {
        logger.warn({ to, subject }, 'Email skipped — invalid recipient');
        return Promise.resolve(false);
    }

    let attempt = 0;
    return new Promise((resolve) => {
        const trySend = () => {
            attempt++;
            mailer.sendMail({ from: FROM(), to, subject, html }).then(() => {
                logger.info({ to, subject }, 'Email sent successfully');
                resolve(true);
            }).catch(err => {
                if (attempt <= MAX_RETRIES) {
                    logger.warn({ err: err.message, to, subject, attempt }, 'Email send failed — retrying');
                    setTimeout(trySend, RETRY_DELAY_MS * attempt);
                } else {
                    logger.error({ err, to, subject, attempts: attempt }, 'Failed to send email after retries');
                    resolve(false);
                }
            });
        };
        trySend();
    });
}

// ────────────────────────────────────────────────────────────────────────────
// Built-in templates
//
// Each template is `(...args) → { to, subject, body }` where `body` is the
// inner HTML (no <html><body> wrapper). The caller — applyBranding() —
// wraps it with org logo + accent header + footer.
//
// The exact set of args + their order is the public contract used by
// notifyByEmail callers. Don't reorder. New templates can be added freely.
// ────────────────────────────────────────────────────────────────────────────
const TEMPLATE_KEYS = [
    'leaveApproved', 'leaveRejected', 'leaveRevoked',
    'taskAssigned', 'mention',
    'manualEntryApproved', 'manualEntryRejected',
    'meetingScheduled', 'meetingUpdated', 'meetingCancelled',
];

const templates = {
    leaveApproved: (user, leave) => ({
        to: user.email,
        subject: 'WorkPulse — Leave Approved',
        body: `<h2 style="color:#22c55e;margin:0 0 12px;">Leave Approved ✅</h2>
            <p>Hi <strong>${esc(user.full_name)}</strong>,</p>
            <p>Your <strong>${esc(leave.leave_type)}</strong> leave on <strong>${esc(leave.date)}</strong> has been approved.</p>`,
    }),
    leaveRejected: (user, leave, reason) => ({
        to: user.email,
        subject: 'WorkPulse — Leave Rejected',
        body: `<h2 style="color:#ef4444;margin:0 0 12px;">Leave Rejected</h2>
            <p>Hi <strong>${esc(user.full_name)}</strong>,</p>
            <p>Your <strong>${esc(leave.leave_type)}</strong> leave on <strong>${esc(leave.date)}</strong> has been rejected.</p>
            ${reason ? `<p><em>Reason: ${esc(reason)}</em></p>` : ''}`,
    }),
    leaveRevoked: (user, leave) => ({
        to: user.email,
        subject: 'WorkPulse — Leave Revoked',
        body: `<h2 style="color:#f59e0b;margin:0 0 12px;">Leave Revoked</h2>
            <p>Hi <strong>${esc(user.full_name)}</strong>,</p>
            <p>Your <strong>${esc(leave.leave_type)}</strong> leave on <strong>${esc(leave.date)}</strong> has been revoked by management.</p>`,
    }),
    taskAssigned: (user, task, assignerName) => ({
        to: user.email,
        subject: `WorkPulse — Task Assigned: ${esc(task.title)}`,
        body: `<h2 style="color:{{accent}};margin:0 0 12px;">New Task Assigned</h2>
            <p>Hi <strong>${esc(user.full_name)}</strong>,</p>
            <p><strong>${esc(assignerName)}</strong> assigned you a task:</p>
            <p style="background:#f3f4f6;padding:12px;border-radius:8px;"><strong>${esc(task.title)}</strong></p>
            ${task.due_date ? `<p>Due: ${esc(task.due_date)}</p>` : ''}`,
    }),
    mention: (user, commenterName, taskTitle) => ({
        to: user.email,
        subject: `WorkPulse — ${esc(commenterName)} mentioned you`,
        body: `<h2 style="color:{{accent}};margin:0 0 12px;">You were mentioned</h2>
            <p>Hi <strong>${esc(user.full_name)}</strong>,</p>
            <p><strong>${esc(commenterName)}</strong> mentioned you in a comment on task: <strong>${esc(taskTitle)}</strong></p>`,
    }),
    manualEntryApproved: (user, date) => ({
        to: user.email,
        subject: 'WorkPulse — Manual Entry Approved',
        body: `<h2 style="color:#22c55e;margin:0 0 12px;">Manual Entry Approved ✅</h2>
            <p>Hi <strong>${esc(user.full_name)}</strong>,</p>
            <p>Your manual time entry for <strong>${esc(date)}</strong> has been approved.</p>`,
    }),
    manualEntryRejected: (user, date, reason) => ({
        to: user.email,
        subject: 'WorkPulse — Manual Entry Rejected',
        body: `<h2 style="color:#ef4444;margin:0 0 12px;">Manual Entry Rejected</h2>
            <p>Hi <strong>${esc(user.full_name)}</strong>,</p>
            <p>Your manual time entry for <strong>${esc(date)}</strong> has been rejected.</p>
            ${reason ? `<p><em>Reason: ${esc(reason)}</em></p>` : ''}`,
    }),
    meetingScheduled: (user, meeting, organizerName) => ({
        to: user.email,
        subject: `WorkPulse — Meeting Scheduled: ${esc(meeting.title)}`,
        body: `<h2 style="color:{{accent}};margin:0 0 12px;">📹 Meeting Scheduled</h2>
            <p>Hi <strong>${esc(user.full_name)}</strong>,</p>
            <p><strong>${esc(organizerName)}</strong> has scheduled a meeting:</p>
            <p style="background:#f3f4f6;padding:12px;border-radius:8px;"><strong>${esc(meeting.title)}</strong></p>
            ${meeting.start_time ? `<p>Start: <strong>${esc(new Date(meeting.start_time).toLocaleString())}</strong></p>` : ''}
            ${meeting.end_time ? `<p>End: <strong>${esc(new Date(meeting.end_time).toLocaleString())}</strong></p>` : ''}
            ${meeting.meeting_code ? `<p>Meeting code: <strong>${esc(meeting.meeting_code)}</strong></p>` : ''}`,
    }),
    meetingUpdated: (user, meeting, organizerName) => ({
        to: user.email,
        subject: `WorkPulse — Meeting Updated: ${esc(meeting.title)}`,
        body: `<h2 style="color:#f59e0b;margin:0 0 12px;">📹 Meeting Updated</h2>
            <p>Hi <strong>${esc(user.full_name)}</strong>,</p>
            <p><strong>${esc(organizerName)}</strong> has updated the meeting:</p>
            <p style="background:#f3f4f6;padding:12px;border-radius:8px;"><strong>${esc(meeting.title)}</strong></p>
            ${meeting.meeting_code ? `<p>Meeting code: <strong>${esc(meeting.meeting_code)}</strong></p>` : ''}`,
    }),
    meetingCancelled: (user, meeting, organizerName) => ({
        to: user.email,
        subject: `WorkPulse — Meeting Cancelled: ${esc(meeting.title)}`,
        body: `<h2 style="color:#ef4444;margin:0 0 12px;">📹 Meeting Cancelled</h2>
            <p>Hi <strong>${esc(user.full_name)}</strong>,</p>
            <p><strong>${esc(organizerName)}</strong> has cancelled the meeting:</p>
            <p style="background:#f3f4f6;padding:12px;border-radius:8px;"><strong>${esc(meeting.title)}</strong></p>
            <p>This meeting has been removed from your calendar.</p>`,
    }),
};

/**
 * Sample render args for the template preview UI. The values here are NEVER
 * stored anywhere — they're only used in the in-memory preview that the
 * BrandingSection in the client renders. Keep them in sync with the real
 * template signatures above.
 */
const TEMPLATE_PREVIEW_ARGS = {
    leaveApproved: () => [{ full_name: 'Sample User', email: 'preview@example.com' }, { leave_type: 'Annual', date: '2025-12-25' }],
    leaveRejected: () => [{ full_name: 'Sample User', email: 'preview@example.com' }, { leave_type: 'Sick', date: '2025-11-10' }, 'Project deadline this week'],
    leaveRevoked: () => [{ full_name: 'Sample User', email: 'preview@example.com' }, { leave_type: 'Personal', date: '2025-09-05' }],
    taskAssigned: () => [{ full_name: 'Sample User', email: 'preview@example.com' }, { title: 'Implement login screen', due_date: '2025-08-20' }, 'Alice Manager'],
    mention: () => [{ full_name: 'Sample User', email: 'preview@example.com' }, 'Bob Reviewer', 'Implement login screen'],
    manualEntryApproved: () => [{ full_name: 'Sample User', email: 'preview@example.com' }, '2025-08-15'],
    manualEntryRejected: () => [{ full_name: 'Sample User', email: 'preview@example.com' }, '2025-08-15', 'Please attach a justification'],
    meetingScheduled: () => [{ full_name: 'Sample User', email: 'preview@example.com' }, { title: 'Sprint Planning', start_time: new Date(Date.now() + 86400000).toISOString(), end_time: new Date(Date.now() + 90000000).toISOString(), meeting_code: 'ABC-1234-XYZ' }, 'Alice Manager'],
    meetingUpdated: () => [{ full_name: 'Sample User', email: 'preview@example.com' }, { title: 'Sprint Planning', meeting_code: 'ABC-1234-XYZ' }, 'Alice Manager'],
    meetingCancelled: () => [{ full_name: 'Sample User', email: 'preview@example.com' }, { title: 'Sprint Planning', meeting_code: 'ABC-1234-XYZ' }, 'Alice Manager'],
};

/**
 * In-memory cache of branding rows, keyed by `${tenantId || 'default'}:${orgId}`.
 * Cleared by the branding route on PUT so changes are visible within the
 * same process without a restart. TTL is a defensive backstop.
 */
const BRANDING_CACHE = new Map();
const BRANDING_TTL_MS = 5 * 60 * 1000; // 5 minutes

function cacheKey(tenantId, orgId) {
    return `${tenantId || 'default'}:${orgId}`;
}

/** Public: invalidate the cache for an org. Called from the branding route. */
function invalidateBrandingCache(tenantId, orgId) {
    BRANDING_CACHE.delete(cacheKey(tenantId, orgId));
}

/** Fetch branding + active template overrides for an org. Cached. */
async function loadOrgBranding(db, tenantId, orgId) {
    if (!db || !orgId) return { logo_url: null, accent_color: '#6366f1', overrides: {} };
    const key = cacheKey(tenantId, orgId);
    const cached = BRANDING_CACHE.get(key);
    if (cached && (Date.now() - cached.cachedAt) < BRANDING_TTL_MS) return cached.value;

    try {
        const branding = (await db.query(
            `SELECT logo_url, accent_color FROM org_branding WHERE org_id = $1`,
            [orgId]
        )).rows[0] || { logo_url: null, accent_color: '#6366f1' };

        const overrides = {};
        const overrideRows = (await db.query(
            `SELECT template_key, subject, body_html, enabled
               FROM org_email_templates
              WHERE org_id = $1`,
            [orgId]
        )).rows;
        for (const row of overrideRows) {
            overrides[row.template_key] = {
                subject: row.subject,
                body_html: row.body_html,
                enabled: row.enabled !== false,
            };
        }
        const value = { ...branding, overrides };
        BRANDING_CACHE.set(key, { value, cachedAt: Date.now() });
        return value;
    } catch (err) {
        // Branding tables may not exist on a freshly-bootstrapped tenant whose
        // migration hasn't run yet. Don't crash mail delivery — return the
        // built-in defaults silently.
        logger.debug({ err: err.message, orgId }, 'loadOrgBranding: falling back to defaults');
        return { logo_url: null, accent_color: '#6366f1', overrides: {} };
    }
}

/**
 * Wrap an inner template body with the org-branded HTML shell.
 * `body` may contain a literal `{{accent}}` token which is replaced with
 * the org's accent color (or the default).
 */
function applyBranding(bodyOrHtml, branding) {
    const accent = branding?.accent_color || '#6366f1';
    const body = String(bodyOrHtml || '').replace(/{{accent}}/g, accent);
    const logoBlock = branding?.logo_url
        ? `<img src="${esc(branding.logo_url)}" alt="Logo" style="max-height:40px;max-width:160px;display:block;margin:0 auto 12px;">`
        : '';
    return `<div style="font-family:-apple-system,Segoe UI,sans-serif;max-width:520px;margin:auto;padding:24px;border-top:4px solid ${esc(accent)};background:#ffffff;">
        ${logoBlock}
        ${body}
        <hr style="margin:24px 0 12px;border:none;border-top:1px solid #e5e7eb;">
        <p style="font-size:11px;color:#9ca3af;text-align:center;margin:0;">Sent by WorkPulse · do not reply</p>
    </div>`;
}

/**
 * Compute the effective {to, subject, html} for a template, merging built-in +
 * org override + branding shell. Used both at send time and by the preview
 * endpoint in the branding route.
 *
 * @returns {Promise<{to, subject, html, enabled}>}
 */
async function getEffectiveTemplate(templateName, args, opts = {}) {
    const tpl = templates[templateName];
    if (!tpl) throw new Error(`Unknown email template: ${templateName}`);
    const built = tpl(...args);
    const branding = (opts.db && opts.orgId)
        ? await loadOrgBranding(opts.db, opts.tenantId, opts.orgId)
        : { logo_url: null, accent_color: '#6366f1', overrides: {} };
    const override = branding.overrides[templateName];
    const enabled = override ? override.enabled !== false : true;
    const subject = override?.subject || built.subject;
    const innerBody = override?.body_html || built.body;
    const html = applyBranding(innerBody, branding);
    return { to: built.to, subject, html, enabled };
}

/**
 * Send a templated email. Backwards-compatible signature — most callers pass
 * just `(templateName, ...args)`. To enable per-tenant branding + overrides,
 * pass an opts object as the LAST argument: `notifyByEmail(name, ...args, { db, orgId, tenantId })`.
 *
 * Detection: if the last arg is a plain object containing a `db` key, treat
 * it as opts; otherwise treat all args as template inputs.
 */
function notifyByEmail(templateName, ...args) {
    let opts = {};
    if (args.length > 0 && args[args.length - 1] && typeof args[args.length - 1] === 'object' && 'db' in args[args.length - 1]) {
        opts = args.pop();
    }
    getEffectiveTemplate(templateName, args, opts).then(({ to, subject, html, enabled }) => {
        if (!enabled) {
            logger.debug({ templateName, to }, 'Email skipped (template disabled by org override)');
            return;
        }
        if (to) sendMail({ to, subject, html });
    }).catch(err => {
        logger.error({ err: err.message, templateName }, 'Failed to render email template');
    });
}

module.exports = {
    getTransporter,
    sendMail,
    notifyByEmail,
    // Branding/template helpers (used by routes/branding.js + preview)
    getEffectiveTemplate,
    loadOrgBranding,
    invalidateBrandingCache,
    applyBranding,
    templates,           // raw built-ins (subject + body, no shell)
    TEMPLATE_KEYS,
    TEMPLATE_PREVIEW_ARGS,
    esc,
};
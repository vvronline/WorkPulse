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
import nodemailer, { type Transporter } from "nodemailer";
import dns from "dns";
import https from "https";
import { logger } from "./logger";

interface MailContent {
    from?: string;
    to: string;
    subject: string;
    html: string;
}

interface TemplateOutput {
    to: string;
    subject: string;
    body: string;
}

interface DbLike {
    query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>;
}

interface BrandingOverride {
    subject: string;
    body_html: string;
    enabled: boolean;
}

interface Branding {
    logo_url: string | null;
    accent_color: string;
    overrides: Record<string, BrandingOverride>;
}

interface TemplateOpts {
    db?: DbLike;
    orgId?: number;
    tenantId?: number | string;
}

interface HttpsError extends Error {
    statusCode?: number;
    body?: string;
}

let transporter: Transporter | null = null;
let gmailAccessToken: { value: string | null; expiresAt: number } = { value: null, expiresAt: 0 };

/**
 * Whether the Gmail HTTPS API path is usable: requires OAuth2 creds. The Gmail
 * API talks over port 443, so it works on networks that block SMTP (465/587).
 */
function canUseGmailApi(): boolean {
    return !!(process.env.GMAIL_CLIENT_ID && process.env.GMAIL_CLIENT_SECRET &&
        process.env.GMAIL_REFRESH_TOKEN && process.env.SMTP_USER);
}

/** Minimal JSON POST over HTTPS (port 443). Resolves with parsed body. */
function httpsPostJson(
    hostname: string,
    path: string,
    headers: Record<string, string | number>,
    bodyString: string,
): Promise<any> {
    return new Promise((resolve, reject) => {
        const req = https.request({
            hostname, path, method: "POST", family: 4,
            headers: { "Content-Length": Buffer.byteLength(bodyString), ...headers },
        }, res => {
            let data = "";
            res.on("data", c => { data += c; });
            res.on("end", () => {
                let parsed: any = null;
                try { parsed = data ? JSON.parse(data) : {}; } catch { parsed = { raw: data }; }
                if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) resolve(parsed);
                else {
                    // Surface the FULL Gmail error body — the top-level message is
                    // often generic ("Bad Request"); the real cause lives in
                    // error.errors[].reason/message. Include raw body as a last resort.
                    const e = parsed && parsed.error;
                    const detail = e
                        ? `${e.message || ""}${e.errors ? " | " + e.errors.map((x: { reason?: string; message?: string }) => `${x.reason || ""}:${x.message || ""}`).join("; ") : ""}`.trim()
                        : (parsed && parsed.error_description) || data || res.statusMessage;
                    const err: HttpsError = new Error(`HTTP ${res.statusCode}: ${detail}`);
                    err.statusCode = res.statusCode;
                    err.body = data;
                    reject(err);
                }
            });
        });
        req.setTimeout(Number(process.env.SMTP_SOCKET_TIMEOUT_MS) || 20000, () => req.destroy(new Error("Gmail API request timeout")));
        req.on("error", reject);
        req.write(bodyString);
        req.end();
    });
}

/** Exchange the OAuth2 refresh token for a short-lived access token. Cached. */
async function getGmailAccessToken(): Promise<string | null> {
    if (gmailAccessToken.value && Date.now() < gmailAccessToken.expiresAt) {
        return gmailAccessToken.value;
    }
    const form = new URLSearchParams({
        client_id: process.env.GMAIL_CLIENT_ID || "",
        client_secret: process.env.GMAIL_CLIENT_SECRET || "",
        refresh_token: process.env.GMAIL_REFRESH_TOKEN || "",
        grant_type: "refresh_token",
    }).toString();
    const res = await httpsPostJson("oauth2.googleapis.com", "/token",
        { "Content-Type": "application/x-www-form-urlencoded" }, form);
    gmailAccessToken = {
        value: res.access_token,
        // Refresh 60s early to avoid edge expiry
        expiresAt: Date.now() + ((res.expires_in || 3600) - 60) * 1000,
    };
    return gmailAccessToken.value;
}

/** Build a base64url-encoded RFC 5322 message for the Gmail API. */
function buildRawMessage({ from, to, subject, html }: MailContent): string {
    // RFC 2047 encode the subject so non-ASCII (em dashes etc.) survive.
    const encSubject = `=?UTF-8?B?${Buffer.from(subject, "utf8").toString("base64")}?=`;
    const message = [
        `From: ${from}`,
        `To: ${to}`,
        `Subject: ${encSubject}`,
        "MIME-Version: 1.0",
        'Content-Type: text/html; charset="UTF-8"',
        "Content-Transfer-Encoding: base64",
        "",
        Buffer.from(html, "utf8").toString("base64"),
    ].join("\r\n");
    return Buffer.from(message, "utf8").toString("base64")
        .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Send an email via the Gmail HTTPS API (port 443). Throws on failure. */
async function sendViaGmailApi({ from, to, subject, html }: MailContent): Promise<void> {
    const accessToken = await getGmailAccessToken();
    const raw = buildRawMessage({ from, to, subject, html });
    try {
        await httpsPostJson("gmail.googleapis.com", "/gmail/v1/users/me/messages/send",
            { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
            JSON.stringify({ raw }));
    } catch (err) {
        // Log the raw Gmail response body so the exact rejection reason is visible.
        const e = err as HttpsError;
        logger.error({ statusCode: e.statusCode, body: e.body, from, to }, "Gmail API: messages.send rejected");
        throw err;
    }
}

type LookupFn = (hostname: string, options: dns.LookupOptions | ((...args: any[]) => void), callback?: (...args: any[]) => void) => void;

/**
 * Build a custom DNS lookup that forces a specific IP family (default IPv4).
 *
 * Why: many networks (this dev box, Railway, corporate/ISP networks) publish
 * an IPv6 AAAA record for smtp.gmail.com but have NO working IPv6 route, so a
 * plain connect picks the IPv6 address and fails instantly with
 * `ENETUNREACH <ipv6>:port`. nodemailer's socket-level `family` option is not
 * reliably honored because it resolves DNS through its own path, so we pin the
 * family here at the lookup layer where it is always respected.
 *
 * Pass SMTP_IP_FAMILY=6 to force IPv6, or SMTP_IP_FAMILY=0 to disable pinning
 * (let the OS choose).
 */
function makeLookup(family: number): LookupFn | undefined {
    if (!family) return undefined; // 0/undefined → use default OS resolver
    return (hostname, options, callback) => {
        // Normalize: dns.lookup may be called as (host, cb) or (host, opts, cb)
        if (typeof options === "function") { callback = options; options = {}; }
        dns.lookup(hostname, { ...(options as dns.LookupOptions), family }, callback as (...args: any[]) => void);
    };
}

function getTransporter(): Transporter | null {
    if (transporter) return transporter;

    // When the Gmail HTTPS API is the chosen transport, skip building an SMTP
    // transport entirely — otherwise the startup verify() pointlessly attempts
    // a blocked SMTP port and logs a misleading "verification FAILED" error.
    if ((process.env.EMAIL_TRANSPORT || "").toLowerCase() === "gmail-api") {
        return null;
    }

    // Fail fast instead of waiting for the OS-level TCP timeout. Many hosts
    // (Railway, corporate networks, some ISPs) block outbound :465; with these
    // timeouts a blocked port surfaces in ~10s rather than ~2min.
    const TIMEOUTS: Record<string, number> = {
        connectionTimeout: Number(process.env.SMTP_CONN_TIMEOUT_MS) || 10000,
        greetingTimeout: Number(process.env.SMTP_GREETING_TIMEOUT_MS) || 10000,
        socketTimeout: Number(process.env.SMTP_SOCKET_TIMEOUT_MS) || 20000,
    };

    // Force IPv4 DNS resolution by default. Many hosts (this dev box, Railway,
    // corporate/ISP networks) advertise an IPv6 AAAA record for smtp.gmail.com
    // but have no working IPv6 route, so Node picks the IPv6 address and the
    // connect() fails with `ENETUNREACH <ipv6>:port`. We pin the family at the
    // DNS lookup layer (a socket-level `family` option is NOT reliably honored
    // by nodemailer). Set SMTP_IP_FAMILY=6 or 0 to override.
    const family = process.env.SMTP_IP_FAMILY != null ? Number(process.env.SMTP_IP_FAMILY) : 4;
    const lookup = makeLookup(family);
    if (lookup) TIMEOUTS.dnsTimeout = Number(process.env.SMTP_DNS_TIMEOUT_MS) || 10000;

    // ── Mode 1: Gmail OAuth2 ────────────────────────────────────────
    if (process.env.GMAIL_CLIENT_ID && process.env.GMAIL_CLIENT_SECRET && process.env.GMAIL_REFRESH_TOKEN) {
        // Default to 587 (STARTTLS) — port 465 (SMTPS) is blocked on many
        // networks/ISPs and surfaces as a connection timeout. Set SMTP_PORT=465
        // explicitly if your environment permits implicit TLS.
        const port = Number(process.env.SMTP_PORT) || 587;
        transporter = nodemailer.createTransport({
            host: process.env.SMTP_HOST || "smtp.gmail.com",
            port,
            secure: port === 465, // 465 = implicit TLS; 587 = STARTTLS
            ...(lookup ? { lookup } : {}),
            auth: {
                type: "OAuth2",
                user: process.env.SMTP_USER,
                clientId: process.env.GMAIL_CLIENT_ID,
                clientSecret: process.env.GMAIL_CLIENT_SECRET,
                refreshToken: process.env.GMAIL_REFRESH_TOKEN,
            },
            ...TIMEOUTS,
        } as nodemailer.TransportOptions);
        // Verify connection at startup so OAuth errors surface early
        transporter.verify().then(() => {
            logger.info({ port }, "Email transport: Gmail OAuth2 — verified");
        }).catch((err: Error) => {
            const hint = /ETIMEDOUT|ECONNREFUSED|ESOCKET/.test(err.message)
                ? " — network appears to block this port; try SMTP_PORT=587"
                : " (check refresh token / credentials)";
            logger.error({ err: err.message, port }, `Email transport: Gmail OAuth2 — verification FAILED${hint}`);
            transporter = null;
        });
        return transporter;
    }

    // ── Mode 2: Plain SMTP (app-password) ───────────────────────────
    if (process.env.SMTP_USER && process.env.SMTP_PASS) {
        const port = Number(process.env.SMTP_PORT) || 587;
        transporter = nodemailer.createTransport({
            host: process.env.SMTP_HOST || "smtp.gmail.com",
            port,
            secure: port === 465,
            ...(lookup ? { lookup } : {}),
            auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
            ...TIMEOUTS,
        } as nodemailer.TransportOptions);
        logger.info({ port }, "Email transport: SMTP (password)");
        return transporter;
    }

    return null;
}

const FROM = (): string => process.env.SMTP_FROM || (process.env.SMTP_USER ? `"WorkPulse" <${process.env.SMTP_USER}>` : '"WorkPulse" <noreply@workpulse.app>');

/** Escape user-controlled strings before embedding in HTML email templates. */
function esc(str: unknown): string {
    if (str == null) return "";
    return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 3000;

/**
 * Send an email with automatic retry. Never throws.
 */
/** True for errors that indicate the SMTP port/host is unreachable. */
function isConnError(err: { code?: string; message?: string } | null | undefined): boolean {
    return /ETIMEDOUT|ECONNREFUSED|ESOCKET|ENETUNREACH|EHOSTUNREACH|ECONNRESET|timeout/i.test((err && (err.code || err.message)) || "");
}

function sendMail({ to, subject, html }: MailContent): Promise<boolean> {
    if (!to || !to.includes("@")) {
        logger.warn({ to, subject }, "Email skipped — invalid recipient");
        return Promise.resolve(false);
    }

    // EMAIL_TRANSPORT=gmail-api forces the HTTPS API path (use when the network
    // blocks SMTP ports 465/587, which is common on corporate/VPN networks).
    const forceApi = (process.env.EMAIL_TRANSPORT || "").toLowerCase() === "gmail-api";
    if (forceApi && canUseGmailApi()) {
        return sendViaGmailApi({ from: FROM(), to, subject, html })
            .then(() => { logger.info({ to, subject }, "Email sent successfully (Gmail API)"); return true; })
            .catch((err: Error) => { logger.error({ err: err.message, to, subject }, "Gmail API send failed"); return false; });
    }

    const mailer = getTransporter();
    if (!mailer) {
        // No SMTP transport — try the HTTPS API if creds allow it.
        if (canUseGmailApi()) {
            return sendViaGmailApi({ from: FROM(), to, subject, html })
                .then(() => { logger.info({ to, subject }, "Email sent successfully (Gmail API)"); return true; })
                .catch((err: Error) => { logger.error({ err: err.message, to, subject }, "Gmail API send failed"); return false; });
        }
        logger.debug({ to, subject }, "Email skipped (SMTP not configured)");
        return Promise.resolve(false);
    }

    let attempt = 0;
    return new Promise((resolve) => {
        const trySend = () => {
            attempt++;
            mailer.sendMail({ from: FROM(), to, subject, html }).then(() => {
                logger.info({ to, subject }, "Email sent successfully");
                resolve(true);
            }).catch((err: Error) => {
                // If SMTP is unreachable (blocked port), fall back to the Gmail
                // HTTPS API which uses port 443 — no point retrying SMTP.
                if (isConnError(err) && canUseGmailApi()) {
                    logger.warn({ err: err.message, to, subject }, "SMTP unreachable — falling back to Gmail API");
                    sendViaGmailApi({ from: FROM(), to, subject, html })
                        .then(() => { logger.info({ to, subject }, "Email sent successfully (Gmail API)"); resolve(true); })
                        .catch((apiErr: Error) => { logger.error({ err: apiErr.message, to, subject }, "Gmail API fallback failed"); resolve(false); });
                    return;
                }
                if (attempt <= MAX_RETRIES) {
                    logger.warn({ err: err.message, to, subject, attempt }, "Email send failed — retrying");
                    setTimeout(trySend, RETRY_DELAY_MS * attempt);
                } else {
                    logger.error({ err, to, subject, attempts: attempt }, "Failed to send email after retries");
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
    "leaveApproved", "leaveRejected", "leaveRevoked",
    "taskAssigned", "mention",
    "manualEntryApproved", "manualEntryRejected",
    "meetingScheduled", "meetingUpdated", "meetingCancelled",
];

type TemplateFn = (...args: any[]) => TemplateOutput;

const templates: Record<string, TemplateFn> = {
    leaveApproved: (user, leave) => ({
        to: user.email,
        subject: "WorkPulse — Leave Approved",
        body: `<h2 style="color:#22c55e;margin:0 0 12px;">Leave Approved ✅</h2>
            <p>Hi <strong>${esc(user.full_name)}</strong>,</p>
            <p>Your <strong>${esc(leave.leave_type)}</strong> leave on <strong>${esc(leave.date)}</strong> has been approved.</p>`,
    }),
    leaveRejected: (user, leave, reason) => ({
        to: user.email,
        subject: "WorkPulse — Leave Rejected",
        body: `<h2 style="color:#ef4444;margin:0 0 12px;">Leave Rejected</h2>
            <p>Hi <strong>${esc(user.full_name)}</strong>,</p>
            <p>Your <strong>${esc(leave.leave_type)}</strong> leave on <strong>${esc(leave.date)}</strong> has been rejected.</p>
            ${reason ? `<p><em>Reason: ${esc(reason)}</em></p>` : ""}`,
    }),
    leaveRevoked: (user, leave) => ({
        to: user.email,
        subject: "WorkPulse — Leave Revoked",
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
            ${task.due_date ? `<p>Due: ${esc(task.due_date)}</p>` : ""}`,
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
        subject: "WorkPulse — Manual Entry Approved",
        body: `<h2 style="color:#22c55e;margin:0 0 12px;">Manual Entry Approved ✅</h2>
            <p>Hi <strong>${esc(user.full_name)}</strong>,</p>
            <p>Your manual time entry for <strong>${esc(date)}</strong> has been approved.</p>`,
    }),
    manualEntryRejected: (user, date, reason) => ({
        to: user.email,
        subject: "WorkPulse — Manual Entry Rejected",
        body: `<h2 style="color:#ef4444;margin:0 0 12px;">Manual Entry Rejected</h2>
            <p>Hi <strong>${esc(user.full_name)}</strong>,</p>
            <p>Your manual time entry for <strong>${esc(date)}</strong> has been rejected.</p>
            ${reason ? `<p><em>Reason: ${esc(reason)}</em></p>` : ""}`,
    }),
    meetingScheduled: (user, meeting, organizerName) => ({
        to: user.email,
        subject: `WorkPulse — Meeting Scheduled: ${esc(meeting.title)}`,
        body: `<h2 style="color:{{accent}};margin:0 0 12px;">📹 Meeting Scheduled</h2>
            <p>Hi <strong>${esc(user.full_name)}</strong>,</p>
            <p><strong>${esc(organizerName)}</strong> has scheduled a meeting:</p>
            <p style="background:#f3f4f6;padding:12px;border-radius:8px;"><strong>${esc(meeting.title)}</strong></p>
            ${meeting.start_time ? `<p>Start: <strong>${esc(new Date(meeting.start_time).toLocaleString())}</strong></p>` : ""}
            ${meeting.end_time ? `<p>End: <strong>${esc(new Date(meeting.end_time).toLocaleString())}</strong></p>` : ""}
            ${meeting.meeting_code ? `<p>Meeting code: <strong>${esc(meeting.meeting_code)}</strong></p>` : ""}`,
    }),
    meetingUpdated: (user, meeting, organizerName) => ({
        to: user.email,
        subject: `WorkPulse — Meeting Updated: ${esc(meeting.title)}`,
        body: `<h2 style="color:#f59e0b;margin:0 0 12px;">📹 Meeting Updated</h2>
            <p>Hi <strong>${esc(user.full_name)}</strong>,</p>
            <p><strong>${esc(organizerName)}</strong> has updated the meeting:</p>
            <p style="background:#f3f4f6;padding:12px;border-radius:8px;"><strong>${esc(meeting.title)}</strong></p>
            ${meeting.meeting_code ? `<p>Meeting code: <strong>${esc(meeting.meeting_code)}</strong></p>` : ""}`,
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
const TEMPLATE_PREVIEW_ARGS: Record<string, () => unknown[]> = {
    leaveApproved: () => [{ full_name: "Sample User", email: "preview@example.com" }, { leave_type: "Annual", date: "2025-12-25" }],
    leaveRejected: () => [{ full_name: "Sample User", email: "preview@example.com" }, { leave_type: "Sick", date: "2025-11-10" }, "Project deadline this week"],
    leaveRevoked: () => [{ full_name: "Sample User", email: "preview@example.com" }, { leave_type: "Personal", date: "2025-09-05" }],
    taskAssigned: () => [{ full_name: "Sample User", email: "preview@example.com" }, { title: "Implement login screen", due_date: "2025-08-20" }, "Alice Manager"],
    mention: () => [{ full_name: "Sample User", email: "preview@example.com" }, "Bob Reviewer", "Implement login screen"],
    manualEntryApproved: () => [{ full_name: "Sample User", email: "preview@example.com" }, "2025-08-15"],
    manualEntryRejected: () => [{ full_name: "Sample User", email: "preview@example.com" }, "2025-08-15", "Please attach a justification"],
    meetingScheduled: () => [{ full_name: "Sample User", email: "preview@example.com" }, { title: "Sprint Planning", start_time: new Date(Date.now() + 86400000).toISOString(), end_time: new Date(Date.now() + 90000000).toISOString(), meeting_code: "ABC-1234-XYZ" }, "Alice Manager"],
    meetingUpdated: () => [{ full_name: "Sample User", email: "preview@example.com" }, { title: "Sprint Planning", meeting_code: "ABC-1234-XYZ" }, "Alice Manager"],
    meetingCancelled: () => [{ full_name: "Sample User", email: "preview@example.com" }, { title: "Sprint Planning", meeting_code: "ABC-1234-XYZ" }, "Alice Manager"],
};

/**
 * In-memory cache of branding rows, keyed by `${tenantId || 'default'}:${orgId}`.
 * Cleared by the branding route on PUT so changes are visible within the
 * same process without a restart. TTL is a defensive backstop.
 */
const BRANDING_CACHE = new Map<string, { value: Branding; cachedAt: number }>();
const BRANDING_TTL_MS = 5 * 60 * 1000; // 5 minutes

function cacheKey(tenantId: number | string | undefined, orgId: number | undefined): string {
    return `${tenantId || "default"}:${orgId}`;
}

/** Public: invalidate the cache for an org. Called from the branding route. */
function invalidateBrandingCache(tenantId: number | string | undefined, orgId: number | undefined): void {
    BRANDING_CACHE.delete(cacheKey(tenantId, orgId));
}

/** Fetch branding + active template overrides for an org. Cached. */
async function loadOrgBranding(db: DbLike | undefined, tenantId: number | string | undefined, orgId: number | undefined): Promise<Branding> {
    if (!db || !orgId) return { logo_url: null, accent_color: "#6366f1", overrides: {} };
    const key = cacheKey(tenantId, orgId);
    const cached = BRANDING_CACHE.get(key);
    if (cached && (Date.now() - cached.cachedAt) < BRANDING_TTL_MS) return cached.value;

    try {
        const branding = (await db.query(
            `SELECT logo_url, accent_color FROM org_branding WHERE org_id = $1`,
            [orgId]
        )).rows[0] || { logo_url: null, accent_color: "#6366f1" };

        const overrides: Record<string, BrandingOverride> = {};
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
        const value: Branding = { ...branding, overrides };
        BRANDING_CACHE.set(key, { value, cachedAt: Date.now() });
        return value;
    } catch (err) {
        // Branding tables may not exist on a freshly-bootstrapped tenant whose
        // migration hasn't run yet. Don't crash mail delivery — return the
        // built-in defaults silently.
        logger.debug({ err: (err as Error).message, orgId }, "loadOrgBranding: falling back to defaults");
        return { logo_url: null, accent_color: "#6366f1", overrides: {} };
    }
}

/**
 * Wrap an inner template body with the org-branded HTML shell.
 * `body` may contain a literal `{{accent}}` token which is replaced with
 * the org's accent color (or the default).
 */
function applyBranding(bodyOrHtml: string, branding: Branding | null | undefined): string {
    const accent = branding?.accent_color || "#6366f1";
    const body = String(bodyOrHtml || "").replace(/{{accent}}/g, accent);
    const logoBlock = branding?.logo_url
        ? `<img src="${esc(branding.logo_url)}" alt="Logo" style="max-height:40px;max-width:160px;display:block;margin:0 auto 12px;">`
        : "";
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
 */
async function getEffectiveTemplate(
    templateName: string,
    args: unknown[],
    opts: TemplateOpts = {},
): Promise<{ to: string; subject: string; html: string; enabled: boolean }> {
    const tpl = templates[templateName];
    if (!tpl) throw new Error(`Unknown email template: ${templateName}`);
    const built = tpl(...args);
    const branding: Branding = (opts.db && opts.orgId)
        ? await loadOrgBranding(opts.db, opts.tenantId, opts.orgId)
        : { logo_url: null, accent_color: "#6366f1", overrides: {} };
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
function notifyByEmail(templateName: string, ...args: unknown[]): void {
    let opts: TemplateOpts = {};
    const last = args[args.length - 1];
    if (args.length > 0 && last && typeof last === "object" && "db" in last) {
        opts = args.pop() as TemplateOpts;
    }
    getEffectiveTemplate(templateName, args, opts).then(({ to, subject, html, enabled }) => {
        if (!enabled) {
            logger.debug({ templateName, to }, "Email skipped (template disabled by org override)");
            return;
        }
        if (to) sendMail({ to, subject, html });
    }).catch((err: Error) => {
        logger.error({ err: err.message, templateName }, "Failed to render email template");
    });
}

export {
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
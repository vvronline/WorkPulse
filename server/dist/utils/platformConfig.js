"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULTS = exports.PLATFORM_KEYS = void 0;
exports.getPlatformConfig = getPlatformConfig;
exports.updatePlatformConfig = updatePlatformConfig;
exports.isMaintenanceMode = isMaintenanceMode;
exports.getMaintenanceMessage = getMaintenanceMessage;
exports.getPasswordPolicy = getPasswordPolicy;
exports.getAllowedEmailDomains = getAllowedEmailDomains;
exports.getSessionTimeout = getSessionTimeout;
exports.getRetentionPolicy = getRetentionPolicy;
const db_1 = require("../db");
/**
 * Platform-wide configuration keys persisted in the master `app_settings` table.
 *
 * NOTE on SMTP / Branding:
 *   Earlier revisions exposed `smtp_*` and `brand_*` keys here so a platform
 *   admin could configure outbound email + a global look-and-feel from the
 *   platform admin panel. That feature was removed — those concerns are now
 *   handled entirely per-tenant:
 *     • Tenant branding (logo, accent color, email templates) → `org_branding`
 *       + `org_email_templates` tables + `routes/branding.js`.
 *     • Outbound email transport → `process.env.SMTP_*` / `GMAIL_*`, consumed
 *       by `server/utils/mailer.js`.
 *   The matching rows in `app_settings` are also deleted on every startup by
 *   `initMasterDB()` so the platform admin UI never re-surfaces stale values.
 */
const PLATFORM_KEYS = [
    "maintenance_mode",
    "maintenance_message",
    "session_timeout_minutes",
    "password_min_length",
    "password_require_uppercase",
    "password_require_number",
    "password_require_special",
    "allowed_email_domains",
    "audit_log_retention_days",
    "deleted_tenant_cleanup_days",
    "session_log_retention_days",
];
exports.PLATFORM_KEYS = PLATFORM_KEYS;
const DEFAULTS = {
    maintenance_mode: "false",
    maintenance_message: "",
    session_timeout_minutes: "480",
    password_min_length: "8",
    password_require_uppercase: "true",
    password_require_number: "true",
    password_require_special: "false",
    allowed_email_domains: "",
    audit_log_retention_days: "365",
    deleted_tenant_cleanup_days: "90",
    session_log_retention_days: "90",
};
exports.DEFAULTS = DEFAULTS;
function parseBool(v, dflt) {
    if (v == null)
        return dflt;
    return v === "true" || v === "1";
}
function parseInt10(v, dflt) {
    const n = parseInt(String(v), 10);
    return Number.isFinite(n) && n > 0 ? n : dflt;
}
async function getPlatformConfig() {
    const res = await (0, db_1.masterQuery)(`SELECT key, value FROM app_settings WHERE key = ANY($1::text[])`, [PLATFORM_KEYS]);
    const map = {};
    for (const r of res.rows)
        map[r.key] = r.value;
    const config = {};
    for (const key of PLATFORM_KEYS) {
        config[key] = map[key] ?? DEFAULTS[key] ?? "";
    }
    return config;
}
async function updatePlatformConfig(patch) {
    const allowedSet = new Set(PLATFORM_KEYS);
    const updated = {};
    for (const [key, val] of Object.entries(patch)) {
        if (!allowedSet.has(key))
            continue;
        await (0, db_1.masterQuery)(`INSERT INTO app_settings (key, value) VALUES ($1, $2)
             ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`, [key, String(val)]);
        updated[key] = String(val);
    }
    return updated;
}
async function isMaintenanceMode() {
    const res = await (0, db_1.masterQuery)(`SELECT value FROM app_settings WHERE key = 'maintenance_mode'`);
    return res.rows[0]?.value === "true";
}
async function getMaintenanceMessage() {
    const res = await (0, db_1.masterQuery)(`SELECT value FROM app_settings WHERE key = 'maintenance_message'`);
    return res.rows[0]?.value || "The system is currently under maintenance. Please try again later.";
}
async function getPasswordPolicy() {
    const res = await (0, db_1.masterQuery)(`SELECT key, value FROM app_settings WHERE key = ANY($1::text[])`, [["password_min_length", "password_require_uppercase", "password_require_number", "password_require_special"]]);
    const map = {};
    for (const r of res.rows)
        map[r.key] = r.value;
    return {
        minLength: parseInt10(map.password_min_length, 8),
        requireUppercase: parseBool(map.password_require_uppercase, true),
        requireNumber: parseBool(map.password_require_number, true),
        requireSpecial: parseBool(map.password_require_special, false),
    };
}
async function getAllowedEmailDomains() {
    const res = await (0, db_1.masterQuery)(`SELECT value FROM app_settings WHERE key = 'allowed_email_domains'`);
    const raw = res.rows[0]?.value || "";
    if (!raw.trim())
        return [];
    return raw.split(",").map((d) => d.trim().toLowerCase()).filter(Boolean);
}
async function getSessionTimeout() {
    const res = await (0, db_1.masterQuery)(`SELECT value FROM app_settings WHERE key = 'session_timeout_minutes'`);
    return parseInt10(res.rows[0]?.value, 480);
}
async function getRetentionPolicy() {
    const res = await (0, db_1.masterQuery)(`SELECT key, value FROM app_settings WHERE key = ANY($1::text[])`, [["audit_log_retention_days", "deleted_tenant_cleanup_days", "session_log_retention_days"]]);
    const map = {};
    for (const r of res.rows)
        map[r.key] = r.value;
    return {
        auditLogRetentionDays: parseInt10(map.audit_log_retention_days, 365),
        deletedTenantCleanupDays: parseInt10(map.deleted_tenant_cleanup_days, 90),
        sessionLogRetentionDays: parseInt10(map.session_log_retention_days, 90),
    };
}
//# sourceMappingURL=platformConfig.js.map
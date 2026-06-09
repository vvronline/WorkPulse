import { masterQuery } from "../db";
import { logger } from "./logger";

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

const DEFAULTS: Record<string, string> = {
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

function parseBool(v: string | null | undefined, dflt: boolean): boolean {
    if (v == null) return dflt;
    return v === "true" || v === "1";
}

function parseInt10(v: string | null | undefined, dflt: number): number {
    const n = parseInt(String(v), 10);
    return Number.isFinite(n) && n > 0 ? n : dflt;
}

interface PasswordPolicy {
    minLength: number;
    requireUppercase: boolean;
    requireNumber: boolean;
    requireSpecial: boolean;
}

interface RetentionPolicy {
    auditLogRetentionDays: number;
    deletedTenantCleanupDays: number;
    sessionLogRetentionDays: number;
}

interface SettingRow {
    key: string;
    value: string;
}

async function getPlatformConfig(): Promise<Record<string, string>> {
    const res = await masterQuery(
        `SELECT key, value FROM app_settings WHERE key = ANY($1::text[])`,
        [PLATFORM_KEYS],
    );
    const map: Record<string, string> = {};
    for (const r of res.rows as SettingRow[]) map[r.key] = r.value;

    const config: Record<string, string> = {};
    for (const key of PLATFORM_KEYS) {
        config[key] = map[key] ?? DEFAULTS[key] ?? "";
    }
    return config;
}

async function updatePlatformConfig(patch: Record<string, unknown>): Promise<Record<string, string>> {
    const allowedSet = new Set(PLATFORM_KEYS);
    const updated: Record<string, string> = {};
    for (const [key, val] of Object.entries(patch)) {
        if (!allowedSet.has(key)) continue;
        await masterQuery(
            `INSERT INTO app_settings (key, value) VALUES ($1, $2)
             ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
            [key, String(val)],
        );
        updated[key] = String(val);
    }
    return updated;
}

async function isMaintenanceMode(): Promise<boolean> {
    const res = await masterQuery(
        `SELECT value FROM app_settings WHERE key = 'maintenance_mode'`,
    );
    return res.rows[0]?.value === "true";
}

async function getMaintenanceMessage(): Promise<string> {
    const res = await masterQuery(
        `SELECT value FROM app_settings WHERE key = 'maintenance_message'`,
    );
    return res.rows[0]?.value || "The system is currently under maintenance. Please try again later.";
}

async function getPasswordPolicy(): Promise<PasswordPolicy> {
    const res = await masterQuery(
        `SELECT key, value FROM app_settings WHERE key = ANY($1::text[])`,
        [["password_min_length", "password_require_uppercase", "password_require_number", "password_require_special"]],
    );
    const map: Record<string, string> = {};
    for (const r of res.rows as SettingRow[]) map[r.key] = r.value;

    return {
        minLength: parseInt10(map.password_min_length, 8),
        requireUppercase: parseBool(map.password_require_uppercase, true),
        requireNumber: parseBool(map.password_require_number, true),
        requireSpecial: parseBool(map.password_require_special, false),
    };
}

async function getAllowedEmailDomains(): Promise<string[]> {
    const res = await masterQuery(
        `SELECT value FROM app_settings WHERE key = 'allowed_email_domains'`,
    );
    const raw = res.rows[0]?.value || "";
    if (!raw.trim()) return [];
    return raw.split(",").map((d: string) => d.trim().toLowerCase()).filter(Boolean);
}

async function getSessionTimeout(): Promise<number> {
    const res = await masterQuery(
        `SELECT value FROM app_settings WHERE key = 'session_timeout_minutes'`,
    );
    return parseInt10(res.rows[0]?.value, 480);
}

async function getRetentionPolicy(): Promise<RetentionPolicy> {
    const res = await masterQuery(
        `SELECT key, value FROM app_settings WHERE key = ANY($1::text[])`,
        [["audit_log_retention_days", "deleted_tenant_cleanup_days", "session_log_retention_days"]],
    );
    const map: Record<string, string> = {};
    for (const r of res.rows as SettingRow[]) map[r.key] = r.value;
    return {
        auditLogRetentionDays: parseInt10(map.audit_log_retention_days, 365),
        deletedTenantCleanupDays: parseInt10(map.deleted_tenant_cleanup_days, 90),
        sessionLogRetentionDays: parseInt10(map.session_log_retention_days, 90),
    };
}

export {
    getPlatformConfig,
    updatePlatformConfig,
    isMaintenanceMode,
    getMaintenanceMessage,
    getPasswordPolicy,
    getAllowedEmailDomains,
    getSessionTimeout,
    getRetentionPolicy,
    PLATFORM_KEYS,
    DEFAULTS,
};
const { masterQuery } = require('../db');
const { logger } = require('./logger');

const PLATFORM_KEYS = [
    'maintenance_mode',
    'maintenance_message',
    'session_timeout_minutes',
    'password_min_length',
    'password_require_uppercase',
    'password_require_number',
    'password_require_special',
    'allowed_email_domains',
    'smtp_host',
    'smtp_port',
    'smtp_user',
    'smtp_pass',
    'smtp_from_address',
    'smtp_from_name',
    'smtp_secure',
    'brand_name',
    'brand_primary_color',
    'brand_logo_url',
    'brand_favicon_url',
    'audit_log_retention_days',
    'deleted_tenant_cleanup_days',
    'session_log_retention_days',
];

const SENSITIVE_KEYS = new Set(['smtp_pass']);
const MASKED_VALUE = '••••••••';

const DEFAULTS = {
    maintenance_mode: 'false',
    maintenance_message: '',
    session_timeout_minutes: '480',
    password_min_length: '8',
    password_require_uppercase: 'true',
    password_require_number: 'true',
    password_require_special: 'false',
    allowed_email_domains: '',
    smtp_host: '',
    smtp_port: '587',
    smtp_user: '',
    smtp_pass: '',
    smtp_from_address: '',
    smtp_from_name: '',
    smtp_secure: 'true',
    brand_name: 'WorkPulse',
    brand_primary_color: '#6366f1',
    brand_logo_url: '',
    brand_favicon_url: '',
    audit_log_retention_days: '365',
    deleted_tenant_cleanup_days: '90',
    session_log_retention_days: '90',
};

function parseBool(v, dflt) {
    if (v == null) return dflt;
    return v === 'true' || v === '1';
}

function parseInt10(v, dflt) {
    const n = parseInt(v, 10);
    return Number.isFinite(n) && n > 0 ? n : dflt;
}

async function getPlatformConfig({ maskSensitive = true } = {}) {
    const res = await masterQuery(
        `SELECT key, value FROM app_settings WHERE key = ANY($1::text[])`,
        [PLATFORM_KEYS],
    );
    const map = {};
    for (const r of res.rows) map[r.key] = r.value;

    const config = {};
    for (const key of PLATFORM_KEYS) {
        let value = map[key] ?? DEFAULTS[key] ?? '';
        if (maskSensitive && SENSITIVE_KEYS.has(key) && value) {
            value = MASKED_VALUE;
        }
        config[key] = value;
    }
    return config;
}

async function updatePlatformConfig(patch) {
    const allowedSet = new Set(PLATFORM_KEYS);
    const updated = {};
    for (const [key, val] of Object.entries(patch)) {
        if (!allowedSet.has(key)) continue;
        if (SENSITIVE_KEYS.has(key) && val === MASKED_VALUE) continue;
        await masterQuery(
            `INSERT INTO app_settings (key, value) VALUES ($1, $2)
             ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
            [key, String(val)],
        );
        updated[key] = SENSITIVE_KEYS.has(key) ? MASKED_VALUE : String(val);
    }
    return updated;
}

async function isMaintenanceMode() {
    const res = await masterQuery(
        `SELECT value FROM app_settings WHERE key = 'maintenance_mode'`,
    );
    return res.rows[0]?.value === 'true';
}

async function getMaintenanceMessage() {
    const res = await masterQuery(
        `SELECT value FROM app_settings WHERE key = 'maintenance_message'`,
    );
    return res.rows[0]?.value || 'The system is currently under maintenance. Please try again later.';
}

async function getPasswordPolicy() {
    const res = await masterQuery(
        `SELECT key, value FROM app_settings WHERE key = ANY($1::text[])`,
        [['password_min_length', 'password_require_uppercase', 'password_require_number', 'password_require_special']],
    );
    const map = {};
    for (const r of res.rows) map[r.key] = r.value;

    return {
        minLength: parseInt10(map.password_min_length, 8),
        requireUppercase: parseBool(map.password_require_uppercase, true),
        requireNumber: parseBool(map.password_require_number, true),
        requireSpecial: parseBool(map.password_require_special, false),
    };
}

async function getAllowedEmailDomains() {
    const res = await masterQuery(
        `SELECT value FROM app_settings WHERE key = 'allowed_email_domains'`,
    );
    const raw = res.rows[0]?.value || '';
    if (!raw.trim()) return [];
    return raw.split(',').map(d => d.trim().toLowerCase()).filter(Boolean);
}

async function getSessionTimeout() {
    const res = await masterQuery(
        `SELECT value FROM app_settings WHERE key = 'session_timeout_minutes'`,
    );
    return parseInt10(res.rows[0]?.value, 480);
}

async function getSmtpConfig() {
    const res = await masterQuery(
        `SELECT key, value FROM app_settings WHERE key = ANY($1::text[])`,
        [['smtp_host', 'smtp_port', 'smtp_user', 'smtp_pass', 'smtp_from_address', 'smtp_from_name', 'smtp_secure']],
    );
    const map = {};
    for (const r of res.rows) map[r.key] = r.value;
    return {
        host: map.smtp_host || process.env.SMTP_HOST || '',
        port: parseInt10(map.smtp_port, 587),
        user: map.smtp_user || process.env.SMTP_USER || '',
        pass: map.smtp_pass || process.env.SMTP_PASS || '',
        fromAddress: map.smtp_from_address || process.env.SMTP_FROM || '',
        fromName: map.smtp_from_name || process.env.SMTP_FROM_NAME || 'WorkPulse',
        secure: parseBool(map.smtp_secure, true),
    };
}

async function getBrandingConfig() {
    const res = await masterQuery(
        `SELECT key, value FROM app_settings WHERE key = ANY($1::text[])`,
        [['brand_name', 'brand_primary_color', 'brand_logo_url', 'brand_favicon_url']],
    );
    const map = {};
    for (const r of res.rows) map[r.key] = r.value;
    return {
        name: map.brand_name || DEFAULTS.brand_name,
        primaryColor: map.brand_primary_color || DEFAULTS.brand_primary_color,
        logoUrl: map.brand_logo_url || '',
        faviconUrl: map.brand_favicon_url || '',
    };
}

async function getRetentionPolicy() {
    const res = await masterQuery(
        `SELECT key, value FROM app_settings WHERE key = ANY($1::text[])`,
        [['audit_log_retention_days', 'deleted_tenant_cleanup_days', 'session_log_retention_days']],
    );
    const map = {};
    for (const r of res.rows) map[r.key] = r.value;
    return {
        auditLogRetentionDays: parseInt10(map.audit_log_retention_days, 365),
        deletedTenantCleanupDays: parseInt10(map.deleted_tenant_cleanup_days, 90),
        sessionLogRetentionDays: parseInt10(map.session_log_retention_days, 90),
    };
}

module.exports = {
    getPlatformConfig,
    updatePlatformConfig,
    isMaintenanceMode,
    getMaintenanceMessage,
    getPasswordPolicy,
    getAllowedEmailDomains,
    getSessionTimeout,
    getSmtpConfig,
    getBrandingConfig,
    getRetentionPolicy,
    PLATFORM_KEYS,
    DEFAULTS,
};

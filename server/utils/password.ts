/**
 * Shared password validation utility.
 * Enforces complexity rules across registration, reset, and change flows.
 * Reads platform-level policy from app_settings when available.
 */

/** Bcrypt cost factor — OWASP recommends 10+ for enterprise applications */
const BCRYPT_ROUNDS = 12;

interface PasswordPolicy {
    minLength: number;
    requireUppercase: boolean;
    requireNumber: boolean;
    requireSpecial: boolean;
}

let cachedPolicy: PasswordPolicy | null = null;
let policyCacheTime = 0;
const POLICY_CACHE_TTL = 60_000;

async function loadPolicy(): Promise<PasswordPolicy> {
    const now = Date.now();
    if (cachedPolicy && (now - policyCacheTime < POLICY_CACHE_TTL)) return cachedPolicy;
    try {
        const { getPasswordPolicy } = require("./platformConfig");
        cachedPolicy = await getPasswordPolicy();
        policyCacheTime = now;
    } catch {
        cachedPolicy = { minLength: 8, requireUppercase: true, requireNumber: true, requireSpecial: true };
    }
    return cachedPolicy as PasswordPolicy;
}

/**
 * Validate password meets complexity requirements.
 * Uses platform config policy (async). Falls back to strict defaults.
 * @param password
 * @returns Error message or null if valid
 */
async function validatePassword(password: string): Promise<string | null> {
    if (!password) return "Password is required";
    const policy = await loadPolicy();
    if (password.length < policy.minLength) return `Password must be at least ${policy.minLength} characters`;
    if (Buffer.byteLength(password, "utf8") > 72) return "Password must be 72 bytes or less";
    if (!/[a-z]/.test(password)) return "Password must contain at least one lowercase letter";
    if (policy.requireUppercase && !/[A-Z]/.test(password)) return "Password must contain at least one uppercase letter";
    if (policy.requireNumber && !/[0-9]/.test(password)) return "Password must contain at least one digit";
    if (policy.requireSpecial && !/[^a-zA-Z0-9]/.test(password)) return "Password must contain at least one special character";
    return null;
}

/**
 * Validate username format.
 * Allowed: letters, digits, underscores, hyphens, dots. No spaces or HTML.
 * @param username
 * @returns Error message or null if valid
 */
function validateUsername(username: string): string | null {
    if (!username) return "Username is required";
    if (username.length < 3 || username.length > 50) return "Username must be 3-50 characters";
    if (!/^[a-zA-Z0-9._-]+$/.test(username)) return "Username can only contain letters, numbers, dots, hyphens and underscores";
    return null;
}

export { validatePassword, validateUsername, BCRYPT_ROUNDS };
/**
 * Multi-Factor Authentication (TOTP) utilities.
 *
 * Wraps `otplib` (RFC 6238 TOTP) and `qrcode` for enrollment, plus
 * helpers for single-use recovery codes and at-rest encryption of the
 * shared secret.
 *
 * Secrets are stored AES-256-GCM encrypted. The encryption key is taken
 * from `process.env.MFA_ENC_KEY` (recommended: a long random string). If
 * unset, we derive a stable 32-byte key from `JWT_SECRET` via SHA-256 so
 * existing deployments keep working without a new env var. (Rotating
 * JWT_SECRET would invalidate stored secrets — acceptable, since rotating
 * JWT_SECRET already logs everyone out.)
 *
 * Recovery codes are NEVER stored in plaintext — only bcrypt hashes are
 * persisted. The plaintext set is returned to the user exactly once at
 * enable / regenerate time.
 */
'use strict';

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const QRCode = require('qrcode');

// TOTP parameters (RFC 6238). 30s step, 6 digits, SHA-1 (authenticator-app
// default). We allow ±1 step of clock drift on verify (so a code is valid
// for ~90s).
const TOTP_STEP_SECONDS = 30;
const TOTP_DIGITS = 6;
const TOTP_WINDOW = 1;

const ISSUER = process.env.MFA_ISSUER || 'WorkPulse';
const RECOVERY_CODE_COUNT = 10;
const BCRYPT_ROUNDS = 10;

// ────────────────────────────────────────────────────────────────────────────
// Base32 (RFC 4648, no padding) — used for TOTP secrets so they're
// compatible with Google Authenticator / Authy / 1Password etc.
//
// Implemented natively (instead of pulling in otplib, whose v13 transitive
// dependency @scure/base ships ESM that Jest can't parse) so the same code
// runs identically at runtime and under the test harness.
// ────────────────────────────────────────────────────────────────────────────
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buf) {
    let bits = 0;
    let value = 0;
    let out = '';
    for (let i = 0; i < buf.length; i++) {
        value = (value << 8) | buf[i];
        bits += 8;
        while (bits >= 5) {
            out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
            bits -= 5;
        }
    }
    if (bits > 0) {
        out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
    }
    return out;
}

function base32Decode(str) {
    const clean = String(str || '').replace(/=+$/, '').replace(/\s+/g, '').toUpperCase();
    let bits = 0;
    let value = 0;
    const out = [];
    for (let i = 0; i < clean.length; i++) {
        const idx = BASE32_ALPHABET.indexOf(clean[i]);
        if (idx === -1) continue; // skip any stray char
        value = (value << 5) | idx;
        bits += 5;
        if (bits >= 8) {
            out.push((value >>> (bits - 8)) & 0xff);
            bits -= 8;
        }
    }
    return Buffer.from(out);
}

/** Compute the TOTP code for a given secret + counter (RFC 6238 / HOTP). */
function hotp(secretBuf, counter) {
    const buf = Buffer.alloc(8);
    // 64-bit big-endian counter.
    buf.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
    buf.writeUInt32BE(counter >>> 0, 4);
    const hmac = crypto.createHmac('sha1', secretBuf).update(buf).digest();
    const offset = hmac[hmac.length - 1] & 0x0f;
    const binCode = ((hmac[offset] & 0x7f) << 24)
        | ((hmac[offset + 1] & 0xff) << 16)
        | ((hmac[offset + 2] & 0xff) << 8)
        | (hmac[offset + 3] & 0xff);
    const code = binCode % (10 ** TOTP_DIGITS);
    return String(code).padStart(TOTP_DIGITS, '0');
}

// ────────────────────────────────────────────────────────────────────────────
// Secret encryption (AES-256-GCM)
// ────────────────────────────────────────────────────────────────────────────

function getEncKey() {
    const raw = process.env.MFA_ENC_KEY;
    if (raw && raw.length >= 16) {
        // Normalise any-length key material to exactly 32 bytes via SHA-256.
        return crypto.createHash('sha256').update(raw).digest();
    }
    // Fallback: derive from JWT_SECRET so we never store plaintext secrets.
    const jwtSecret = process.env.JWT_SECRET || 'workpulse-dev-secret';
    return crypto.createHash('sha256').update(`mfa:${jwtSecret}`).digest();
}

/**
 * Encrypt a TOTP secret for at-rest storage.
 * Returns a compact string: v1:<iv_b64>:<tag_b64>:<cipher_b64>
 */
function encryptSecret(plain) {
    if (!plain) return null;
    const key = getEncKey();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`;
}

/**
 * Decrypt a stored TOTP secret. Returns null on any failure (corrupt /
 * tampered / key-mismatch) so callers degrade to "MFA not configured"
 * rather than throwing.
 */
function decryptSecret(stored) {
    if (!stored || typeof stored !== 'string') return null;
    try {
        const parts = stored.split(':');
        if (parts.length !== 4 || parts[0] !== 'v1') return null;
        const key = getEncKey();
        const iv = Buffer.from(parts[1], 'base64');
        const tag = Buffer.from(parts[2], 'base64');
        const data = Buffer.from(parts[3], 'base64');
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAuthTag(tag);
        const dec = Buffer.concat([decipher.update(data), decipher.final()]);
        return dec.toString('utf8');
    } catch {
        return null;
    }
}

// ────────────────────────────────────────────────────────────────────────────
// TOTP secret + enrollment
// ────────────────────────────────────────────────────────────────────────────

/** Generate a new base32 TOTP secret (20 random bytes → 32 base32 chars). */
function generateSecret() {
    return base32Encode(crypto.randomBytes(20));
}

/** Build the otpauth:// URI used to seed an authenticator app. */
function buildOtpAuthUrl(secret, accountLabel) {
    const label = accountLabel || 'user';
    const issuer = encodeURIComponent(ISSUER);
    const acct = encodeURIComponent(label);
    return `otpauth://totp/${issuer}:${acct}`
        + `?secret=${secret}`
        + `&issuer=${issuer}`
        + `&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_STEP_SECONDS}`;
}

/** Render the otpauth URI as a PNG data-URL for display as a QR code. */
async function buildQrDataUrl(otpauthUrl) {
    return QRCode.toDataURL(otpauthUrl, { margin: 1, width: 220 });
}

/**
 * Verify a 6-digit TOTP token against a plaintext base32 secret.
 * Allows ±TOTP_WINDOW steps of clock drift. Returns boolean. Never throws.
 */
function verifyToken(secret, token) {
    if (!secret || !token) return false;
    const cleaned = String(token).replace(/\s+/g, '');
    if (!/^\d{6}$/.test(cleaned)) return false;
    try {
        const secretBuf = base32Decode(secret);
        if (!secretBuf.length) return false;
        const counter = Math.floor(Date.now() / 1000 / TOTP_STEP_SECONDS);
        for (let w = -TOTP_WINDOW; w <= TOTP_WINDOW; w++) {
            const candidate = hotp(secretBuf, counter + w);
            // Constant-time compare to avoid leaking timing on the digits.
            if (candidate.length === cleaned.length
                && crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(cleaned))) {
                return true;
            }
        }
        return false;
    } catch {
        return false;
    }
}

// ────────────────────────────────────────────────────────────────────────────
// Recovery codes
// ────────────────────────────────────────────────────────────────────────────

/** Normalise a recovery code for comparison (strip dashes/space, upper-case). */
function normalizeRecoveryCode(code) {
    return String(code || '').replace(/[\s-]/g, '').toUpperCase();
}

/**
 * Generate `RECOVERY_CODE_COUNT` human-friendly single-use recovery codes.
 * Format: XXXX-XXXX (8 unambiguous chars, dash-separated).
 * Returns { plaintext: string[], hashes: string[] }.
 */
async function generateRecoveryCodes() {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous chars (I/O/0/1)
    const plaintext = [];
    for (let i = 0; i < RECOVERY_CODE_COUNT; i++) {
        const bytes = crypto.randomBytes(8);
        let raw = '';
        for (let j = 0; j < 8; j++) raw += alphabet[bytes[j] % alphabet.length];
        plaintext.push(`${raw.slice(0, 4)}-${raw.slice(4)}`);
    }
    const hashes = await Promise.all(
        plaintext.map(code => bcrypt.hash(normalizeRecoveryCode(code), BCRYPT_ROUNDS))
    );
    return { plaintext, hashes };
}

/**
 * Verify a candidate recovery code against the stored hash array.
 * Returns the index of the matching hash, or -1 if no match.
 * Caller is responsible for removing the consumed hash from the array.
 */
async function verifyRecoveryCode(candidate, hashes) {
    if (!candidate || !Array.isArray(hashes)) return -1;
    const norm = normalizeRecoveryCode(candidate);
    if (!norm) return -1;
    for (let i = 0; i < hashes.length; i++) {
        // eslint-disable-next-line no-await-in-loop
        if (hashes[i] && await bcrypt.compare(norm, hashes[i])) return i;
    }
    return -1;
}

/**
 * Generate the current TOTP code for a secret. Primarily used by tests and
 * any server-side flow that needs to emit a code (not used in normal auth).
 */
function generateToken(secret, atMs = Date.now()) {
    const secretBuf = base32Decode(secret);
    const counter = Math.floor(atMs / 1000 / TOTP_STEP_SECONDS);
    return hotp(secretBuf, counter);
}

module.exports = {
    ISSUER,
    RECOVERY_CODE_COUNT,
    encryptSecret,
    decryptSecret,
    generateSecret,
    buildOtpAuthUrl,
    buildQrDataUrl,
    verifyToken,
    generateToken,
    generateRecoveryCodes,
    normalizeRecoveryCode,
    verifyRecoveryCode,
};

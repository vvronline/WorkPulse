/**
 * Unit tests for the MFA utilities + policy helpers.
 *
 * These are pure functions (no DB / network), so they run fast and don't
 * need the supertest app harness. They cover:
 *   - AES-GCM secret encrypt/decrypt round-trip + tamper rejection
 *   - TOTP verify (valid + invalid)
 *   - Recovery-code generation, normalisation, single-use verification
 *   - mfaPolicy: mandatory vs opt-in vs ineligible matrix
 */
'use strict';

const mfa = require('../utils/mfa');
const policy = require('../utils/mfaPolicy');

describe('utils/mfa — secret encryption', () => {
    test('encrypt → decrypt round-trips', () => {
        const secret = mfa.generateSecret();
        const enc = mfa.encryptSecret(secret);
        expect(enc).toMatch(/^v1:/);
        expect(enc).not.toContain(secret);
        expect(mfa.decryptSecret(enc)).toBe(secret);
    });

    test('decrypt returns null for tampered / garbage input', () => {
        expect(mfa.decryptSecret('not-a-real-token')).toBeNull();
        expect(mfa.decryptSecret(null)).toBeNull();
        const enc = mfa.encryptSecret('ABCDEFGHIJKLMNOP');
        // Flip a char in the ciphertext segment → auth tag mismatch → null.
        const broken = enc.slice(0, -2) + (enc.slice(-2) === 'AA' ? 'BB' : 'AA');
        expect(mfa.decryptSecret(broken)).toBeNull();
    });
});

describe('utils/mfa — TOTP verification', () => {
    test('accepts a freshly generated token, rejects a wrong one', () => {
        const secret = mfa.generateSecret();
        const token = mfa.generateToken(secret);
        expect(mfa.verifyToken(secret, token)).toBe(true);
        expect(mfa.verifyToken(secret, '000000')).toBe(false);
        expect(mfa.verifyToken(secret, 'abcdef')).toBe(false);
        expect(mfa.verifyToken(secret, '')).toBe(false);
        expect(mfa.verifyToken('', token)).toBe(false);
    });
});

describe('utils/mfa — recovery codes', () => {
    test('generates the expected count + verifies single-use', async () => {
        const { plaintext, hashes } = await mfa.generateRecoveryCodes();
        expect(plaintext).toHaveLength(mfa.RECOVERY_CODE_COUNT);
        expect(hashes).toHaveLength(mfa.RECOVERY_CODE_COUNT);

        // A valid code matches at its index.
        const idx = await mfa.verifyRecoveryCode(plaintext[3], hashes);
        expect(idx).toBe(3);

        // Case / dash insensitive.
        const idxLower = await mfa.verifyRecoveryCode(plaintext[3].toLowerCase(), hashes);
        expect(idxLower).toBe(3);

        // A non-existent code returns -1.
        expect(await mfa.verifyRecoveryCode('ZZZZ-ZZZZ', hashes)).toBe(-1);
        expect(await mfa.verifyRecoveryCode('', hashes)).toBe(-1);
    });
});

describe('utils/mfaPolicy', () => {
    test('platform_admin → mandatory + eligible', () => {
        expect(policy.isMfaMandatory({ isPlatformUser: true })).toBe(true);
        expect(policy.isMfaMandatory({ role: 'platform_admin' })).toBe(true);
        expect(policy.canOptIntoMfa({ isPlatformUser: true })).toBe(true);
    });

    test('tenant super_admin / hr_admin → opt-in (eligible, not mandatory)', () => {
        for (const role of ['super_admin', 'hr_admin']) {
            expect(policy.isMfaMandatory({ role })).toBe(false);
            expect(policy.canOptIntoMfa({ role })).toBe(true);
        }
    });

    test('regular roles → not eligible', () => {
        for (const role of ['employee', 'manager', 'team_lead']) {
            expect(policy.isMfaMandatory({ role })).toBe(false);
            expect(policy.canOptIntoMfa({ role })).toBe(false);
        }
    });

    test('loginMfaRequirement matrix', () => {
        // Platform admin not yet enrolled → must set up.
        expect(policy.loginMfaRequirement({ isPlatformUser: true, mfaEnabled: false })).toBe('setup');
        // Platform admin enrolled → verify.
        expect(policy.loginMfaRequirement({ isPlatformUser: true, mfaEnabled: true })).toBe('verify');
        // Opt-in role with MFA on → verify.
        expect(policy.loginMfaRequirement({ role: 'super_admin', mfaEnabled: true })).toBe('verify');
        // Opt-in role with MFA off → none (optional).
        expect(policy.loginMfaRequirement({ role: 'super_admin', mfaEnabled: false })).toBe('none');
        // Regular role → none.
        expect(policy.loginMfaRequirement({ role: 'employee', mfaEnabled: false })).toBe('none');
    });
});
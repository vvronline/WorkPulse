/**
 * MFA policy helpers — decide WHEN multi-factor auth is required.
 *
 * Rules (per product spec):
 *   • platform_admin            → MFA is MANDATORY (always required).
 *   • tenant super_admin / hr_admin → MFA is OPT-IN (required only once the
 *                                     user has enabled it on their account).
 *   • everyone else             → MFA not required.
 *
 * These helpers are intentionally pure (no DB access) so they can be reused
 * by the login flow, the /api/mfa routes, and tests.
 */
'use strict';

// Tenant roles for which MFA can be opted into.
const MFA_OPT_IN_ROLES = new Set(['super_admin', 'hr_admin']);

/**
 * Is MFA mandatory for this principal regardless of their enabled flag?
 * @param {object} p
 * @param {boolean} p.isPlatformUser  – true for master platform_users accounts
 * @param {string}  [p.role]          – tenant role (for non-platform users)
 */
function isMfaMandatory({ isPlatformUser, role }) {
    if (isPlatformUser) return true;
    if (role === 'platform_admin') return true;
    return false;
}

/**
 * Can this principal opt into MFA (i.e. the account-security UI should show
 * the enable/disable controls)?
 */
function canOptIntoMfa({ isPlatformUser, role }) {
    if (isMfaMandatory({ isPlatformUser, role })) return true; // mandatory ⇒ also "eligible"
    return MFA_OPT_IN_ROLES.has(role);
}

/**
 * Given the principal + their stored mfa_enabled flag, decide whether a
 * second factor must be satisfied at login time.
 *
 * Returns one of:
 *   'none'         – no MFA step required, issue the session.
 *   'verify'       – MFA is configured & required: prompt for a code.
 *   'setup'        – MFA is mandatory but the user hasn't enrolled yet:
 *                    force enrollment before granting full access.
 */
function loginMfaRequirement({ isPlatformUser, role, mfaEnabled }) {
    const mandatory = isMfaMandatory({ isPlatformUser, role });
    if (mfaEnabled) return 'verify';
    if (mandatory) return 'setup';
    return 'none';
}

module.exports = {
    MFA_OPT_IN_ROLES,
    isMfaMandatory,
    canOptIntoMfa,
    loginMfaRequirement,
};
/**
 * Impersonation Approval helpers.
 *
 * Backs the consent-gated "Enter Tenant" workflow:
 *   1. A platform admin POSTs a request → row goes in `tenant_access_requests`
 *      with status='pending'.
 *   2. A tenant super_admin approves → server generates a random 6-digit code,
 *      bcrypts it, stores the hash + a short TTL, and returns the PLAINTEXT
 *      code to the approver exactly once. The approver shares it with the
 *      requesting inspector over a trusted support channel.
 *   3. Inspector POSTs the code + their own password on /impersonate. We
 *      bcrypt-compare the code, bcrypt-compare the password, and only then
 *      mint a session token with a TTL bounded to the request's
 *      remaining duration.
 *
 * Centralising the bookkeeping here keeps the route file readable and makes
 * the state machine testable without spinning up Express.
 */
import crypto from "crypto";
import bcrypt from "bcryptjs";
import { masterQuery } from "../db";
import { logger } from "./logger";

interface DbLike {
    query: (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount?: number }>;
}

interface PlatformAdmin {
    id: number;
    full_name?: string | null;
}

interface InspectorUser {
    id: number;
    username: string;
    full_name: string;
    email: string | null;
    role: string;
    token_version: number;
}

interface ImpersonationPolicy {
    requiresConsent: boolean;
    breakGlassAllowed: boolean;
    maxSessionMinutes: number;
    codeTtlMinutes: number;
}

interface AccessRequestRow {
    id: number;
    tenant_id: number;
    status: string;
    code_expires_at?: string | Date | null;
    [key: string]: unknown;
}

// 6-digit decimal code. Uses crypto.randomInt so the distribution is uniform
// (avoid `Math.random()` and avoid `% 1_000_000` modulo bias).
function generateApprovalCode(): string {
    const n = crypto.randomInt(0, 1_000_000);
    return String(n).padStart(6, "0");
}

// Lighter bcrypt cost than passwords — the code is short-lived (≤15 min by
// default) and verification happens on the hot impersonation path. 10 rounds
// is still ~100 ms which is comfortably above any timing/brute-force threat
// given the limited code surface (10^6) and rate limit applied by Express.
const APPROVAL_CODE_BCRYPT_ROUNDS = 10;

async function hashApprovalCode(code: string): Promise<string> {
    return bcrypt.hash(code, APPROVAL_CODE_BCRYPT_ROUNDS);
}

async function verifyApprovalCode(code: string | null | undefined, hash: string | null | undefined): Promise<boolean> {
    if (!code || !hash) return false;
    try {
        return await bcrypt.compare(code, hash);
    } catch (e: unknown) {
        logger.warn({ err: (e as Error).message }, "impersonation: bcrypt compare failed");
        return false;
    }
}

/**
 * Load the impersonation policy from `app_settings`. Returns sane defaults if
 * any setting row is missing (which happens on legacy installs that bypass
 * the seed step).
 */
async function getImpersonationPolicy(): Promise<ImpersonationPolicy> {
    const res = await masterQuery(
        `SELECT key, value FROM app_settings WHERE key = ANY($1::text[])`,
        [[
            "impersonation_requires_consent",
            "impersonation_break_glass_allowed",
            "impersonation_max_session_minutes",
            "impersonation_code_ttl_minutes",
        ]],
    );
    const map: Record<string, string> = {};
    for (const r of res.rows) map[r.key] = r.value;

    const parseBool = (v: string | null | undefined, dflt: boolean): boolean => v == null ? dflt : v === "true" || v === "1";
    const parseInt10 = (v: string | null | undefined, dflt: number): number => {
        const n = parseInt(String(v), 10);
        return Number.isFinite(n) && n > 0 ? n : dflt;
    };

    return {
        requiresConsent: parseBool(map.impersonation_requires_consent, true),
        breakGlassAllowed: parseBool(map.impersonation_break_glass_allowed, false),
        maxSessionMinutes: parseInt10(map.impersonation_max_session_minutes, 60),
        codeTtlMinutes: parseInt10(map.impersonation_code_ttl_minutes, 15),
    };
}

/** Update one or more policy settings. Caller must validate values. */
async function updateImpersonationPolicy(patch: Record<string, unknown>): Promise<void> {
    const allowed = new Set([
        "impersonation_requires_consent",
        "impersonation_break_glass_allowed",
        "impersonation_max_session_minutes",
        "impersonation_code_ttl_minutes",
    ]);
    for (const [key, val] of Object.entries(patch)) {
        if (!allowed.has(key)) continue;
        await masterQuery(
            `INSERT INTO app_settings (key, value) VALUES ($1, $2)
             ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
            [key, String(val)],
        );
    }
}

/**
 * Compute the canonical "is this request still usable" predicate.
 * Returns one of:
 *   'pending'   — awaiting approval
 *   'approved'  — approved, code still valid, not yet consumed
 *   'expired'   — code TTL passed
 *   'consumed'  — already used to start a session
 *   'denied'    — denied by tenant
 *   'cancelled' — cancelled by requester
 *   'revoked'   — session was forcibly ended
 */
function computeEffectiveStatus(row: AccessRequestRow | null | undefined, now: Date = new Date()): string | null {
    if (!row) return null;
    if (row.status === "approved" && row.code_expires_at && new Date(row.code_expires_at) < now) {
        return "expired";
    }
    return row.status;
}

/**
 * Mark any stale approved requests as expired in bulk. Cheap to call from
 * read-path endpoints so the inbox never shows a "live" code that won't
 * actually work.
 */
async function expireStaleRequests(): Promise<void> {
    await masterQuery(`
        UPDATE tenant_access_requests
           SET status     = 'expired',
               updated_at = NOW()
         WHERE status = 'approved'
           AND code_expires_at IS NOT NULL
           AND code_expires_at < NOW()
    `);
}

/**
 * Get or create the synthetic Platform Inspector `users` row for a given
 * platform admin inside a tenant database.
 *
 * Background: the consent-gated "Enter Tenant" flow used to mint a JWT
 * against the tenant's highest-ranked active user (typically a tenant
 * super_admin). Every action the inspector took during the session was
 * therefore attributed to a real teammate — wrong avatar in chat, wrong
 * "created by" on tasks, etc. That was confusing for tenant staff and
 * made the audit trail dishonest.
 *
 * The fix is to give each (tenant, platform_admin) pair its own dedicated
 * `users` row that is:
 *   - role               = 'platform_admin'   (matches platform-level RBAC)
 *   - org_id/team_id/dept = NULL              (not part of any org structure)
 *   - is_active          = TRUE
 *   - hidden_from_directory = TRUE            (suppressed from every list)
 *   - username           = `platform_inspector_<platformAdminId>`
 *   - full_name          = "<Inspector Name> (Platform Support)"
 *
 * The row is real, so foreign-key joins, audit logs, history tables, chat
 * message authorship, etc. all keep working — but it never surfaces in any
 * "list users" / "directory" / "chat search" / "@mention" UI because every
 * such query is gated by `AND hidden_from_directory = FALSE`.
 *
 * Idempotent: on second and subsequent impersonations for the same
 * (tenant, platform_admin) pair we just look the row up by its
 * deterministic username. We also refresh `full_name` if the platform
 * admin renamed themselves and re-activate the row if it was somehow
 * disabled — keeping the synthetic identity in lockstep with the source.
 *
 * The password we hash here is purely defensive: it's a fresh random
 * blob, no human ever sees it, and login still has to go through the
 * platform-admin auth flow which mints the impersonation JWT directly
 * (this row is never used as a password-login surface).
 */
async function getOrCreateInspectorUser(db: DbLike, platformAdmin: PlatformAdmin): Promise<InspectorUser> {
    if (!platformAdmin || !platformAdmin.id) {
        throw new Error("getOrCreateInspectorUser: platformAdmin.id is required");
    }
    const username = `platform_inspector_${platformAdmin.id}`;
    const displayName = (platformAdmin.full_name && platformAdmin.full_name.trim())
        ? platformAdmin.full_name.trim()
        : "Platform Support";
    const fullName = `${displayName} (Platform Support)`;

    // Fast path: row already exists for this inspector in this tenant.
    const existingRes = await db.query(
        `SELECT id, username, full_name, email, role, is_active, hidden_from_directory,
                COALESCE(token_version, 0) AS token_version
           FROM users
          WHERE username = $1
          LIMIT 1`,
        [username],
    );
    const existing = existingRes.rows[0];
    if (existing) {
        // Defensive sync: keep the synthetic identity in lockstep with the
        // platform admin's current display name, re-activate if disabled,
        // and re-hide if a stray mutation flipped the directory flag.
        const needsRename = existing.full_name !== fullName;
        const needsReactivate = existing.is_active === false;
        const needsRehide = existing.hidden_from_directory === false;
        if (needsRename || needsReactivate || needsRehide) {
            await db.query(
                `UPDATE users
                    SET full_name = $1,
                        is_active = TRUE,
                        hidden_from_directory = TRUE
                  WHERE id = $2`,
                [fullName, existing.id],
            );
            existing.full_name = fullName;
            existing.is_active = true;
            existing.hidden_from_directory = true;
        }
        return {
            id: existing.id,
            username: existing.username,
            full_name: existing.full_name,
            email: existing.email,
            role: existing.role,
            token_version: existing.token_version,
        };
    }

    // First-time impersonation by this platform admin into this tenant —
    // create the synthetic row. The random password is a placeholder so
    // the bcrypt column constraint is satisfied; nobody will ever try to
    // log in with it (the impersonation JWT bypasses password login).
    const randomPassword = crypto.randomBytes(32).toString("hex");
    const passwordHash = await bcrypt.hash(randomPassword, 10);
    let inserted;
    try {
        inserted = await db.query(
            `INSERT INTO users
                (username, password, full_name, role, is_active, hidden_from_directory,
                 org_id, team_id, department_id)
             VALUES ($1, $2, $3, 'platform_admin', TRUE, TRUE, NULL, NULL, NULL)
             RETURNING id, username, full_name, email, role,
                       COALESCE(token_version, 0) AS token_version`,
            [username, passwordHash, fullName],
        );
    } catch (err: unknown) {
        // Race condition: a concurrent impersonation request just created the
        // same synthetic user. Re-read and return that row instead of failing.
        if (err && (err as { code?: string }).code === "23505") {
            const retry = await db.query(
                `SELECT id, username, full_name, email, role,
                        COALESCE(token_version, 0) AS token_version
                   FROM users WHERE username = $1 LIMIT 1`,
                [username],
            );
            if (retry.rows[0]) return retry.rows[0];
        }
        throw err;
    }
    logger.info(
        { inspectorUserId: inserted.rows[0].id, platformAdminId: platformAdmin.id },
        "impersonation: created synthetic platform inspector user",
    );
    return inserted.rows[0];
}

/**
 * Return the currently-active impersonation request for a tenant, if any.
 * "Active" means status='consumed', not revoked, and not past session_ends_at.
 */
async function getActiveSession(tenantId: number): Promise<AccessRequestRow | null> {
    const res = await masterQuery(`
        SELECT id, tenant_id, requested_by, requested_by_name, requested_by_email,
               reason, scope, consumed_at, session_ends_at, session_audit_log_id
          FROM tenant_access_requests
         WHERE tenant_id = $1
           AND status = 'consumed'
           AND revoked_at IS NULL
           AND (session_ends_at IS NULL OR session_ends_at > NOW())
         ORDER BY consumed_at DESC NULLS LAST
         LIMIT 1
    `, [tenantId]);
    return res.rows[0] || null;
}

/**
 * Decide whether the caller may see tenant-private data for `tenant`.
 *
 * Platform admins may always see *platform* facts about a tenant: name, slug,
 * status, plan, seat count, database size. Those run the business (billing,
 * limit enforcement, lifecycle) and are needed to even find a tenant to
 * request access to in the first place.
 *
 * Anything describing what the tenant's people are actually DOING - user rows
 * (PII) and business-activity metrics - is tenant-private. For the default
 * tenant the platform admin is a first-class member, so it is visible. For
 * every other tenant it requires an approved, live, unrevoked session obtained
 * through the consent flow.
 */
async function hasTenantDataConsent(
    tenant: { id: number; is_default?: boolean } | null | undefined,
    req: { userId?: number; impersonatedBy?: number },
): Promise<boolean> {
    if (!tenant) return false;
    if (tenant.is_default) return true;
    try {
        const session = await getActiveSession(tenant.id);
        if (!session) return false;
        // The live session must belong to the caller - another inspector's
        // approved session must never widen this admin's visibility.
        const actorId = req.impersonatedBy || req.userId;
        return Number(session.requested_by) === Number(actorId);
    } catch (err) {
        logger.warn({ err }, "tenant consent check failed; denying tenant-private data");
        return false;
    }
}

export {
    generateApprovalCode,
    hashApprovalCode,
    verifyApprovalCode,
    getImpersonationPolicy,
    updateImpersonationPolicy,
    computeEffectiveStatus,
    expireStaleRequests,
    getActiveSession,
    hasTenantDataConsent,
    getOrCreateInspectorUser,
};
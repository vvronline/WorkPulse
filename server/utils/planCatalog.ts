/**
 * Plan Catalog — single source of truth for tenant subscription plans,
 * feature flags and per-plan limits.
 *
 * Plans are stored in `app_settings` (key: 'plans_catalog') as a JSON object.
 * The hardcoded PLANS below are the default/fallback when no custom catalog
 * is stored. Use `loadPlanCatalog()` to get the active catalog (DB → fallback).
 *
 * Adding a new feature:
 *   1. Add the key to `FEATURE_LABELS` (this is the whitelist).
 *   2. Add the per-plan default in each `PLANS[plan].features`.
 *   3. Add a backend gate using `requireFeature('your_key')` on the route(s).
 *   4. Add a frontend gate using `useFeatures().hasFeature('your_key')`.
 *   5. Add a row to `planGating.test.js` so regressions are caught.
 *
 * Adding a new plan:
 *   1. Add the entry to `PLANS` AND to `PLAN_RANK`.
 *   2. Add the `tenants_plan_check` migration in `db.js` initMasterDB.
 *   3. Tier-comparison code (`isAtLeastPlan`) automatically picks it up.
 */

type FeatureMap = Record<string, boolean>;

interface PlanLimits {
    max_users: number | null;
    max_storage_mb: number | null;
}

interface PlanDefinition {
    label: string;
    description: string;
    features: FeatureMap;
    limits: PlanLimits;
}

type PlanCatalog = Record<string, PlanDefinition>;

interface TenantLike {
    plan?: string;
    features?: Record<string, unknown>;
}

const DEFAULT_PLANS: PlanCatalog = {
    standard: {
        label: "Standard",
        description: "Essential workforce management",
        features: {
            attendance: true, leaves: true, tasks: true, calendar: true,
            notes: true, notifications: true, export: true,
            chat: false, calls: false, meetings: false, agile: false,
            payroll: false, custom_fields: false,
            audit_logs: false, webhooks: false,
        },
        limits: { max_users: 25, max_storage_mb: 5120 },
    },
    pro: {
        label: "Pro",
        description: "Collaboration & payroll",
        features: {
            attendance: true, leaves: true, tasks: true, calendar: true,
            notes: true, notifications: true, export: true,
            chat: true, calls: true, payroll: true,
            meetings: false, agile: false, custom_fields: false,
            audit_logs: false, webhooks: false,
        },
        limits: { max_users: 100, max_storage_mb: 25600 },
    },
    enterprise: {
        label: "Enterprise",
        description: "Full platform with unlimited access",
        features: {
            attendance: true, leaves: true, tasks: true, calendar: true,
            notes: true, notifications: true, export: true,
            chat: true, calls: true, payroll: true,
            meetings: true, agile: true, custom_fields: true,
            audit_logs: true, webhooks: true,
        },
        limits: { max_users: null, max_storage_mb: null },
    },
};

let PLANS: PlanCatalog = { ...DEFAULT_PLANS };
let planCacheTime = 0;
const PLAN_CACHE_TTL = 60_000;

async function loadPlanCatalog(): Promise<PlanCatalog> {
    const now = Date.now();
    if (now - planCacheTime < PLAN_CACHE_TTL) return PLANS;
    try {
        const { masterQuery } = require("../db");
        const res = await masterQuery(
            `SELECT value FROM app_settings WHERE key = 'plans_catalog'`,
        );
        if (res.rows[0]?.value) {
            const parsed = JSON.parse(res.rows[0].value);
            if (parsed && typeof parsed === "object" && Object.keys(parsed).length > 0) {
                PLANS = parsed;
            }
        }
    } catch {
        // fall back to cached/default
    }
    planCacheTime = now;
    return PLANS;
}

async function savePlanCatalog(catalog: PlanCatalog): Promise<void> {
    const { masterQuery } = require("../db");
    await masterQuery(
        `INSERT INTO app_settings (key, value) VALUES ('plans_catalog', $1)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
        [JSON.stringify(catalog)],
    );
    PLANS = catalog;
    planCacheTime = Date.now();
}

function getPlans(): PlanCatalog { return PLANS; }

const PLAN_KEYS = Object.keys(DEFAULT_PLANS);

/**
 * Plan tier ordering. Use `isAtLeastPlan(currentPlan, requiredPlan)` for
 * comparisons instead of string equality — that way "at least Pro" picks
 * up Enterprise without having to enumerate.
 */
const PLAN_RANK: Record<string, number> = { standard: 1, pro: 2, enterprise: 3 };

const FEATURE_LABELS: Record<string, string> = {
    attendance: "Attendance & Time Tracking",
    leaves: "Leave Management",
    tasks: "Tasks & Kanban",
    calendar: "Calendar",
    notes: "Notes & Wiki",
    notifications: "Notifications",
    export: "Export & Reports",
    chat: "Chat & Messaging",
    calls: "Audio/Video Calls",
    meetings: "Scheduled Meetings",
    agile: "Agile & Sprints",
    payroll: "Payroll & Compensation",
    custom_fields: "Custom Fields",
    audit_logs: "Audit Logs",
    webhooks: "Webhooks & Integrations",
};

const FEATURE_KEYS = Object.keys(FEATURE_LABELS);

/**
 * Normalise an arbitrary override value to a strict boolean.
 *
 *   true / 'true' / 1 / '1' / 'on' / 'yes'  → true
 *   false / 'false' / 0 / '0' / 'off' / 'no'/ ''  → false
 *   null / undefined                         → null  (fall back to plan default)
 *   anything else                            → null  (treat as "not overridden")
 *
 * The strict whitelist prevents the previous bug where `features[name] !== false`
 * silently enabled features for malformed overrides like `null`, `0`, or `'x'`.
 */
function coerceFeatureValue(value: unknown): boolean | null {
    if (value === null || value === undefined) return null;
    if (typeof value === "boolean") return value;
    if (typeof value === "number") return value === 1 ? true : value === 0 ? false : null;
    if (typeof value === "string") {
        const v = value.trim().toLowerCase();
        if (["true", "1", "on", "yes"].includes(v)) return true;
        if (["false", "0", "off", "no", ""].includes(v)) return false;
    }
    return null;
}

/**
 * Filter raw `tenants.features` JSON to only the whitelisted feature keys
 * and coerced boolean values. Drops anything unrecognised. Returns a fresh
 * object so callers can't mutate cached tenant rows.
 *
 * Keys NOT in FEATURE_LABELS (e.g. `registration_mode`) are preserved as-is
 * under a separate `extras` namespace so feature-gating code never collides
 * with non-feature config that historically shared the JSONB column.
 */
function sanitizeFeatureOverrides(
    raw: Record<string, unknown> | null | undefined,
): { overrides: FeatureMap; extras: Record<string, unknown> } {
    if (!raw || typeof raw !== "object") return { overrides: {}, extras: {} };
    const overrides: FeatureMap = {};
    const extras: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(raw)) {
        if (FEATURE_KEYS.includes(k)) {
            const c = coerceFeatureValue(v);
            if (c !== null) overrides[k] = c;
        } else {
            extras[k] = v;
        }
    }
    return { overrides, extras };
}

/**
 * Resolve the effective feature flags for a tenant.
 * Plan defaults first, then sanitised per-tenant overrides.
 *
 * @param plan - tenants.plan
 * @param rawOverrides - tenants.features JSONB (possibly malformed)
 * @returns every feature key resolved to a strict boolean
 */
function getEffectiveFeatures(plan: string, rawOverrides: Record<string, unknown> = {}): FeatureMap {
    const planDef = PLANS[plan] || PLANS.standard;
    const { overrides } = sanitizeFeatureOverrides(rawOverrides);
    // Start from the plan defaults so unknown plans still produce a complete map.
    const out: FeatureMap = { ...planDef.features };
    for (const k of FEATURE_KEYS) {
        if (k in overrides) out[k] = overrides[k];
        else if (!(k in out)) out[k] = false; // fail closed for any feature missing in plan def
    }
    return out;
}

/**
 * Check whether a specific feature is enabled for a tenant.
 * Centralises the "tenant or null" semantics so handlers don't all reimplement
 * the same conditional.
 *
 * @param tenant - tenant row (or null for master-context routes)
 * @param featureName
 * @returns true if feature is on, false if off, true for null tenant
 *                   (master-context routes are platform admin only and aren't
 *                   subject to per-tenant gating).
 */
function isFeatureEnabled(tenant: TenantLike | null, featureName: string): boolean {
    if (!tenant) return true;
    const eff = getEffectiveFeatures(tenant.plan || "standard", tenant.features);
    return eff[featureName] === true;
}

function getPlanLimits(plan: string): PlanLimits {
    const planDef = PLANS[plan] || PLANS.standard;
    return { ...planDef.limits };
}

/**
 * Tier comparison — `isAtLeastPlan(current, required)`.
 * Unknown plans are treated as the lowest tier (fail-closed for gating).
 */
function isAtLeastPlan(current: string, required: string): boolean {
    const c = PLAN_RANK[current] || 0;
    const r = PLAN_RANK[required] || 0;
    return c >= r;
}

/**
 * Diff plan A → plan B: returns which features the destination plan turns off
 * relative to the source plan. Used by the plan-change dry-run preview to
 * warn a tenant about the impact of a downgrade.
 */
function planFeatureDiff(fromPlan: string, toPlan: string): { disabled: string[]; enabled: string[] } {
    const a = (PLANS[fromPlan] || PLANS.standard).features;
    const b = (PLANS[toPlan] || PLANS.standard).features;
    const disabled: string[] = [];
    const enabled: string[] = [];
    for (const k of FEATURE_KEYS) {
        const wasOn = a[k] === true;
        const willBeOn = b[k] === true;
        if (wasOn && !willBeOn) disabled.push(k);
        if (!wasOn && willBeOn) enabled.push(k);
    }
    return { disabled, enabled };
}

export {
    PLANS,
    DEFAULT_PLANS,
    PLAN_KEYS,
    PLAN_RANK,
    FEATURE_LABELS,
    FEATURE_KEYS,
    getPlans,
    loadPlanCatalog,
    savePlanCatalog,
    getEffectiveFeatures,
    getPlanLimits,
    isFeatureEnabled,
    isAtLeastPlan,
    planFeatureDiff,
    sanitizeFeatureOverrides,
    coerceFeatureValue,
};
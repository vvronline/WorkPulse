/**
 * Plan & feature gating regression matrix.
 *
 * Goals:
 *   1. Every feature key declared in `FEATURE_LABELS` has an explicit default
 *      in every plan in `PLANS`. A typo or missed plan now fails the suite
 *      instead of silently disabling the feature for that tier at runtime.
 *   2. `getEffectiveFeatures` returns strict booleans for every key, even
 *      when given malformed override JSON. This is the core safety net for
 *      the historical bug where `null` / `0` / arbitrary strings could
 *      silently flip a feature on.
 *   3. The `requireFeature` middleware behaves correctly for the three
 *      tenant contexts: tenant with feature on, tenant with feature off,
 *      and master context (no tenant). Master context must always pass
 *      through — that's how platform_admin routes work.
 *   4. `requireMinPlan` respects the documented plan ordering.
 *
 * This test runs in isolation — no DB, no server bootstrap — so it can
 * stay in the fast unit-test path and gate every PR.
 */

// The global jest.setup.js mocks `middleware/tenant` with pass-through stubs
// so unrelated route tests don't have to wire real DB resolution. Here we
// EXPLICITLY want the real implementation — that's the whole point of this
// suite — so unmock it for this file before requiring.
jest.unmock('../middleware/tenant');

const {
    PLANS, PLAN_KEYS, PLAN_RANK, FEATURE_LABELS, FEATURE_KEYS,
    getEffectiveFeatures, getPlanLimits, isFeatureEnabled, isAtLeastPlan,
    planFeatureDiff, sanitizeFeatureOverrides, coerceFeatureValue,
} = require('../utils/planCatalog');

// Use jest.requireActual to bypass the global mock for the middleware import.
const { requireFeature, requireMinPlan } = jest.requireActual('../middleware/tenant');

describe('Plan catalog integrity', () => {
    test('every PLAN_KEY has a PLAN_RANK', () => {
        for (const k of PLAN_KEYS) {
            expect(PLAN_RANK[k]).toBeGreaterThan(0);
        }
    });

    test('every feature key is declared in every plan', () => {
        for (const plan of PLAN_KEYS) {
            for (const feature of FEATURE_KEYS) {
                expect(typeof PLANS[plan].features[feature]).toBe('boolean');
            }
        }
    });

    test('plan ranks are strictly increasing (standard < pro < enterprise)', () => {
        expect(isAtLeastPlan('standard', 'standard')).toBe(true);
        expect(isAtLeastPlan('pro', 'standard')).toBe(true);
        expect(isAtLeastPlan('enterprise', 'pro')).toBe(true);
        expect(isAtLeastPlan('standard', 'pro')).toBe(false);
        expect(isAtLeastPlan('pro', 'enterprise')).toBe(false);
    });

    test('higher tiers never disable a feature that a lower tier has on', () => {
        // Sort plans by rank ascending
        const sorted = [...PLAN_KEYS].sort((a, b) => PLAN_RANK[a] - PLAN_RANK[b]);
        for (let i = 1; i < sorted.length; i++) {
            const lower = PLANS[sorted[i - 1]].features;
            const higher = PLANS[sorted[i]].features;
            for (const f of FEATURE_KEYS) {
                if (lower[f] === true && higher[f] !== true) {
                    throw new Error(`Plan ${sorted[i]} disables '${f}' that ${sorted[i - 1]} has enabled`);
                }
            }
        }
    });

    test('unknown plan name falls back to standard defaults', () => {
        const f = getEffectiveFeatures('does-not-exist', {});
        expect(f).toEqual(PLANS.standard.features);
    });
});

describe('coerceFeatureValue — strict boolean coercion', () => {
    test('booleans pass through', () => {
        expect(coerceFeatureValue(true)).toBe(true);
        expect(coerceFeatureValue(false)).toBe(false);
    });

    test('truthy strings normalise to true', () => {
        for (const v of ['true', 'TRUE', '1', 'on', 'yes', 'Yes']) {
            expect(coerceFeatureValue(v)).toBe(true);
        }
    });

    test('falsy strings normalise to false', () => {
        for (const v of ['false', '0', 'off', 'no', '']) {
            expect(coerceFeatureValue(v)).toBe(false);
        }
    });

    test('null / undefined / garbage values return null (no override)', () => {
        expect(coerceFeatureValue(null)).toBeNull();
        expect(coerceFeatureValue(undefined)).toBeNull();
        expect(coerceFeatureValue({})).toBeNull();
        expect(coerceFeatureValue([])).toBeNull();
        expect(coerceFeatureValue('xyz')).toBeNull();
        expect(coerceFeatureValue(2)).toBeNull();
    });
});

describe('sanitizeFeatureOverrides', () => {
    test('drops unknown keys from overrides, preserves them as extras', () => {
        const { overrides, extras } = sanitizeFeatureOverrides({
            chat: true,
            does_not_exist: true,
            registration_mode: 'open',
        });
        expect(overrides).toEqual({ chat: true });
        expect(extras).toEqual({
            does_not_exist: true,
            registration_mode: 'open',
        });
    });

    test('drops malformed values for known keys', () => {
        const { overrides } = sanitizeFeatureOverrides({
            chat: 'garbage',
            calls: null,
            meetings: 'true',
        });
        expect(overrides).toEqual({ meetings: true });
    });
});

describe('getEffectiveFeatures — fail-closed semantics', () => {
    test('standard plan has chat OFF by default', () => {
        const f = getEffectiveFeatures('standard', {});
        expect(f.chat).toBe(false);
        expect(f.calls).toBe(false);
        expect(f.meetings).toBe(false);
        expect(f.webhooks).toBe(false);
    });

    test('pro plan has chat / calls / payroll ON, meetings / webhooks OFF', () => {
        const f = getEffectiveFeatures('pro', {});
        expect(f.chat).toBe(true);
        expect(f.calls).toBe(true);
        expect(f.payroll).toBe(true);
        expect(f.meetings).toBe(false);
        expect(f.webhooks).toBe(false);
    });

    test('enterprise plan has everything ON', () => {
        const f = getEffectiveFeatures('enterprise', {});
        for (const k of FEATURE_KEYS) expect(f[k]).toBe(true);
    });

    test('per-tenant override turns a plan default OFF', () => {
        const f = getEffectiveFeatures('pro', { chat: false });
        expect(f.chat).toBe(false);
        expect(f.calls).toBe(true); // not overridden
    });

    test('per-tenant override turns a plan default ON', () => {
        const f = getEffectiveFeatures('standard', { meetings: true });
        expect(f.meetings).toBe(true);
    });

    test('malformed override does NOT silently flip feature on (the bug fix)', () => {
        // The historical bug: features[name] !== false → null/0/'x' yielded true.
        expect(getEffectiveFeatures('standard', { chat: null }).chat).toBe(false);
        expect(getEffectiveFeatures('standard', { chat: 0 }).chat).toBe(false);
        expect(getEffectiveFeatures('standard', { chat: 'garbage' }).chat).toBe(false);
        expect(getEffectiveFeatures('standard', { chat: undefined }).chat).toBe(false);
    });

    test('unknown keys in override do not leak into effective map', () => {
        const f = getEffectiveFeatures('pro', { not_a_feature: true });
        expect(f.not_a_feature).toBeUndefined();
    });
});

describe('isFeatureEnabled', () => {
    test('null tenant (master context) is always allowed', () => {
        expect(isFeatureEnabled(null, 'meetings')).toBe(true);
        expect(isFeatureEnabled(undefined, 'meetings')).toBe(true);
    });

    test('respects plan default', () => {
        expect(isFeatureEnabled({ plan: 'standard', features: {} }, 'chat')).toBe(false);
        expect(isFeatureEnabled({ plan: 'pro', features: {} }, 'chat')).toBe(true);
    });

    test('respects per-tenant override', () => {
        expect(isFeatureEnabled({ plan: 'standard', features: { chat: true } }, 'chat')).toBe(true);
        expect(isFeatureEnabled({ plan: 'pro', features: { chat: false } }, 'chat')).toBe(false);
    });
});

describe('planFeatureDiff', () => {
    test('downgrade from enterprise to standard reports disabled features', () => {
        const diff = planFeatureDiff('enterprise', 'standard');
        expect(diff.disabled).toEqual(expect.arrayContaining([
            'chat', 'calls', 'payroll', 'meetings', 'agile', 'webhooks',
            'audit_logs', 'custom_fields',
        ]));
        expect(diff.enabled).toEqual([]);
    });

    test('upgrade reports enabled features', () => {
        const diff = planFeatureDiff('standard', 'pro');
        expect(diff.enabled).toEqual(expect.arrayContaining(['chat', 'calls', 'payroll']));
        expect(diff.disabled).toEqual([]);
    });

    test('same plan is a no-op', () => {
        const diff = planFeatureDiff('pro', 'pro');
        expect(diff.disabled).toEqual([]);
        expect(diff.enabled).toEqual([]);
    });
});

describe('getPlanLimits', () => {
    test('standard plan has finite caps', () => {
        const l = getPlanLimits('standard');
        expect(l.max_users).toBe(25);
        expect(l.max_storage_mb).toBe(5120);
    });

    test('enterprise plan has unlimited caps (null)', () => {
        const l = getPlanLimits('enterprise');
        expect(l.max_users).toBeNull();
        expect(l.max_storage_mb).toBeNull();
    });

    test('returns a copy — caller can mutate without poisoning the catalog', () => {
        const l = getPlanLimits('standard');
        l.max_users = 999;
        expect(getPlanLimits('standard').max_users).toBe(25);
    });
});

describe('requireFeature middleware', () => {
    function runMiddleware(mw, req) {
        return new Promise((resolve) => {
            const res = {
                status(code) { this.statusCode = code; return this; },
                json(body) { this.body = body; resolve({ res: this, calledNext: false }); },
            };
            mw(req, res, () => resolve({ res, calledNext: true }));
        });
    }

    test('passes through when req.tenant is null (master context)', async () => {
        const { calledNext } = await runMiddleware(requireFeature('chat'), { tenant: null });
        expect(calledNext).toBe(true);
    });

    test('passes through when feature is enabled', async () => {
        const { calledNext } = await runMiddleware(requireFeature('chat'), {
            tenant: { plan: 'pro', features: {} },
            log: { info: () => { } },
        });
        expect(calledNext).toBe(true);
    });

    test('rejects with 403 when feature is disabled', async () => {
        const { res, calledNext } = await runMiddleware(requireFeature('chat'), {
            tenant: { id: 7, plan: 'standard', features: {} },
            log: { info: () => { } },
        });
        expect(calledNext).toBe(false);
        expect(res.statusCode).toBe(403);
        expect(res.body.code).toBe('FEATURE_NOT_AVAILABLE');
        expect(res.body.feature).toBe('chat');
        expect(res.body.plan).toBe('standard');
    });

    test('per-tenant override beats plan default', async () => {
        const { calledNext } = await runMiddleware(requireFeature('chat'), {
            tenant: { id: 7, plan: 'standard', features: { chat: true } },
            log: { info: () => { } },
        });
        expect(calledNext).toBe(true);
    });
});

describe('requireMinPlan middleware', () => {
    function runMiddleware(mw, req) {
        return new Promise((resolve) => {
            const res = {
                status(code) { this.statusCode = code; return this; },
                json(body) { this.body = body; resolve({ res: this, calledNext: false }); },
            };
            mw(req, res, () => resolve({ res, calledNext: true }));
        });
    }

    test('master context bypasses tier check', async () => {
        const { calledNext } = await runMiddleware(requireMinPlan('enterprise'), { tenant: null });
        expect(calledNext).toBe(true);
    });

    test('standard tenant cannot access pro-tier route', async () => {
        const { res, calledNext } = await runMiddleware(requireMinPlan('pro'), {
            tenant: { plan: 'standard', features: {} },
        });
        expect(calledNext).toBe(false);
        expect(res.statusCode).toBe(403);
        expect(res.body.code).toBe('PLAN_TIER_REQUIRED');
    });

    test('pro tenant passes pro-tier and standard-tier checks', async () => {
        for (const target of ['standard', 'pro']) {
            const { calledNext } = await runMiddleware(requireMinPlan(target), {
                tenant: { plan: 'pro', features: {} },
            });
            expect(calledNext).toBe(true);
        }
    });
});

describe('Feature → endpoint coverage map', () => {
    // Sanity check: every feature in `FEATURE_LABELS` should be gated by at
    // least one server-side `requireFeature(...)` call. If you add a new
    // feature without wiring a gate, this test will tell you immediately.
    //
    // We grep the actual route files at test time so the assertion stays
    // honest — no manual list to maintain.
    test('every gateable feature has at least one requireFeature call in routes/', () => {
        const fs = require('fs');
        const path = require('path');
        const routesDir = path.join(__dirname, '..', 'routes');
        let blob = '';
        for (const f of fs.readdirSync(routesDir)) {
            const full = path.join(routesDir, f);
            try {
                if (fs.statSync(full).isFile() && f.endsWith('.js')) {
                    blob += fs.readFileSync(full, 'utf8');
                }
            } catch { /* ignore */ }
        }
        // Features genuinely usable without a per-route gate. `attendance` /
        // `leaves` / `tasks` / `calendar` / `notes` / `notifications` /
        // `export` are baseline features in every plan; they don't need a
        // gate at all. `calls` is gated together with `chat` today (split
        // is a Phase-2 follow-up).
        const EXEMPT = new Set([
            'attendance', 'leaves', 'tasks', 'calendar', 'notes',
            'notifications', 'export', 'calls',
        ]);
        const missing = [];
        for (const f of FEATURE_KEYS) {
            if (EXEMPT.has(f)) continue;
            if (!blob.includes(`requireFeature('${f}')`) && !blob.includes(`isFeatureEnabled(${'tenantRow'}`)) {
                // Webhooks is checked via isFeatureEnabled inside webhooks.js,
                // not via requireFeature middleware. Accept either.
                if (f === 'webhooks' && blob.includes(`isFeatureEnabled(`)) continue;
                missing.push(f);
            }
        }
        expect(missing).toEqual([]);
    });
});
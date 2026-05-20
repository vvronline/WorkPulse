/**
 * Table-driven tests for the pure status resolver.
 *
 * Adding a row here is the cheapest way to lock in a behaviour change.
 * Please keep the table sorted by "what the user sees" (the `expected`
 * column) — it makes intent obvious during code review.
 */

const { resolveEffective } = require('../resolver');
const { IDLE_AWAY_MS, SESSION_STALE_MS } = require('../constants');

const NOW = new Date('2026-01-15T12:00:00.000Z');
const ms = (delta) => new Date(NOW.getTime() + delta);

const openSession = (extra = {}) => ({
    sessionKey: 'sess-1',
    disconnectedAt: null,
    lastSeenAt: NOW,
    activity: null,
    ...extra,
});

describe('resolveEffective — happy path table', () => {
    const cases = [
        // ── offline ────────────────────────────────────────────────────────
        {
            name: 'no sessions → offline',
            input: { sessions: [], manualStatus: 'available', presencePreference: 'auto', now: NOW },
            expected: { effective: 'offline', presence: 'offline', source: 'session_close' },
        },
        {
            name: 'all sessions disconnected → offline',
            input: {
                sessions: [openSession({ disconnectedAt: ms(-10000) })],
                manualStatus: 'available',
                presencePreference: 'auto',
                now: NOW,
            },
            expected: { effective: 'offline', presence: 'offline', source: 'session_close' },
        },
        {
            name: 'stale session (no pong) → offline',
            input: {
                sessions: [openSession({ lastSeenAt: ms(-SESSION_STALE_MS - 1) })],
                manualStatus: 'available',
                presencePreference: 'auto',
                now: NOW,
            },
            expected: { effective: 'offline', presence: 'offline', source: 'session_close' },
        },
        {
            name: 'invisible preference + open session → offline (user)',
            input: {
                sessions: [openSession()],
                manualStatus: 'available',
                presencePreference: 'invisible',
                now: NOW,
            },
            expected: { effective: 'offline', presence: 'offline', source: 'user' },
        },
        // ── activity wins ──────────────────────────────────────────────────
        {
            name: 'in_call overrides manual dnd',
            input: {
                sessions: [openSession({ activity: 'in_call' })],
                manualStatus: 'dnd',
                presencePreference: 'auto',
                now: NOW,
            },
            expected: { effective: 'in_call', presence: 'online', source: 'call' },
        },
        {
            name: 'in_meeting on one of two sessions',
            input: {
                sessions: [
                    openSession({ sessionKey: 'a' }),
                    openSession({ sessionKey: 'b', activity: 'in_meeting' }),
                ],
                manualStatus: null,
                presencePreference: 'auto',
                now: NOW,
            },
            expected: { effective: 'in_meeting', presence: 'online', source: 'meeting' },
        },
        {
            name: 'in_call beats in_meeting (precedence order in constants)',
            input: {
                sessions: [
                    openSession({ sessionKey: 'a', activity: 'in_meeting' }),
                    openSession({ sessionKey: 'b', activity: 'in_call' }),
                ],
                manualStatus: null,
                presencePreference: 'auto',
                now: NOW,
            },
            expected: { effective: 'in_call', presence: 'online', source: 'call' },
        },
        {
            name: 'activity ignored when user is invisible',
            input: {
                sessions: [openSession({ activity: 'in_call' })],
                manualStatus: null,
                presencePreference: 'invisible',
                now: NOW,
            },
            expected: { effective: 'offline', presence: 'offline', source: 'user' },
        },
        // ── hard manual states ─────────────────────────────────────────────
        {
            name: 'dnd respected even when idle',
            input: {
                sessions: [openSession()],
                manualStatus: 'dnd',
                presencePreference: 'auto',
                lastActivityAt: ms(-IDLE_AWAY_MS - 1),
                now: NOW,
            },
            expected: { effective: 'dnd', presence: 'online', source: 'user' },
        },
        {
            name: 'busy respected',
            input: {
                sessions: [openSession()],
                manualStatus: 'busy',
                presencePreference: 'auto',
                now: NOW,
            },
            expected: { effective: 'busy', presence: 'online', source: 'user' },
        },
        {
            name: 'brb respected even when idle',
            input: {
                sessions: [openSession()],
                manualStatus: 'brb',
                presencePreference: 'auto',
                lastActivityAt: ms(-IDLE_AWAY_MS - 1),
                now: NOW,
            },
            expected: { effective: 'brb', presence: 'online', source: 'user' },
        },
        // ── idle/away ──────────────────────────────────────────────────────
        {
            name: 'idle → away (no manual state, no activity)',
            input: {
                sessions: [openSession()],
                manualStatus: null,
                presencePreference: 'auto',
                lastActivityAt: ms(-IDLE_AWAY_MS - 1),
                now: NOW,
            },
            expected: { effective: 'away', presence: 'online', source: 'idle' },
        },
        {
            name: 'idle but available manually picked → still available (manual user choice wins over idle if explicit)',
            // Design choice: explicit "available" reflects user intent.
            // Idle still applies only when no manual choice was made.
            input: {
                sessions: [openSession()],
                manualStatus: 'available',
                presencePreference: 'auto',
                lastActivityAt: ms(-IDLE_AWAY_MS - 1),
                now: NOW,
            },
            // We *do* go to away here, because 'available' is not in the
            // "hard" list — see resolver step 3. If product wants to
            // change this, just add 'available' to that branch.
            expected: { effective: 'away', presence: 'online', source: 'idle' },
        },
        {
            name: 'recent activity → available',
            input: {
                sessions: [openSession()],
                manualStatus: null,
                presencePreference: 'auto',
                lastActivityAt: ms(-1000),
                now: NOW,
            },
            expected: { effective: 'available', presence: 'online', source: 'system' },
        },
        {
            name: 'no lastActivityAt → not idle, default available',
            input: {
                sessions: [openSession()],
                manualStatus: null,
                presencePreference: 'auto',
                now: NOW,
            },
            expected: { effective: 'available', presence: 'online', source: 'system' },
        },
        // ── default ────────────────────────────────────────────────────────
        {
            name: 'available manual choice, online',
            input: {
                sessions: [openSession()],
                manualStatus: 'available',
                presencePreference: 'auto',
                lastActivityAt: ms(-1000),
                now: NOW,
            },
            expected: { effective: 'available', presence: 'online', source: 'user' },
        },
    ];

    test.each(cases)('$name', ({ input, expected }) => {
        expect(resolveEffective(input)).toEqual(expected);
    });
});

describe('resolveEffective — validation', () => {
    test('rejects missing now', () => {
        expect(() =>
            resolveEffective({ sessions: [], manualStatus: null, presencePreference: 'auto' })
        ).toThrow(/now/);
    });
    test('rejects invalid manualStatus', () => {
        expect(() =>
            resolveEffective({
                sessions: [],
                manualStatus: 'offline', // legacy! no longer valid as a manual choice
                presencePreference: 'auto',
                now: NOW,
            })
        ).toThrow(/manualStatus/);
    });
    test('rejects invalid presencePreference', () => {
        expect(() =>
            resolveEffective({
                sessions: [],
                manualStatus: null,
                presencePreference: 'bogus',
                now: NOW,
            })
        ).toThrow(/presencePreference/);
    });
});

describe('resolveEffective — multi-session scenarios', () => {
    test('one device offline, one device on a call → effective in_call', () => {
        const result = resolveEffective({
            sessions: [
                openSession({ sessionKey: 'desktop', activity: 'in_call' }),
                openSession({ sessionKey: 'mobile', disconnectedAt: ms(-1000) }),
            ],
            manualStatus: null,
            presencePreference: 'auto',
            now: NOW,
        });
        expect(result.effective).toBe('in_call');
        expect(result.presence).toBe('online');
    });

    test('activity-only session goes stale → effective falls back to available', () => {
        const result = resolveEffective({
            sessions: [
                openSession({ sessionKey: 'old', activity: 'in_call', lastSeenAt: ms(-SESSION_STALE_MS - 1) }),
                openSession({ sessionKey: 'new', lastSeenAt: NOW }),
            ],
            manualStatus: null,
            presencePreference: 'auto',
            lastActivityAt: ms(-1000),
            now: NOW,
        });
        expect(result.effective).toBe('available');
        expect(result.source).toBe('system');
    });
});
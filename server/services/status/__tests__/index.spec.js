/**
 * Integration tests for StatusService — uses an in-memory fake of `db` so we
 * exercise the full side-effect chain (repository → resolver → cache → broadcaster)
 * without booting Postgres / Redis.
 *
 * The fake records every SQL statement so we can assert that:
 *   • the right tables were touched
 *   • a `user_status_events` row was written for every transition
 *   • the broadcaster received the right payload
 *
 * (PR7) The legacy dual-write to `users.user_status` was removed; we no
 * longer assert on those columns.
 */

// Mock Redis up-front — the service degrades gracefully when client is null.
jest.mock('../../../redis', () => ({
    KEYS: {},
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue(undefined),
    del: jest.fn().mockResolvedValue(undefined),
    getClient: () => null,
}));

// Capture WS broadcasts without depending on the real `ws` module.
const sentMessages = [];
jest.mock('../../../utils/ws', () => ({
    sendToUser: (tenantId, userId, type, data) => {
        sentMessages.push({ tenantId, userId, type, data });
    },
}));

const statusService = require('../');

/**
 * Minimal in-memory Postgres fake. We pattern-match on the SQL the
 * repository emits — enough to drive every code path the service uses.
 *
 * State shape:
 *   users:     Map<id, { id, manual_status, presence_preference, status_message, status_message_expires_at, last_activity_at, org_id, is_active, user_status, user_status_text }>
 *   sessions:  Map<session_key, { id, user_id, session_key, device_label, connected_at, last_seen_at, disconnected_at, activity, activity_ref_id }>
 *   events:    Array<{ user_id, source, from_state, to_state, session_key, metadata, created_at }>
 */
function makeDb({ users }) {
    const state = {
        users: new Map(users.map(u => [u.id, {
            id: u.id,
            manual_status: null,
            presence_preference: 'auto',
            status_message: null,
            status_message_expires_at: null,
            last_activity_at: new Date(0),
            org_id: u.org_id ?? 1,
            is_active: true,
            user_status: 'available',
            user_status_text: null,
            ...u,
        }])),
        sessions: new Map(),
        events: [],
    };
    let sessionIdSeq = 1;

    function query(sql, params = []) {
        const s = sql.replace(/\s+/g, ' ').trim();

        // ── users prefs read (single) ─────────────────────────────────────
        if (/SELECT id, manual_status, presence_preference.*FROM users WHERE id = \$1/i.test(s)) {
            const u = state.users.get(params[0]);
            return { rows: u ? [u] : [] };
        }
        // ── users prefs read (bulk) ───────────────────────────────────────
        if (/SELECT id, manual_status, presence_preference.*FROM users WHERE id = ANY\(\$1::int\[\]\)/i.test(s)) {
            const ids = params[0];
            return { rows: ids.map(id => state.users.get(id)).filter(Boolean) };
        }
        // ── sessions read (single) ────────────────────────────────────────
        if (/FROM user_presence_sessions WHERE user_id = \$1 AND disconnected_at IS NULL/i.test(s)) {
            const userId = params[0];
            return {
                rows: [...state.sessions.values()].filter(r => r.user_id === userId && !r.disconnected_at),
            };
        }
        // ── sessions read (bulk) ──────────────────────────────────────────
        if (/FROM user_presence_sessions WHERE user_id = ANY\(\$1::int\[\]\) AND disconnected_at IS NULL/i.test(s)) {
            const ids = params[0];
            return {
                rows: [...state.sessions.values()].filter(r => ids.includes(r.user_id) && !r.disconnected_at),
            };
        }
        // ── set manual status ─────────────────────────────────────────────
        if (/^UPDATE users SET manual_status = \$1, status_message = \$2, status_message_expires_at = \$3 WHERE id = \$4$/i.test(s)) {
            const [status, message, expiresAt, userId] = params;
            const u = state.users.get(userId);
            if (u) { u.manual_status = status; u.status_message = message; u.status_message_expires_at = expiresAt; }
            return { rows: [] };
        }
        // ── set presence preference ───────────────────────────────────────
        if (/^UPDATE users SET presence_preference = \$1 WHERE id = \$2$/i.test(s)) {
            const u = state.users.get(params[1]);
            if (u) u.presence_preference = params[0];
            return { rows: [] };
        }
        // ── touch last activity ───────────────────────────────────────────
        if (/^UPDATE users SET last_activity_at = \$1 WHERE id = \$2$/i.test(s)) {
            const u = state.users.get(params[1]);
            if (u) u.last_activity_at = params[0];
            return { rows: [] };
        }
        // ── open session (INSERT … ON CONFLICT) ───────────────────────────
        if (/^INSERT INTO user_presence_sessions/i.test(s)) {
            const [userId, sessionKey, deviceLabel] = params;
            const existing = state.sessions.get(sessionKey);
            if (existing) {
                existing.disconnected_at = null;
                existing.last_seen_at = new Date();
                existing.user_id = userId;
                if (deviceLabel) existing.device_label = deviceLabel;
            } else {
                state.sessions.set(sessionKey, {
                    id: sessionIdSeq++,
                    user_id: userId,
                    session_key: sessionKey,
                    device_label: deviceLabel,
                    connected_at: new Date(),
                    last_seen_at: new Date(),
                    disconnected_at: null,
                    activity: null,
                    activity_ref_id: null,
                });
            }
            return { rows: [] };
        }
        // ── touch session ─────────────────────────────────────────────────
        if (/^UPDATE user_presence_sessions SET last_seen_at = NOW\(\)/i.test(s)) {
            const sess = state.sessions.get(params[0]);
            if (sess && !sess.disconnected_at) sess.last_seen_at = new Date();
            return { rows: [] };
        }
        // ── set activity ──────────────────────────────────────────────────
        if (/^UPDATE user_presence_sessions SET activity = \$2, activity_ref_id = \$3/i.test(s)) {
            const [sessionKey, activity, refId] = params;
            const sess = state.sessions.get(sessionKey);
            if (sess && !sess.disconnected_at) {
                sess.activity = activity;
                sess.activity_ref_id = refId;
                sess.last_seen_at = new Date();
                return { rows: [{ user_id: sess.user_id }] };
            }
            return { rows: [] };
        }
        // ── clear activity by (activity, refId) — sweep all matching sessions
        //    (used by call_end / meeting_end). Note: this pattern must match
        //    BEFORE the single-session clear below, because both queries start
        //    with the same UPDATE prefix.
        if (/^UPDATE user_presence_sessions SET activity = NULL, activity_ref_id = NULL.*WHERE activity = \$1 AND activity_ref_id = \$2/i.test(s)) {
            const [activity, refId] = params;
            const affected = [];
            for (const sess of state.sessions.values()) {
                if (!sess.disconnected_at && sess.activity === activity && sess.activity_ref_id === refId) {
                    sess.activity = null;
                    sess.activity_ref_id = null;
                    sess.last_seen_at = new Date();
                    affected.push({ user_id: sess.user_id });
                }
            }
            return { rows: affected };
        }
        // ── clear activity (single session, with optional filter) ─────────
        if (/^UPDATE user_presence_sessions SET activity = NULL, activity_ref_id = NULL/i.test(s)) {
            const sessionKey = params[0];
            const onlyActivity = params[1];
            const sess = state.sessions.get(sessionKey);
            if (sess && !sess.disconnected_at) {
                if (onlyActivity && sess.activity !== onlyActivity) return { rows: [] };
                sess.activity = null;
                sess.activity_ref_id = null;
                sess.last_seen_at = new Date();
                return { rows: [{ user_id: sess.user_id }] };
            }
            return { rows: [] };
        }
        // ── close session (by session_key) ────────────────────────────────
        if (/^UPDATE user_presence_sessions SET disconnected_at = NOW\(\), activity = NULL.*WHERE session_key = \$1/i.test(s)) {
            const sess = state.sessions.get(params[0]);
            if (sess && !sess.disconnected_at) {
                sess.disconnected_at = new Date();
                sess.activity = null;
                sess.activity_ref_id = null;
                return { rows: [{ user_id: sess.user_id }] };
            }
            return { rows: [] };
        }
        // ── close all sessions for user ───────────────────────────────────
        if (/^UPDATE user_presence_sessions SET disconnected_at = NOW\(\), activity = NULL.*WHERE user_id = \$1/i.test(s)) {
            for (const sess of state.sessions.values()) {
                if (sess.user_id === params[0] && !sess.disconnected_at) {
                    sess.disconnected_at = new Date();
                    sess.activity = null;
                    sess.activity_ref_id = null;
                }
            }
            return { rows: [] };
        }
        // ── audit row ─────────────────────────────────────────────────────
        if (/^INSERT INTO user_status_events/i.test(s)) {
            state.events.push({
                user_id: params[0], source: params[1], from_state: params[2],
                to_state: params[3], session_key: params[4], metadata: params[5],
                created_at: new Date(),
            });
            return { rows: [] };
        }
        // ── broadcaster: select org + peers ───────────────────────────────
        if (/^SELECT org_id FROM users WHERE id = \$1$/i.test(s)) {
            const u = state.users.get(params[0]);
            return { rows: u ? [{ org_id: u.org_id }] : [] };
        }
        if (/^SELECT id FROM users WHERE org_id = \$1 AND id <> \$2 AND is_active = TRUE$/i.test(s)) {
            const [orgId, excludeId] = params;
            return {
                rows: [...state.users.values()]
                    .filter(u => u.org_id === orgId && u.id !== excludeId && u.is_active)
                    .map(u => ({ id: u.id })),
            };
        }

        throw new Error(`unhandled SQL in test fake: ${s.slice(0, 120)}`);
    }
    return { query, state };
}

beforeEach(() => { sentMessages.length = 0; });

describe('StatusService — full side-effect chain', () => {
    test('openSession → user becomes online (available)', async () => {
        const { query, state } = makeDb({ users: [{ id: 1 }, { id: 2 }] });
        const ctx = { db: { query }, tenantId: null };

        const payload = await statusService.openSession(ctx, { userId: 1, sessionKey: 'desk-1', deviceLabel: 'Desktop' });

        expect(payload).toMatchObject({
            userId: 1,
            effective: 'available',
            presence: 'online',
        });
        // Audit row written
        expect(state.events).toHaveLength(1);
        expect(state.events[0]).toMatchObject({ user_id: 1, source: 'session_open', to_state: 'available' });
        // Broadcast went to self + org peer
        expect(sentMessages.map(m => m.userId).sort()).toEqual([1, 2]);
        expect(sentMessages[0].type).toBe('user_status');
        expect(sentMessages[0].data.effective).toBe('available');
    });

    test('setManualStatus(dnd) reflects in effective state', async () => {
        const { query, state } = makeDb({ users: [{ id: 1 }] });
        const ctx = { db: { query }, tenantId: null, actorUserId: 1 };

        await statusService.openSession(ctx, { userId: 1, sessionKey: 'sess', deviceLabel: 'Web' });
        const payload = await statusService.setManualStatus(ctx, { status: 'dnd' });

        expect(payload.effective).toBe('dnd');
        expect(state.users.get(1).manual_status).toBe('dnd');
    });

    test('setSessionActivity(in_call) overrides manual dnd', async () => {
        const { query } = makeDb({ users: [{ id: 1 }] });
        const ctx = { db: { query }, tenantId: null, actorUserId: 1 };

        await statusService.openSession(ctx, { userId: 1, sessionKey: 'sess' });
        await statusService.setManualStatus(ctx, { status: 'dnd' });
        const payload = await statusService.setSessionActivity(ctx, 'sess', 'in_call', 42);

        expect(payload.effective).toBe('in_call');
        expect(payload.source).toBe('call');
    });

    test('clearSessionActivity reverts to manual choice', async () => {
        const { query } = makeDb({ users: [{ id: 1 }] });
        const ctx = { db: { query }, tenantId: null, actorUserId: 1 };

        await statusService.openSession(ctx, { userId: 1, sessionKey: 'sess' });
        await statusService.setManualStatus(ctx, { status: 'dnd' });
        await statusService.setSessionActivity(ctx, 'sess', 'in_call');
        const payload = await statusService.clearSessionActivity(ctx, 'sess', 'in_call');

        expect(payload.effective).toBe('dnd');
    });

    test('setPresencePreference(invisible) flips presence offline even with open session', async () => {
        const { query } = makeDb({ users: [{ id: 1 }] });
        const ctx = { db: { query }, tenantId: null, actorUserId: 1 };

        await statusService.openSession(ctx, { userId: 1, sessionKey: 'sess' });
        const payload = await statusService.setPresencePreference(ctx, 'invisible');

        expect(payload.effective).toBe('offline');
        expect(payload.presence).toBe('offline');
    });

    test('closeSession → user goes offline; closing all leaves them offline', async () => {
        const { query, state } = makeDb({ users: [{ id: 1 }] });
        const ctx = { db: { query }, tenantId: null, actorUserId: 1 };

        await statusService.openSession(ctx, { userId: 1, sessionKey: 's1' });
        await statusService.openSession(ctx, { userId: 1, sessionKey: 's2' });

        // Close one — other still open → still online.
        const stillOnline = await statusService.closeSession(ctx, 's1');
        expect(stillOnline.presence).toBe('online');

        // Close the last → offline.
        const offline = await statusService.closeSession(ctx, 's2');
        expect(offline.effective).toBe('offline');
        expect(offline.presence).toBe('offline');
    });

    test('getEffectiveBulk resolves multiple users in one call', async () => {
        const { query } = makeDb({ users: [{ id: 1 }, { id: 2 }, { id: 3 }] });
        const ctx = { db: { query }, tenantId: null };

        await statusService.openSession({ ...ctx, actorUserId: 1 }, { userId: 1, sessionKey: 'a' });
        await statusService.openSession({ ...ctx, actorUserId: 2 }, { userId: 2, sessionKey: 'b' });
        // user 3 has no session

        const out = await statusService.getEffectiveBulk(ctx, [1, 2, 3]);
        expect(out[1].effective).toBe('available');
        expect(out[2].effective).toBe('available');
        expect(out[3].effective).toBe('offline');
    });

    test('rejects invalid manual status', async () => {
        const { query } = makeDb({ users: [{ id: 1 }] });
        const ctx = { db: { query }, tenantId: null, actorUserId: 1 };
        await expect(statusService.setManualStatus(ctx, { status: 'in_call' }))
            .rejects.toThrow(/invalid status/);
    });

    test('rejects calls without ctx.db', async () => {
        await expect(statusService.setManualStatus({}, { status: 'busy' }))
            .rejects.toThrow(/ctx.db is required/);
    });
});

describe('StatusService — clearActivityForRef (call/meeting end)', () => {
    test('end of group call clears in_call for every participant in one sweep', async () => {
        const { query, state } = makeDb({ users: [{ id: 1 }, { id: 2 }, { id: 3 }] });
        const ctx = { db: { query }, tenantId: null };

        // Three users, each on the same call.
        await statusService.openSession({ ...ctx, actorUserId: 1 }, { userId: 1, sessionKey: 's1' });
        await statusService.openSession({ ...ctx, actorUserId: 2 }, { userId: 2, sessionKey: 's2' });
        await statusService.openSession({ ...ctx, actorUserId: 3 }, { userId: 3, sessionKey: 's3' });
        await statusService.setSessionActivity(ctx, 's1', 'in_call', 42);
        await statusService.setSessionActivity(ctx, 's2', 'in_call', 42);
        await statusService.setSessionActivity(ctx, 's3', 'in_call', 42);

        // All three are in_call.
        let map = await statusService.getEffectiveBulk(ctx, [1, 2, 3]);
        expect(map[1].effective).toBe('in_call');
        expect(map[2].effective).toBe('in_call');
        expect(map[3].effective).toBe('in_call');

        // Sweep on call_end.
        const results = await statusService.clearActivityForRef(ctx, 'in_call', 42);
        expect(results).toHaveLength(3);
        expect(results.every(r => r.effective === 'available')).toBe(true);

        // Audit captured a row per user, sourced as 'call'.
        const callEndEvents = state.events.filter(e => e.source === 'call' && e.to_state === 'available');
        expect(callEndEvents.map(e => e.user_id).sort()).toEqual([1, 2, 3]);
    });

    test('clearActivityForRef does not affect sessions on a different call', async () => {
        const { query } = makeDb({ users: [{ id: 1 }, { id: 2 }] });
        const ctx = { db: { query }, tenantId: null };

        await statusService.openSession({ ...ctx, actorUserId: 1 }, { userId: 1, sessionKey: 'a' });
        await statusService.openSession({ ...ctx, actorUserId: 2 }, { userId: 2, sessionKey: 'b' });
        await statusService.setSessionActivity(ctx, 'a', 'in_call', 100);
        await statusService.setSessionActivity(ctx, 'b', 'in_call', 200);

        await statusService.clearActivityForRef(ctx, 'in_call', 100);

        const map = await statusService.getEffectiveBulk(ctx, [1, 2]);
        expect(map[1].effective).toBe('available'); // cleared
        expect(map[2].effective).toBe('in_call');   // still on call 200
    });

    test('meeting end clears in_meeting but not a separate in_call on the same user', async () => {
        const { query } = makeDb({ users: [{ id: 1 }] });
        const ctx = { db: { query }, tenantId: null, actorUserId: 1 };

        // User is on a call on desktop AND in a meeting on phone (different sessions).
        await statusService.openSession(ctx, { userId: 1, sessionKey: 'desktop' });
        await statusService.openSession(ctx, { userId: 1, sessionKey: 'phone' });
        await statusService.setSessionActivity(ctx, 'desktop', 'in_call', 7);
        await statusService.setSessionActivity(ctx, 'phone', 'in_meeting', 9);

        // Resolver precedence: in_call wins over in_meeting.
        let payload = await statusService.getEffective(ctx, 1);
        expect(payload.effective).toBe('in_call');

        // End the meeting → user should still be in_call from the desktop session.
        await statusService.clearActivityForRef(ctx, 'in_meeting', 9);
        payload = await statusService.getEffective(ctx, 1);
        expect(payload.effective).toBe('in_call');

        // Now end the call → user falls back to default (available).
        await statusService.clearActivityForRef(ctx, 'in_call', 7);
        payload = await statusService.getEffective(ctx, 1);
        expect(payload.effective).toBe('available');
    });
});

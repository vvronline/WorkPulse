/**
 * Status Service — constants.
 *
 * INVARIANTS:
 *   • This file is the single source of truth for every status enum/threshold.
 *   • If a value isn't listed here, it's invalid. Period.
 *   • Mirror any client-visible values in `client/src/status/constants.js`.
 */

// ─── Manual status (user preference) ─────────────────────────────────────────
// `null` means "no manual preference" → resolver falls back to 'available'.
const MANUAL_STATUSES = Object.freeze(['available', 'busy', 'dnd', 'brb']);

// ─── Presence preference ─────────────────────────────────────────────────────
// 'auto'      → online iff at least one open session.
// 'invisible' → always reported as offline, regardless of open sessions.
const PRESENCE_PREFERENCES = Object.freeze(['auto', 'invisible']);

// ─── Per-session activity ────────────────────────────────────────────────────
const ACTIVITIES = Object.freeze(['in_call', 'in_meeting']);

// ─── Effective status values returned by the resolver ────────────────────────
const EFFECTIVE_STATUSES = Object.freeze([
    'available',
    'busy',
    'dnd',
    'brb',
    'away',
    'in_call',
    'in_meeting',
    'offline',
]);

// ─── Resolver "source" tags — written to user_status_events ──────────────────
const SOURCES = Object.freeze([
    'user',          // explicit user action (StatusPicker)
    'idle',          // resolver computed idle/away
    'call',          // call handler set/cleared activity
    'meeting',       // meeting handler set/cleared activity
    'session_open',  // WS connect
    'session_close', // WS disconnect
    'logout',        // logout endpoint closed a session
    'clock_out',     // tracker clock-out closed a session
    'system',        // anything else (migrations, admin tools)
]);

// ─── Time thresholds (ms) ────────────────────────────────────────────────────
const IDLE_AWAY_MS = 5 * 60 * 1000;        // user with no input for 5 min → away
const SESSION_STALE_MS = 90 * 1000;        // session not pinged in 90s → treat as gone

// ─── Redis TTLs (seconds) ────────────────────────────────────────────────────
const CACHE_TTL_SEC = 60 * 60;             // 1h — recomputed eagerly on writes

// ─── Helpers ─────────────────────────────────────────────────────────────────
const isManualStatus = (v) => v === null || MANUAL_STATUSES.includes(v);
const isPresencePreference = (v) => PRESENCE_PREFERENCES.includes(v);
const isActivity = (v) => v === null || ACTIVITIES.includes(v);
const isSource = (v) => SOURCES.includes(v);

module.exports = {
    MANUAL_STATUSES,
    PRESENCE_PREFERENCES,
    ACTIVITIES,
    EFFECTIVE_STATUSES,
    SOURCES,
    IDLE_AWAY_MS,
    SESSION_STALE_MS,
    CACHE_TTL_SEC,
    isManualStatus,
    isPresencePreference,
    isActivity,
    isSource,
};
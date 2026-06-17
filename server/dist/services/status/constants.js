"use strict";
/**
 * Status Service — constants.
 *
 * INVARIANTS:
 *   • This file is the single source of truth for every status enum/threshold.
 *   • If a value isn't listed here, it's invalid. Period.
 *   • Mirror any client-visible values in `client/src/status/constants.js`.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.isSource = exports.isActivity = exports.isPresencePreference = exports.isManualStatus = exports.CACHE_TTL_SEC = exports.SESSION_STALE_MS = exports.IDLE_AWAY_MS = exports.SOURCES = exports.EFFECTIVE_STATUSES = exports.ACTIVITIES = exports.PRESENCE_PREFERENCES = exports.MANUAL_STATUSES = void 0;
// ─── Manual status (user preference) ─────────────────────────────────────────
// `null` means "no manual preference" → resolver falls back to 'available'.
const MANUAL_STATUSES = Object.freeze(["available", "busy", "dnd", "brb"]);
exports.MANUAL_STATUSES = MANUAL_STATUSES;
// ─── Presence preference ─────────────────────────────────────────────────────
// 'auto'      → online iff at least one open session.
// 'invisible' → always reported as offline, regardless of open sessions.
const PRESENCE_PREFERENCES = Object.freeze(["auto", "invisible"]);
exports.PRESENCE_PREFERENCES = PRESENCE_PREFERENCES;
// ─── Per-session activity ────────────────────────────────────────────────────
const ACTIVITIES = Object.freeze(["in_call", "in_meeting"]);
exports.ACTIVITIES = ACTIVITIES;
// ─── Effective status values returned by the resolver ────────────────────────
const EFFECTIVE_STATUSES = Object.freeze([
    "available",
    "busy",
    "dnd",
    "brb",
    "away",
    "in_call",
    "in_meeting",
    "offline",
]);
exports.EFFECTIVE_STATUSES = EFFECTIVE_STATUSES;
// ─── Resolver "source" tags — written to user_status_events ──────────────────
const SOURCES = Object.freeze([
    "user", // explicit user action (StatusPicker)
    "idle", // resolver computed idle/away
    "call", // call handler set/cleared activity
    "meeting", // meeting handler set/cleared activity
    "session_open", // WS connect
    "session_close", // WS disconnect
    "logout", // logout endpoint closed a session
    "clock_out", // tracker clock-out closed a session
    "system", // anything else (migrations, admin tools)
]);
exports.SOURCES = SOURCES;
// ─── Time thresholds (ms) ────────────────────────────────────────────────────
const IDLE_AWAY_MS = 5 * 60 * 1000; // user with no input for 5 min → away
exports.IDLE_AWAY_MS = IDLE_AWAY_MS;
const SESSION_STALE_MS = 90 * 1000; // session not pinged in 90s → treat as gone
exports.SESSION_STALE_MS = SESSION_STALE_MS;
// ─── Redis TTLs (seconds) ────────────────────────────────────────────────────
const CACHE_TTL_SEC = 60 * 60; // 1h — recomputed eagerly on writes
exports.CACHE_TTL_SEC = CACHE_TTL_SEC;
// ─── Helpers ─────────────────────────────────────────────────────────────────
const isManualStatus = (v) => v === null || MANUAL_STATUSES.includes(v);
exports.isManualStatus = isManualStatus;
const isPresencePreference = (v) => PRESENCE_PREFERENCES.includes(v);
exports.isPresencePreference = isPresencePreference;
const isActivity = (v) => v === null || ACTIVITIES.includes(v);
exports.isActivity = isActivity;
const isSource = (v) => SOURCES.includes(v);
exports.isSource = isSource;
//# sourceMappingURL=constants.js.map
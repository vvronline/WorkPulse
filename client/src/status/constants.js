/**
 * Client-side status constants.
 *
 * INVARIANTS:
 *   • Mirrors `server/services/status/constants.js` for enum values.
 *     Any divergence is a bug — the server is the source of truth.
 *   • UI-only metadata (labels, colors, icons) lives ONLY here; do not
 *     duplicate it in individual components.
 */

// ─── Manual statuses (user-pickable) ─────────────────────────────────────────
// `null` means "no preference" — resolver falls back to 'available'.
export const MANUAL_STATUSES = ['available', 'busy', 'dnd', 'brb'];

// ─── Presence preferences ────────────────────────────────────────────────────
export const PRESENCE_PREFERENCES = ['auto', 'invisible'];

// ─── Effective statuses returned by the server resolver ──────────────────────
export const EFFECTIVE_STATUSES = [
    'available',
    'busy',
    'dnd',
    'brb',
    'away',
    'in_call',
    'in_meeting',
    'offline',
];

// ─── Per-status UI metadata ──────────────────────────────────────────────────
// Used by StatusPicker, ChatAvatar dot, navbar trigger, etc.
//
// `kind` distinguishes how the dot/icon should be styled:
//   solid      — filled circle in `color`
//   ring       — hollow ring (used for "offline" / "invisible")
//   pulse      — animated dot (used for live activities)
// `pickable` controls whether the user can choose this from StatusPicker
//   (false for derived statuses: away/in_call/in_meeting/offline).
export const STATUS_META = {
    available: { label: 'Available', color: '#22c55e', kind: 'solid', pickable: true, icon: 'check' },
    busy: { label: 'Busy', color: '#ef4444', kind: 'solid', pickable: true, icon: 'dot' },
    dnd: { label: 'Do Not Disturb', color: '#ef4444', kind: 'solid', pickable: true, icon: 'minus' },
    // `brb` is the user-pickable amber status. We label it "Away" because
    // that's the term every other tool uses; the underlying key stays `brb`
    // to distinguish it from the server-derived `away` (set by the resolver
    // when last_activity_at is stale). Both render identically in the UI —
    // see client/src/components/chat/ChatAvatar.jsx STATUS_CONFIG.
    brb: { label: 'Away', color: '#f59e0b', kind: 'solid', pickable: true, icon: 'clock' },

    away: { label: 'Away (idle)', color: '#f59e0b', kind: 'solid', pickable: false, icon: 'clock', auto: true },
    in_call: { label: 'In a Call', color: '#ef4444', kind: 'pulse', pickable: false, icon: 'phone', auto: true },
    in_meeting: { label: 'In a Meeting', color: '#0ea5e9', kind: 'pulse', pickable: false, icon: 'video', auto: true },
    offline: { label: 'Offline', color: '#64748b', kind: 'ring', pickable: false, icon: 'ring' },
};

// Picker list — used by StatusPicker to render selectable rows.
// The "Appear Offline" toggle is separate (it's a presence preference,
// not a manual status) so it's NOT in this list.
export const PICKABLE_STATUSES = MANUAL_STATUSES.map(key => ({
    key,
    ...STATUS_META[key],
}));

// ─── Activity ping cadence ───────────────────────────────────────────────────
// Sent on real input (mousemove / keypress, throttled). The server uses
// `last_activity_at` to compute idle/away.
export const ACTIVITY_PING_THROTTLE_MS = 60 * 1000; // 1 minute
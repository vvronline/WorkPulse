"use strict";
/**
 * Meeting permissions — single source of truth for "can user X do action A
 * in meeting M?".
 *
 * Why this module exists
 * ──────────────────────
 * Before this file the rules were scattered across `routes/meetings.js`
 * (HTTP) and `utils/ws.js` (WebSocket):
 *
 *   - `meeting.created_by === req.userId` checks, repeated 7 times in
 *     meetings.js + 4 times in ws.js
 *   - `Only organizer can add participants` / `Only organizer can mute`
 *     etc — same logic, different copy-pasted error strings
 *   - One action (`startBroadcast`) had an `allowAnyBroadcaster` opt-in
 *     baked into the meeting's `settings` JSONB blob, but nothing else
 *     respected that pattern
 *
 * A new requirement — "let organisers pre-configure a 'webinar' preset
 * where attendees can't unmute themselves or share screen" — would have
 * needed touching all those call-sites individually, each with its own
 * subtly different conditional. That's how permission bugs ship.
 *
 * Design
 * ──────
 * One public function:
 *
 *     can(user, meeting, action) → boolean
 *
 * `user`    = { userId, role? }  (role optional; used for org admins)
 * `meeting` = the meetings row, including `created_by` + `settings`
 *             (settings JSONB is where presets live)
 * `action`  = one of the ACTIONS constants below
 *
 * Presets live in `meeting.settings.preset` (string) and act as the
 * defaults; individual settings flags inside `meeting.settings` can
 * override the preset on a per-action basis. The PRESETS table at the
 * bottom of this file is the only thing a caller adding a NEW action
 * needs to touch.
 *
 * Backwards compatibility
 * ───────────────────────
 * Default preset = 'standard', which matches the rules that were
 * hard-coded everywhere before. So unless a meeting was explicitly
 * created with a different preset, behaviour is identical to today.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.listPresets = exports.DEFAULT_PRESET = exports.PRESETS = exports.ACTIONS = void 0;
exports.can = can;
exports.describePreset = describePreset;
/**
 * The canonical set of actions. Anything callable through the meeting
 * routes / WS handlers SHOULD funnel through `can()` with one of these
 * — adding a new action means adding a new entry here + the matching
 * decision in `evaluate` below + an entry in every preset.
 */
const ACTIONS = Object.freeze({
    /** Update title / description / settings on the meeting record. */
    EDIT: "edit",
    /** End the meeting for everybody (sets status=ended for all participants). */
    END_FOR_ALL: "end_for_all",
    /** Invite a new user to a meeting that's already started. */
    ADD_PARTICIPANT: "add_participant",
    /** Remotely mute another participant. */
    MUTE_OTHERS: "mute_others",
    /** Start the broadcast / recording layer. */
    START_BROADCAST: "start_broadcast",
    /** Toggle one's OWN mic (relevant when meeting forces mute-only). */
    UNMUTE_SELF: "unmute_self",
    /** Share screen. */
    SHARE_SCREEN: "share_screen",
    /** Send chat in the meeting. */
    SEND_CHAT: "send_chat",
});
exports.ACTIONS = ACTIONS;
/**
 * The official preset registry. Each preset is a map of
 *   action → { everyone?: boolean, host?: boolean, override?: settingsKey }
 *
 * - `host: true`            → only the meeting's `created_by` user
 * - `everyone: true`        → every joined participant
 * - `override: 'fooKey'`    → if `meeting.settings.fooKey === true|false`,
 *                             use that boolean to override the default
 *
 * `everyone` wins over `host` when both are present (an "everyone can"
 * preset trivially includes the host).
 *
 * The names are deliberately user-meaningful so the UI can render them
 * verbatim in a dropdown.
 */
const PRESETS = Object.freeze({
    /**
     * Default — matches the pre-presets behaviour:
     *   • host can edit, end, add, mute, start broadcast
     *   • everyone can unmute themselves, share screen, chat
     */
    standard: {
        [ACTIONS.EDIT]: { host: true },
        [ACTIONS.END_FOR_ALL]: { host: true },
        [ACTIONS.ADD_PARTICIPANT]: { host: true },
        [ACTIONS.MUTE_OTHERS]: { host: true },
        [ACTIONS.START_BROADCAST]: { host: true, override: "allowAnyBroadcaster" },
        [ACTIONS.UNMUTE_SELF]: { everyone: true },
        [ACTIONS.SHARE_SCREEN]: { everyone: true },
        [ACTIONS.SEND_CHAT]: { everyone: true },
    },
    /**
     * Webinar — large, organiser-led: attendees can't unmute, can't
     * share screen, can't talk in chat. Useful for AMAs, all-hands etc.
     */
    webinar: {
        [ACTIONS.EDIT]: { host: true },
        [ACTIONS.END_FOR_ALL]: { host: true },
        [ACTIONS.ADD_PARTICIPANT]: { host: true },
        [ACTIONS.MUTE_OTHERS]: { host: true },
        [ACTIONS.START_BROADCAST]: { host: true },
        [ACTIONS.UNMUTE_SELF]: { host: true },
        [ACTIONS.SHARE_SCREEN]: { host: true },
        [ACTIONS.SEND_CHAT]: { everyone: true },
    },
    /**
     * Open — community-style: everyone can do almost everything except
     * the destructive actions (end, edit). Good fit for stand-ups +
     * pair-programming.
     */
    open: {
        [ACTIONS.EDIT]: { host: true },
        [ACTIONS.END_FOR_ALL]: { host: true },
        [ACTIONS.ADD_PARTICIPANT]: { everyone: true },
        [ACTIONS.MUTE_OTHERS]: { everyone: true },
        [ACTIONS.START_BROADCAST]: { everyone: true },
        [ACTIONS.UNMUTE_SELF]: { everyone: true },
        [ACTIONS.SHARE_SCREEN]: { everyone: true },
        [ACTIONS.SEND_CHAT]: { everyone: true },
    },
});
exports.PRESETS = PRESETS;
const DEFAULT_PRESET = "standard";
exports.DEFAULT_PRESET = DEFAULT_PRESET;
/** Internal — resolve the preset map, falling back safely. */
function resolvePreset(meeting) {
    const settings = (meeting && meeting.settings) || {};
    const name = typeof settings.preset === "string" && PRESETS[settings.preset]
        ? settings.preset
        : DEFAULT_PRESET;
    return { name, map: PRESETS[name] };
}
const ACTIONS_SET = new Set(Object.values(ACTIONS));
/**
 * Decide if `user` may perform `action` on `meeting`.
 *
 * Returns `false` (closed-by-default) on any missing input — never
 * throws. This is on purpose: we are the LAST line of defense before
 * a destructive operation; raising here would convert "this request
 * shouldn't be allowed" into an unhelpful 500.
 */
function can(user, meeting, action) {
    if (!user || !meeting || !action)
        return false;
    if (!user.userId)
        return false;
    if (!ACTIONS_SET.has(action))
        return false;
    const { map } = resolvePreset(meeting);
    const rule = map[action];
    if (!rule)
        return false;
    // 1. Settings override wins if set (boolean true → everyone, false → host)
    if (rule.override) {
        const v = meeting.settings && meeting.settings[rule.override];
        if (typeof v === "boolean") {
            return v ? true : meeting.created_by === user.userId;
        }
    }
    // 2. Preset-level decisions
    if (rule.everyone)
        return true;
    if (rule.host)
        return meeting.created_by === user.userId;
    return false;
}
/**
 * Convenience wrapper for HTTP handlers — returns the resolved preset
 * descriptor so the route can include it in a 200 response. Cheap.
 */
function describePreset(meeting) {
    const { name, map } = resolvePreset(meeting);
    return { name, rules: map };
}
/** Test-only — list every known preset name. */
const listPresets = () => Object.keys(PRESETS);
exports.listPresets = listPresets;
//# sourceMappingURL=meetingPermissions.js.map
/**
 * Meeting connection finite-state machine.
 *
 * Why this exists
 * ───────────────
 * Until now `useMeetingState` exposed a flat `status` string with five
 * informally-defined values (`joining` | `connecting` | `connected` |
 * `ended` | `left` | `failed`). Different code paths flipped it freely
 * and a few transitions weren't quite right — e.g. a single peer
 * transitioning to `disconnected` would flicker the global status away
 * from `connected` and back, briefly showing the user a misleading
 * "Reconnecting…" banner during normal mesh churn.
 *
 * This module:
 *   1. Names the legal states + transitions in one place.
 *   2. Provides `nextState(current, event)` so call sites can't enter
 *      an undefined state by accident.
 *   3. Computes a single user-facing label + degraded-mode hint that
 *      the UI renders verbatim.
 *
 * Phase 4 will move `currentState` into the Zustand store; for Phase 1
 * the FSM is a pure helper so it's trivially testable and adds zero
 * runtime overhead when not subscribed to.
 *
 * States
 *   idle          — hook mounted, media not yet acquired
 *   joining       — sent meeting_join, awaiting first participant info
 *   connecting    — at least one peer connection in 'connecting' /
 *                   'new' / 'checking' state, none yet 'connected'
 *   connected     — at least one peer in 'connected', no peer in
 *                   'disconnected' / 'failed' for > 2s
 *   reconnecting  — every peer was 'connected' but at least one
 *                   transitioned to 'disconnected' or 'failed' AND the
 *                   WS is currently OPEN (otherwise we'd be in
 *                   `degraded` instead).
 *   degraded      — WS is CLOSING/CLOSED or the network has flipped
 *                   offline. Distinct from `reconnecting` because the
 *                   recovery action and the UI banner are different.
 *   left          — local user called leaveMeeting()
 *   ended         — meeting ended by host or last participant
 *   failed        — terminal — media acquisition failed at join time
 *
 * Events (sources): `media_acquired`, `join_sent`, `participant_joined`,
 * `peer_connected`, `peer_disconnected`, `peer_failed`, `ws_open`,
 * `ws_close`, `network_offline`, `network_online`, `leave`, `end`,
 * `media_failed`.
 */

export const STATES = Object.freeze({
    IDLE: 'idle',
    JOINING: 'joining',
    CONNECTING: 'connecting',
    CONNECTED: 'connected',
    RECONNECTING: 'reconnecting',
    DEGRADED: 'degraded',
    LEFT: 'left',
    ENDED: 'ended',
    FAILED: 'failed',
});

// Terminal states never accept new events.
const TERMINAL = new Set([STATES.LEFT, STATES.ENDED, STATES.FAILED]);

/**
 * Pure state transition. Returns the next state (which may be equal to
 * `current`). Unknown events are no-ops — by design — so call sites can
 * safely fire telemetry events without worrying about the FSM.
 */
export function nextState(current, event) {
    if (TERMINAL.has(current)) return current;

    switch (event) {
        case 'leave': return STATES.LEFT;
        case 'end': return STATES.ENDED;
        case 'media_failed': return STATES.FAILED;

        case 'media_acquired':
            return current === STATES.IDLE ? STATES.JOINING : current;

        case 'join_sent':
            return current === STATES.IDLE || current === STATES.JOINING
                ? STATES.JOINING : current;

        case 'participant_joined':
            // First peer info from server — we're now actively connecting.
            return current === STATES.JOINING ? STATES.CONNECTING : current;

        case 'peer_connected':
            // Any peer becoming connected immediately clears reconnecting/
            // degraded states. This intentionally collapses transient mesh
            // churn into a stable "connected" view.
            return STATES.CONNECTED;

        case 'peer_disconnected':
        case 'peer_failed':
            // Only flip into reconnecting if we WERE connected — a peer
            // failing during initial connect leaves us in `connecting`.
            return current === STATES.CONNECTED ? STATES.RECONNECTING : current;

        case 'ws_close':
        case 'network_offline':
            // WS-level / network-level loss is more severe than peer churn.
            // We always show the user a degraded banner here so they know
            // the app itself (not just one peer) lost connectivity.
            return current === STATES.IDLE ? STATES.IDLE : STATES.DEGRADED;

        case 'ws_open':
        case 'network_online':
            // Coming back online: drop back to `connecting` so the user
            // gets a clear "we're reconnecting your peers" indicator
            // before any peer_connected event flips us to `connected`.
            return current === STATES.DEGRADED ? STATES.CONNECTING : current;

        default:
            return current;
    }
}

/**
 * Human-facing label + severity for the degraded-mode banner.
 *
 * Severity drives the banner styling:
 *   info | warn | error
 */
export function describeState(state) {
    switch (state) {
        case STATES.IDLE: return { label: 'Preparing camera…', severity: 'info', showBanner: false };
        case STATES.JOINING: return { label: 'Joining…', severity: 'info', showBanner: false };
        case STATES.CONNECTING: return { label: 'Connecting…', severity: 'info', showBanner: false };
        case STATES.CONNECTED: return { label: 'Connected', severity: 'info', showBanner: false };
        case STATES.RECONNECTING: return { label: 'Reconnecting to a participant…', severity: 'warn', showBanner: true };
        case STATES.DEGRADED: return { label: 'You appear to be offline — trying to reconnect…', severity: 'warn', showBanner: true };
        case STATES.LEFT: return { label: 'You left the meeting', severity: 'info', showBanner: false };
        case STATES.ENDED: return { label: 'Meeting ended', severity: 'info', showBanner: false };
        case STATES.FAILED: return { label: 'Unable to join — please check camera/mic permissions', severity: 'error', showBanner: true };
        default: return { label: '', severity: 'info', showBanner: false };
    }
}
/**
 * Status Service — pure resolver functions.
 *
 * INVARIANTS:
 *   • No I/O. Ever. Not DB, not Redis, not network, not `Date.now()`.
 *     Time is always passed in as `now` so tests are deterministic.
 *   • Returns ARE pure values: never mutate inputs.
 *   • Every decision branch is covered by `__tests__/resolver.spec.js`.
 *
 * Why pure?
 *   Anyone debugging "why does Alice show as Away?" can paste the inputs
 *   from `users` + `user_sessions` into a unit test and watch the
 *   resolver run — no Postgres, no Redis, no mocks needed.
 */

import {
    ACTIVITIES,
    IDLE_AWAY_MS,
    SESSION_STALE_MS,
    isManualStatus,
    isPresencePreference,
} from "./constants";
import type { Activity, EffectiveStatus, ManualStatus, PresencePreference, Source } from "./constants";

export interface SessionInput {
    sessionKey: string | number;
    disconnectedAt?: Date | string | null;
    lastSeenAt?: Date | string | null;
    activity?: Activity | null;
    [key: string]: unknown;
}

export interface ResolverInput {
    sessions?: SessionInput[];
    manualStatus?: ManualStatus | null;
    presencePreference?: PresencePreference;
    lastActivityAt?: Date | string | null;
    now: Date;
}

export interface ResolvedStatus {
    effective: EffectiveStatus;
    presence: "online" | "offline";
    source: Source;
}

/** Coerce Date|string|number → epoch ms. */
function toMs(value: Date | string | number | null | undefined): number {
    if (value == null) return 0;
    if (value instanceof Date) return value.getTime();
    if (typeof value === "number") return value;
    const d = new Date(value);
    return Number.isFinite(d.getTime()) ? d.getTime() : 0;
}

/** Filter sessions that are currently considered open (not stale, not closed). */
function getOpenSessions(sessions: SessionInput[] | undefined, now: Date): SessionInput[] {
    if (!Array.isArray(sessions)) return [];
    const nowMs = toMs(now);
    return sessions.filter((s) => {
        if (!s) return false;
        if (s.disconnectedAt) return false;
        if (s.lastSeenAt && nowMs - toMs(s.lastSeenAt) > SESSION_STALE_MS) return false;
        return true;
    });
}

/** Did any open session report this activity? */
function anySessionHasActivity(openSessions: SessionInput[], activity: Activity): boolean {
    return openSessions.some((s) => s.activity === activity);
}

/** True if no input for IDLE_AWAY_MS. */
function isIdle(lastActivityAt: Date | string | null | undefined, now: Date): boolean {
    const last = toMs(lastActivityAt);
    if (!last) return false; // unknown → don't auto-away
    return toMs(now) - last >= IDLE_AWAY_MS;
}

/**
 * The one and only state machine.
 */
function resolveEffective(input: ResolverInput): ResolvedStatus {
    const {
        sessions = [],
        manualStatus = null,
        presencePreference = "auto",
        lastActivityAt = null,
        now,
    } = input;

    if (!(now instanceof Date)) {
        throw new TypeError("resolveEffective: `now` must be a Date");
    }
    if (!isManualStatus(manualStatus)) {
        throw new TypeError(`resolveEffective: invalid manualStatus "${manualStatus}"`);
    }
    if (!isPresencePreference(presencePreference)) {
        throw new TypeError(`resolveEffective: invalid presencePreference "${presencePreference}"`);
    }

    const openSessions = getOpenSessions(sessions, now);

    // 1) Offline cases — either no sessions or user chose "Appear Offline".
    if (openSessions.length === 0) {
        return { effective: "offline", presence: "offline", source: "session_close" };
    }
    if (presencePreference === "invisible") {
        return { effective: "offline", presence: "offline", source: "user" };
    }

    // 2) Activity wins (call > meeting). Order matters — keep in sync with constants.ACTIVITIES.
    for (const activity of ACTIVITIES) {
        if (anySessionHasActivity(openSessions, activity)) {
            return { effective: activity, presence: "online", source: activity === "in_call" ? "call" : "meeting" };
        }
    }

    // 3) Hard manual states (dnd / busy / brb) override idle.
    if (manualStatus === "dnd" || manualStatus === "busy" || manualStatus === "brb") {
        return { effective: manualStatus, presence: "online", source: "user" };
    }

    // 4) Idle/away — only when no hard manual state.
    if (isIdle(lastActivityAt, now)) {
        return { effective: "away", presence: "online", source: "idle" };
    }

    // 5) Default — explicit "available" or no preference at all.
    return {
        effective: manualStatus || "available",
        presence: "online",
        source: manualStatus ? "user" : "system",
    };
}

// Exported for testing & for debug endpoints — never call from app code.
const _internal = { getOpenSessions, anySessionHasActivity, isIdle, toMs };

export { resolveEffective, _internal };

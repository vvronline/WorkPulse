/**
 * Pure-function tests for the meeting connection FSM.
 * The FSM is intentionally event-driven and side-effect free, so all
 * assertions can be made by feeding events into `nextState` and reading
 * the resulting label out of `describeState`.
 */
import { describe, it, expect } from "vitest";
import {
    STATES,
    nextState,
    describeState,
    type MeetingState,
} from "../pages/meeting/connectionStateMachine";

describe("connectionStateMachine", () => {
    it("starts idle and walks the happy path", () => {
        let s: MeetingState = STATES.IDLE;
        s = nextState(s, "media_acquired");
        expect(s).toBe(STATES.JOINING);
        s = nextState(s, "join_sent");
        expect(s).toBe(STATES.JOINING);
        s = nextState(s, "participant_joined");
        expect(s).toBe(STATES.CONNECTING);
        s = nextState(s, "peer_connected");
        expect(s).toBe(STATES.CONNECTED);
        expect(describeState(s).showBanner).toBe(false);
    });

    it("transitions to reconnecting on peer_disconnected only when previously connected", () => {
        // From connecting: a peer dropping doesn't flip us into reconnecting.
        expect(nextState(STATES.CONNECTING, "peer_disconnected")).toBe(STATES.CONNECTING);
        expect(nextState(STATES.CONNECTING, "peer_failed")).toBe(STATES.CONNECTING);
        // From connected: it does.
        expect(nextState(STATES.CONNECTED, "peer_disconnected")).toBe(STATES.RECONNECTING);
        expect(nextState(STATES.CONNECTED, "peer_failed")).toBe(STATES.RECONNECTING);
    });

    it("a fresh peer_connected event collapses reconnecting back to connected", () => {
        expect(nextState(STATES.RECONNECTING, "peer_connected")).toBe(STATES.CONNECTED);
        expect(describeState(STATES.RECONNECTING).showBanner).toBe(true);
        expect(describeState(STATES.RECONNECTING).severity).toBe("warn");
    });

    it("ws_close / network_offline → degraded (banner shown)", () => {
        const s = nextState(STATES.CONNECTED, "ws_close");
        expect(s).toBe(STATES.DEGRADED);
        const d = describeState(s);
        expect(d.showBanner).toBe(true);
        expect(d.severity).toBe("warn");
    });

    it("ws_open on degraded → connecting (back-pressure indicator before peer_connected fires)", () => {
        const s1 = nextState(STATES.DEGRADED, "ws_open");
        expect(s1).toBe(STATES.CONNECTING);
        const s2 = nextState(STATES.DEGRADED, "network_online");
        expect(s2).toBe(STATES.CONNECTING);
    });

    it("terminal states are sticky — no event can revive them", () => {
        for (const term of [STATES.LEFT, STATES.ENDED, STATES.FAILED]) {
            expect(nextState(term, "peer_connected")).toBe(term);
            expect(nextState(term, "ws_open")).toBe(term);
            expect(nextState(term, "media_failed")).toBe(term);
        }
    });

    it("idle stays idle on noise events", () => {
        // Network/WS events on a freshly-mounted hook (still idle) must
        // not surface a false "Reconnecting…" banner — the user hasn't
        // even joined yet.
        expect(nextState(STATES.IDLE, "ws_close")).toBe(STATES.IDLE);
        expect(nextState(STATES.IDLE, "network_offline")).toBe(STATES.IDLE);
    });

    it("describeState always returns a usable shape", () => {
        for (const s of Object.values(STATES)) {
            const d = describeState(s);
            expect(typeof d.label).toBe("string");
            expect(["info", "warn", "error"]).toContain(d.severity);
            expect(typeof d.showBanner).toBe("boolean");
        }
    });
});
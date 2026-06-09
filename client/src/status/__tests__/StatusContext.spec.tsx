/**
 * Behaviour tests for the v2 StatusContext.
 *
 * Locks in: initial fetch → state, peer map merging, 'user_status' WS
 * event handling for self vs others, legacy event fallback, and the
 * setManualStatus / setInvisible mutators.
 */

import React from "react";
import { describe, test, expect, vi, beforeEach } from "vitest";
import { render, act, waitFor } from "@testing-library/react";

// ── Mocks ────────────────────────────────────────────────────────────────────
// AuthContext: pretend we're logged in as user 1.
vi.mock("../../AuthContext", () => ({
    useAuth: () => ({ user: { id: 1 }, isAuthenticated: true }),
    AuthProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

// useWebSocket: capture the message handler so the test can fire events.
let wsHandler: ((msg: any) => void) | null = null;
vi.mock("../../hooks/useWebSocket", () => ({
    default: (onMessage: (msg: any) => void) => {
        wsHandler = onMessage;
        return { sendMessage: vi.fn(), readyState: 1 };
    },
}));

// The status/api module — record calls, allow per-test responses.
// NOTE: vi.mock is hoisted to the top of the file, so the factory must
// close over no in-scope variables. We define stubs inside the factory
// and reach them via vi.mocked() in the tests.
vi.mock("../api", () => ({
    getMyStatus: vi.fn(),
    setMyStatus: vi.fn(),
    setPresencePreference: vi.fn(),
    sendActivityPing: vi.fn().mockResolvedValue({}),
}));

// Now import the unit under test AFTER the mocks are registered.
import { StatusProvider } from "../StatusContext";
import { useStatus } from "../useStatus";
import * as apiModule from "../api";
const apiMock = apiModule as any;

// Helper component that exposes the hook value via render prop.
function Probe({ onValue }: { onValue: (v: any) => void }) {
    const value = useStatus();
    React.useEffect(() => {
        onValue(value);
    }, [value, onValue]);
    return null;
}

function mount(captured: any) {
    return render(
        <StatusProvider>
            <Probe
                onValue={(v) => {
                    captured.value = v;
                }}
            />
        </StatusProvider>
    );
}

beforeEach(() => {
    wsHandler = null;
    apiMock.getMyStatus.mockReset();
    apiMock.setMyStatus.mockReset();
    apiMock.setPresencePreference.mockReset();
    apiMock.sendActivityPing.mockClear();
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe("StatusContext — initial fetch", () => {
    test("fetches /api/me/status on mount and seeds state", async () => {
        apiMock.getMyStatus.mockResolvedValueOnce({
            data: {
                userId: 1,
                effective: "busy",
                presence: "online",
                manualStatus: "busy",
                presencePreference: "auto",
                statusMessage: "In a meeting",
                statusMessageExpiresAt: null,
                source: "user",
            },
        });
        const cap: any = {};
        mount(cap);
        await waitFor(() => expect(cap.value?.effective).toBe("busy"));
        expect(cap.value.manualStatus).toBe("busy");
        expect(cap.value.statusMessage).toBe("In a meeting");
        // Self also lands in peer map.
        expect(cap.value.peers[1].effective).toBe("busy");
    });

    test("tolerates an initial fetch error", async () => {
        apiMock.getMyStatus.mockRejectedValueOnce(new Error("boom"));
        const cap: any = {};
        mount(cap);
        // Defaults stay in place; no crash.
        await waitFor(() => expect(cap.value).toBeTruthy());
        expect(cap.value.effective).toBe("available");
    });
});

describe("StatusContext — user_status WS event", () => {
    test("updates self when event userId === my userId", async () => {
        apiMock.getMyStatus.mockResolvedValueOnce({
            data: { userId: 1, effective: "available", presence: "online" },
        });
        const cap: any = {};
        mount(cap);
        await waitFor(() => expect(cap.value?.userId).toBe(1));

        act(() => {
            wsHandler!({
                type: "user_status",
                data: {
                    userId: 1,
                    effective: "in_call",
                    presence: "online",
                    manualStatus: null,
                    presencePreference: "auto",
                    source: "call",
                },
            });
        });
        await waitFor(() => expect(cap.value.effective).toBe("in_call"));
    });

    test("event for another user updates peers map, not self", async () => {
        apiMock.getMyStatus.mockResolvedValueOnce({
            data: { userId: 1, effective: "available", presence: "online" },
        });
        const cap: any = {};
        mount(cap);
        await waitFor(() => expect(cap.value?.userId).toBe(1));

        act(() => {
            wsHandler!({
                type: "user_status",
                data: {
                    userId: 42,
                    effective: "in_meeting",
                    presence: "online",
                    source: "meeting",
                },
            });
        });
        await waitFor(() => expect(cap.value.peers[42]?.effective).toBe("in_meeting"));
        // self unchanged
        expect(cap.value.effective).toBe("available");
        // getPeerStatus convenience accessor works
        expect(cap.value.getPeerStatus(42).effective).toBe("in_meeting");
        expect(cap.value.getPeerStatus(999)).toBeNull();
    });
});

describe("StatusContext — PR7 legacy events are ignored", () => {
    test("legacy presence_change / status_change events do NOT mutate peers map", async () => {
        apiMock.getMyStatus.mockResolvedValueOnce({ data: { userId: 1 } });
        const cap: any = {};
        mount(cap);
        await waitFor(() => expect(cap.value?.userId).toBe(1));

        act(() => {
            // Both legacy events should be silently dropped — the server no
            // longer emits them, and PR7 removed the client-side fallback so
            // any stale build that does emit them won't corrupt peers state.
            wsHandler!({ type: "presence_change", data: { userId: 7, status: "online", userStatus: "busy" } });
            wsHandler!({ type: "status_change", data: { userId: 9, userStatus: "dnd" } });
        });
        expect(cap.value.peers[7]).toBeUndefined();
        expect(cap.value.peers[9]).toBeUndefined();
    });
});

describe("StatusContext — mutators", () => {
    test("setManualStatus calls REST and applies optimistic update", async () => {
        apiMock.getMyStatus.mockResolvedValueOnce({
            data: { userId: 1, effective: "available", manualStatus: null },
        });
        apiMock.setMyStatus.mockResolvedValueOnce({
            data: { userId: 1, effective: "dnd", manualStatus: "dnd", presence: "online" },
        });

        const cap: any = {};
        mount(cap);
        await waitFor(() => expect(cap.value?.userId).toBe(1));

        await act(async () => {
            await cap.value.setManualStatus("dnd", { message: "Heads down" });
        });
        expect(apiMock.setMyStatus).toHaveBeenCalledWith({
            status: "dnd",
            message: "Heads down",
            messageExpiresAt: null,
        });
        await waitFor(() => expect(cap.value.effective).toBe("dnd"));
    });

    test("setInvisible(true) toggles presence preference and turns presence offline", async () => {
        apiMock.getMyStatus.mockResolvedValueOnce({
            data: { userId: 1, effective: "available", presence: "online", presencePreference: "auto" },
        });
        apiMock.setPresencePreference.mockResolvedValueOnce({
            data: {
                userId: 1,
                effective: "offline",
                presence: "offline",
                presencePreference: "invisible",
            },
        });

        const cap: any = {};
        mount(cap);
        await waitFor(() => expect(cap.value?.userId).toBe(1));

        await act(async () => {
            await cap.value.setInvisible(true);
        });
        expect(apiMock.setPresencePreference).toHaveBeenCalledWith("invisible");
        await waitFor(() => expect(cap.value.presencePreference).toBe("invisible"));
        expect(cap.value.effective).toBe("offline");
    });
});
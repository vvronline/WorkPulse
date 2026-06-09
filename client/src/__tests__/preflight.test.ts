/**
 * Tests for the meeting preflight check.
 *
 * We stub RTCPeerConnection on the global so the test runs in jsdom
 * (which has no WebRTC implementation). The stub is intentionally
 * minimal — just enough surface to exercise every branch of the
 * preflight state machine.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { runPreflight, summarisePreflight, DEFAULT_TIMEOUT_MS } from "../pages/meeting/preflight";

const realPC = globalThis.RTCPeerConnection;

/** Build a fake RTCPeerConnection class with a controllable candidate emitter. */
function makeFakePC({
    candidates = [] as any[],
    constructThrows = null as string | null,
    createOfferRejects = null as string | null,
    asyncTickMs = 0,
} = {}) {
    class FakeRTCPeerConnection {
        onicecandidate: ((ev: any) => void) | null;
        onicegatheringstatechange: (() => void) | null;
        iceGatheringState: string;
        _closed: boolean;
        constructor() {
            if (constructThrows) throw new Error(constructThrows);
            this.onicecandidate = null;
            this.onicegatheringstatechange = null;
            this.iceGatheringState = "new";
            this._closed = false;
        }
        addTransceiver() {
            /* no-op */
        }
        async createOffer() {
            if (createOfferRejects) throw new Error(createOfferRejects);
            return { type: "offer", sdp: "fake-sdp" };
        }
        async setLocalDescription() {
            // Emit candidates after a microtask so the Promise chain settles first.
            setTimeout(() => {
                for (const c of candidates) {
                    this.onicecandidate?.({ candidate: c });
                }
                this.iceGatheringState = "complete";
                this.onicegatheringstatechange?.();
                this.onicecandidate?.({ candidate: null });
            }, asyncTickMs);
        }
        close() {
            this._closed = true;
        }
    }
    return FakeRTCPeerConnection;
}

describe("runPreflight", () => {
    beforeEach(() => {
        delete (globalThis as any).RTCPeerConnection;
    });
    afterEach(() => {
        (globalThis as any).RTCPeerConnection = realPC;
    });

    it("returns no-rtcpeerconnection when the browser lacks WebRTC", async () => {
        const r = await runPreflight({ timeoutMs: 50 });
        expect(r.ok).toBe(false);
        expect(r.errorCode).toBe("no-rtcpeerconnection");
    });

    it("marks all four candidate kinds when each appears", async () => {
        (globalThis as any).RTCPeerConnection = makeFakePC({
            candidates: [
                { type: "host", candidate: "candidate:1 udp host" },
                { type: "srflx", candidate: "candidate:2 udp srflx" },
                { type: "relay", candidate: "candidate:3 tcp relay" },
            ],
        });
        const r = await runPreflight({ timeoutMs: 200 });
        expect(r.ok).toBe(true);
        expect(r.hasLocalCandidate).toBe(true);
        expect(r.hasHostCandidate).toBe(true);
        expect(r.hasSrflxCandidate).toBe(true);
        expect(r.hasRelayCandidate).toBe(true);
        expect(r.errorCode).toBeNull();
    });

    it("parses candidate type from the SDP string when `.type` is missing (older browsers)", async () => {
        (globalThis as any).RTCPeerConnection = makeFakePC({
            candidates: [{ candidate: "candidate:1 udp 1 1.2.3.4 4000 typ srflx" }],
        });
        const r = await runPreflight({ timeoutMs: 200 });
        expect(r.hasSrflxCandidate).toBe(true);
        expect(r.hasHostCandidate).toBe(false);
    });

    it("settles on timeout when no candidates arrive", async () => {
        (globalThis as any).RTCPeerConnection = class {
            iceGatheringState: string;
            constructor() {
                this.iceGatheringState = "new";
            }
            addTransceiver() {}
            async createOffer() {
                return { type: "offer", sdp: "" };
            }
            async setLocalDescription() {
                /* never emits candidates */
            }
            close() {}
        };
        const r = await runPreflight({ timeoutMs: 30 });
        expect(r.ok).toBe(false);
        expect(r.errorCode).toBe("timeout");
        expect(r.elapsedMs).toBeGreaterThanOrEqual(25);
    });

    it("surfaces createOffer failures as errorCode", async () => {
        (globalThis as any).RTCPeerConnection = makeFakePC({ createOfferRejects: "simulated" });
        const r = await runPreflight({ timeoutMs: 200 });
        expect(r.ok).toBe(false);
        expect(r.errorCode).toMatch(/^create-offer-failed:simulated/);
    });

    it("surfaces constructor failures as pc-construct-failed", async () => {
        (globalThis as any).RTCPeerConnection = makeFakePC({ constructThrows: "oops" });
        const r = await runPreflight({ timeoutMs: 200 });
        expect(r.errorCode).toMatch(/^pc-construct-failed:oops/);
    });

    it("calls onCandidate trace callback per candidate", async () => {
        (globalThis as any).RTCPeerConnection = makeFakePC({
            candidates: [
                { type: "host", candidate: "h" },
                { type: "relay", candidate: "r" },
            ],
        });
        const spy = vi.fn();
        await runPreflight({ timeoutMs: 200, onCandidate: spy });
        expect(spy).toHaveBeenCalledTimes(2);
        expect(spy).toHaveBeenCalledWith("host", expect.any(Object));
        expect(spy).toHaveBeenCalledWith("relay", expect.any(Object));
    });

    it("default timeout is 5 000ms", () => {
        expect(DEFAULT_TIMEOUT_MS).toBe(5_000);
    });
});

describe("summarisePreflight", () => {
    it("null result → error severity", () => {
        expect(summarisePreflight(null).severity).toBe("error");
    });
    it("no-rtcpeerconnection → friendly browser-unsupported error", () => {
        expect(
            summarisePreflight({ errorCode: "no-rtcpeerconnection", ok: false } as any).label
        ).toMatch(/browser/i);
    });
    it('relay candidate → "ok" with TURN reachable label', () => {
        expect(summarisePreflight({ ok: true, hasRelayCandidate: true } as any)).toMatchObject({
            severity: "ok",
            label: expect.stringContaining("TURN"),
        });
    });
    it('srflx only → "ok" with STUN reachable label', () => {
        expect(summarisePreflight({ ok: true, hasSrflxCandidate: true } as any)).toMatchObject({
            severity: "ok",
            label: expect.stringContaining("STUN"),
        });
    });
    it('host-only → "warn" (LAN-friendly note)', () => {
        expect(summarisePreflight({ ok: true, hasHostCandidate: true } as any)).toMatchObject({
            severity: "warn",
            label: expect.stringContaining("local"),
        });
    });
    it('no candidates at all → "error"', () => {
        expect(summarisePreflight({ ok: false } as any)).toMatchObject({
            severity: "error",
            label: expect.stringContaining("STUN/TURN"),
        });
    });
});
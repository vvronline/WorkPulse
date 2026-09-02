import { describe, expect, it } from "vitest";
import {
    forgetInboundSignal,
    rememberInboundSignal,
} from "../components/chat/call/callSignalDeduplicator";

describe("call signal deduplication", () => {
    it("accepts legacy signals and applies identified signals once", () => {
        const seen = new Set<string>();
        expect(rememberInboundSignal({}, seen)).toBe(true);
        expect(rememberInboundSignal({ signalId: "offer-1" }, seen)).toBe(true);
        expect(rememberInboundSignal({ signalId: "offer-1" }, seen)).toBe(false);
    });

    it("allows a failed signal to be retried", () => {
        const seen = new Set<string>();
        const signal = { signalId: "offer-1" };
        expect(rememberInboundSignal(signal, seen)).toBe(true);
        forgetInboundSignal(signal, seen);
        expect(rememberInboundSignal(signal, seen)).toBe(true);
    });
});

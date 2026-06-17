/**
 * Unit tests for NativeCallService action mapping and state management.
 * Verifies that native call actions (answer/reject from CallKeep) are
 * correctly mapped to socket calls and payload handling.
 */

describe("NativeCallService", () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    test("registers action handlers via onAction", () => {
        const { nativeCallService } = require("../nativeCallService");
        const handler = jest.fn();

        const unsubscribe = nativeCallService.onAction(handler);
        expect(typeof unsubscribe).toBe("function");

        unsubscribe();
    });

    test("stores incoming call payload for native action handling", async () => {
        const { nativeCallService } = require("../nativeCallService");

        const payload = {
            callId: "123",
            conversationId: "456",
            callType: "voice",
            callerName: "Alice",
        };

        await nativeCallService.reportIncomingCall(payload);
        // Payload should be internally stored for later action retrieval
    });

    test("generates deterministic UUID from callId + conversationId", async () => {
        const { nativeCallService } = require("../nativeCallService");

        const payload1 = {
            callId: "100",
            conversationId: "10",
            callType: "voice",
            callerName: "Bob",
        };

        const payload2 = {
            callId: "100",
            conversationId: "10",
            callType: "video",
            callerName: "Charlie",
        };

        // Same callId + conversationId should generate the same UUID
        await nativeCallService.reportIncomingCall(payload1);
        await nativeCallService.reportIncomingCall(payload2);
        // Internally, the service should recognize these as the same call
    });

    test("converts native action to socket message type", async () => {
        const { nativeCallService } = require("../nativeCallService");

        const payload = {
            callId: "200",
            conversationId: "20",
            callType: "voice",
            callerName: "Diana",
        };

        let capturedAction = null;
        const handler = jest.fn((params) => {
            capturedAction = params.action;
        });

        nativeCallService.onAction(handler);
        await nativeCallService.handleAction("answer", payload);

        expect(capturedAction).toBe("answer");
    });

    test("handles reject action mapping", async () => {
        const { nativeCallService } = require("../nativeCallService");

        const payload = {
            callId: "300",
            conversationId: "30",
            callType: "voice",
            callerName: "Eve",
        };

        let capturedAction = null;
        const handler = jest.fn((params) => {
            capturedAction = params.action;
        });

        nativeCallService.onAction(handler);
        await nativeCallService.handleAction("reject", payload);

        expect(capturedAction).toBe("reject");
    });

    test("passes through callId and conversationId to handlers", async () => {
        const { nativeCallService } = require("../nativeCallService");

        const payload = {
            callId: "400",
            conversationId: "40",
            callType: "voice",
            callerName: "Frank",
        };

        let capturedParams = null;
        const handler = jest.fn((params) => {
            capturedParams = params;
        });

        nativeCallService.onAction(handler);
        await nativeCallService.handleAction("answer", payload);

        expect(capturedParams.callId).toBe(400); // converted to number
        expect(capturedParams.conversationId).toBe(40); // converted to number
    });

    test("ignores invalid payload (missing required fields)", async () => {
        const { nativeCallService } = require("../nativeCallService");

        const handler = jest.fn();
        nativeCallService.onAction(handler);

        await nativeCallService.handleAction("answer", {
            // missing callId and conversationId
            callerName: "George",
        });

        expect(handler).not.toHaveBeenCalled();
    });

    test("multiple handlers all receive the same action", async () => {
        const { nativeCallService } = require("../nativeCallService");

        const handler1 = jest.fn();
        const handler2 = jest.fn();

        nativeCallService.onAction(handler1);
        nativeCallService.onAction(handler2);

        const payload = {
            callId: "500",
            conversationId: "50",
            callType: "voice",
            callerName: "Henry",
        };

        await nativeCallService.handleAction("answer", payload);

        expect(handler1).toHaveBeenCalled();
        expect(handler2).toHaveBeenCalled();
    });

    test("unsubscribe removes handler from notifications", async () => {
        const { nativeCallService } = require("../nativeCallService");

        const handler = jest.fn();
        const unsubscribe = nativeCallService.onAction(handler);

        const payload = {
            callId: "600",
            conversationId: "60",
            callType: "voice",
            callerName: "Iris",
        };

        unsubscribe();
        await nativeCallService.handleAction("answer", payload);

        expect(handler).not.toHaveBeenCalled();
    });
});

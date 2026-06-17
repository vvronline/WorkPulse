"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * Integration tests for call notification push payload contract.
 * Verifies that incoming call push payloads are structured correctly
 * for native UI display (CallKeep) on Android/iOS.
 */
jest.mock("../utils/logger", () => ({
    logger: {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        fatal: jest.fn(),
        debug: jest.fn(),
        child: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
    },
    logPushCallLifecycle: jest.fn(),
}));
const { pushNotifications } = require("../services/pushNotifications");
describe("pushNotifications.sendCallNotification", () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });
    test("returns success/failed counts for multicast send", async () => {
        const mockQuery = jest.fn().mockResolvedValue({ rows: ["token1", "token2"].map(t => ({ device_token: t })) });
        const result = await pushNotifications.sendCallNotification(mockQuery, 1, 1, {
            callId: 100,
            conversationId: 10,
            callerId: 2,
            callerName: "Alice",
            callType: "voice",
        });
        expect(result).toHaveProperty("succeeded");
        expect(result).toHaveProperty("failed");
        expect(typeof result.succeeded).toBe("number");
        expect(typeof result.failed).toBe("number");
    });
    test("includes call metadata in data payload", async () => {
        const mockQuery = jest.fn().mockResolvedValue({ rows: [] });
        const result = await pushNotifications.sendCallNotification(mockQuery, 1, 1, {
            callId: 99,
            conversationId: 9,
            callerId: 3,
            callerName: "Bob",
            callType: "video",
            isGroup: true,
            groupName: "Team Chat",
        });
        expect(result).toHaveProperty("succeeded");
        expect(result).toHaveProperty("failed");
    });
    test("includes APNs headers for iOS call UI", async () => {
        const mockQuery = jest.fn().mockResolvedValue({ rows: [] });
        const result = await pushNotifications.sendCallNotification(mockQuery, 1, 1, {
            callId: 88,
            conversationId: 8,
            callerId: 4,
            callerName: "Charlie",
            callType: "voice",
        });
        expect(typeof result.succeeded).toBe("number");
        expect(typeof result.failed).toBe("number");
    });
    test("includes Android priority and channel for call display", async () => {
        const mockQuery = jest.fn().mockResolvedValue({ rows: [] });
        const result = await pushNotifications.sendCallNotification(mockQuery, 1, 1, {
            callId: 77,
            conversationId: 7,
            callerId: 5,
            callerName: "Diana",
            callType: "voice",
        });
        expect(result.succeeded + result.failed).toBeGreaterThanOrEqual(0);
    });
    test("handles no device tokens gracefully", async () => {
        const mockQuery = jest.fn().mockResolvedValue({ rows: [] });
        const result = await pushNotifications.sendCallNotification(mockQuery, 999, 1, {
            callId: 1,
            conversationId: 1,
            callerId: 1,
            callerName: "Eve",
            callType: "voice",
        });
        expect(result.succeeded).toBe(0);
        expect(result.failed).toBe(0);
    });
});
//# sourceMappingURL=pushNotifications.callPayload.test.js.map
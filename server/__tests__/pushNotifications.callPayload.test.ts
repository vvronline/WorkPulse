export {};

/**
 * Integration tests for call notification push payload contract.
 * Verifies that incoming call push payloads are structured correctly
 * for app-rendered native/full-screen UI on Android and CallKit-compatible iOS.
 */

process.env.FIREBASE_SERVICE_ACCOUNT_KEY = JSON.stringify({
    projectId: "test-project",
    clientEmail: "test@test-project.iam.gserviceaccount.com",
    privateKey: "-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----\n",
});

const sendEachForMulticast = jest.fn(async (message: any) => ({
    responses: message.tokens.map(() => ({ success: true })),
    successCount: message.tokens.length,
    failureCount: 0,
}));

jest.mock("firebase-admin/app", () => ({
    initializeApp: jest.fn(() => ({ name: "workpulse" })),
    getApp: jest.fn(() => ({ name: "workpulse" })),
    cert: jest.fn((serviceAccount) => serviceAccount),
}));

jest.mock("firebase-admin/messaging", () => ({
    getMessaging: jest.fn(() => ({
        sendEachForMulticast,
    })),
}));

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
        sendEachForMulticast.mockClear();
    });

    test("returns success/failed counts for multicast send", async () => {
        const mockQuery = jest.fn().mockResolvedValue({ rows: ["token1", "token2"].map(t => ({ device_token: t })) });
        const result = await pushNotifications.sendCallNotification(
            mockQuery,
            1,
            1,
            {
                callId: 100,
                conversationId: 10,
                callerId: 2,
                callerName: "Alice",
                callType: "voice",
            },
        );
        expect(result).toEqual({ succeeded: 2, failed: 0 });
    });

    test("sends Android incoming calls as true data-only high-priority pushes", async () => {
        const mockQuery = jest.fn().mockResolvedValue({ rows: [{ device_token: "token1" }] });
        await pushNotifications.sendCallNotification(
            mockQuery,
            1,
            1,
            {
                callId: 99,
                conversationId: 9,
                callerId: 3,
                callerName: "Bob",
                callType: "video",
                isGroup: true,
                groupName: "Team Chat",
            },
        );

        const sent = sendEachForMulticast.mock.calls[0][0];
        expect(sent.notification).toBeUndefined();
        expect(sent.android).toEqual({ priority: "high" });
        expect(sent.android.notification).toBeUndefined();
        expect(sent.data).toMatchObject({
            type: "incoming_call",
            callId: "99",
            conversationId: "9",
            callerId: "3",
            callerName: "Bob",
            callType: "video",
            isGroup: "true",
            groupName: "Team Chat",
            dedupeKey: "call:99",
            callCategory: "incoming-call",
        });
    });

    test("includes APNs alert headers for iOS call UI", async () => {
        const mockQuery = jest.fn().mockResolvedValue({ rows: [{ device_token: "token1" }] });
        await pushNotifications.sendCallNotification(
            mockQuery,
            1,
            1,
            {
                callId: 88,
                conversationId: 8,
                callerId: 4,
                callerName: "Charlie",
                callType: "voice",
            },
        );

        const sent = sendEachForMulticast.mock.calls[0][0];
        expect(sent.apns.headers["apns-priority"]).toBe("10");
        expect(sent.apns.payload.aps.category).toBe("incoming-call");
        expect(sent.apns.payload.aps.alert).toEqual({
            title: "Incoming Voice Call",
            body: "Charlie is calling...",
        });
    });

    test("handles no device tokens gracefully", async () => {
        const mockQuery = jest.fn().mockResolvedValue({ rows: [] });
        const result = await pushNotifications.sendCallNotification(
            mockQuery,
            999,
            1,
            {
                callId: 1,
                conversationId: 1,
                callerId: 1,
                callerName: "Eve",
                callType: "voice",
            },
        );
        expect(result.succeeded).toBe(0);
        expect(result.failed).toBe(0);
        expect(sendEachForMulticast).not.toHaveBeenCalled();
    });
});
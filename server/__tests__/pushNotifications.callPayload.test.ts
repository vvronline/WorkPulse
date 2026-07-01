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
            callerAvatar: "",
        });
        expect(sent.data).toHaveProperty("sentAt");
        expect(sent.data).toHaveProperty("expiresAt");
        expect(Number.isNaN(Date.parse(sent.data.sentAt))).toBe(false);
        expect(Number.isNaN(Date.parse(sent.data.expiresAt))).toBe(false);
        expect(sent.data.dedupeKey).toBe(`call:${sent.data.callId}`);
    });

    test("includes caller avatar and stable routing contract fields", async () => {
        const mockQuery = jest.fn().mockResolvedValue({ rows: [{ device_token: "token1" }] });
        await pushNotifications.sendCallNotification(
            mockQuery,
            1,
            1,
            {
                callId: 199,
                conversationId: 19,
                callerId: 13,
                callerName: "Priya",
                callerAvatar: "https://cdn.example.test/priya.png",
                callType: "voice",
            },
        );

        const sent = sendEachForMulticast.mock.calls[0][0];
        expect(sent.data).toMatchObject({
            type: "incoming_call",
            callId: "199",
            conversationId: "19",
            callerId: "13",
            callerName: "Priya",
            callerAvatar: "https://cdn.example.test/priya.png",
            dedupeKey: "call:199",
            tenantId: "1",
        });
        expect(Number.isNaN(Date.parse(sent.data.sentAt))).toBe(false);
        expect(Number.isNaN(Date.parse(sent.data.expiresAt))).toBe(false);
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

    test("T054: SC1 - Default: caller name and avatar included in payload when hideSensitiveContent not set", async () => {
        const mockQuery = jest.fn()
            .mockResolvedValueOnce({ rows: [{ device_token: "token1" }] })  // getDeviceTokens
            .mockResolvedValueOnce({ rows: [{ notification_prefs: {} }] });   // fetch prefs (empty = default)

        await pushNotifications.sendCallNotification(
            mockQuery,
            1,
            1,
            {
                callId: 300,
                conversationId: 30,
                callerId: 5,
                callerName: "Diana",
                callerAvatar: "https://cdn.example.test/diana.png",
                callType: "voice",
            },
        );

        const sent = sendEachForMulticast.mock.calls[0][0];
        expect(sent.data).toHaveProperty("callerName", "Diana");
        expect(sent.data).toHaveProperty("callerAvatar", "https://cdn.example.test/diana.png");
    });

    test("T054: SC2 - Lock-screen hidden: caller name and avatar omitted when hideSensitiveContent=true", async () => {
        const mockQuery = jest.fn()
            .mockResolvedValueOnce({ rows: [{ device_token: "token1" }] })  // getDeviceTokens
            .mockResolvedValueOnce({ rows: [{ notification_prefs: { hideSensitiveContent: true } }] }); // fetch prefs

        await pushNotifications.sendCallNotification(
            mockQuery,
            1,
            1,
            {
                callId: 301,
                conversationId: 31,
                callerId: 6,
                callerName: "Emma",
                callerAvatar: "https://cdn.example.test/emma.png",
                callType: "voice",
            },
        );

        const sent = sendEachForMulticast.mock.calls[0][0];
        expect(sent.data).not.toHaveProperty("callerName");
        expect(sent.data).not.toHaveProperty("callerAvatar");
        // Generic body and title should be used instead
        expect(sent.data.body).toBe("Tap to answer");
        expect(sent.data.title).toBe("Incoming Voice Call");
    });

    test("T054: SC3 - Lock-screen hidden: body shows generic text when hideSensitiveContent=true", async () => {
        const mockQuery = jest.fn()
            .mockResolvedValueOnce({ rows: [{ device_token: "token1" }] })  // getDeviceTokens
            .mockResolvedValueOnce({ rows: [{ notification_prefs: { hideSensitiveContent: true } }] }); // fetch prefs

        await pushNotifications.sendCallNotification(
            mockQuery,
            1,
            1,
            {
                callId: 302,
                conversationId: 32,
                callerId: 7,
                callerName: "Frank",
                callType: "video",
            },
        );

        const sent = sendEachForMulticast.mock.calls[0][0];
        expect(sent.data.body).toBe("Tap to answer");
        expect(sent.data.title).toBe("Incoming Video Call");
    });

    test("T054: SC4 - Lock-screen hidden: payload still includes required fields for routing/dedup", async () => {
        const mockQuery = jest.fn()
            .mockResolvedValueOnce({ rows: [{ device_token: "token1" }] })  // getDeviceTokens
            .mockResolvedValueOnce({ rows: [{ notification_prefs: { hideSensitiveContent: true } }] }); // fetch prefs

        await pushNotifications.sendCallNotification(
            mockQuery,
            1,
            1,
            {
                callId: 303,
                conversationId: 33,
                callerId: 8,
                callerName: "Grace",
                callType: "voice",
            },
        );

        const sent = sendEachForMulticast.mock.calls[0][0];
        expect(sent.data).toHaveProperty("callId", "303");
        expect(sent.data).toHaveProperty("conversationId", "33");
        expect(sent.data).toHaveProperty("callerId", "8");
        expect(sent.data).toHaveProperty("dedupeKey", "call:303");
        expect(sent.data).toHaveProperty("expiresAt");
        expect(sent.data).toHaveProperty("type", "incoming_call");
    });
});
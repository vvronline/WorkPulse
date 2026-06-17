/**
 * Message push payload contract tests.
 *
 * Messages are sent as Android data-only FCM pushes so the mobile
 * background/headless handler can render the visible status-bar notification via
 * Notifee on the dedicated "messages" channel. This avoids Android OS handling
 * swallowing the app-side handler when the app is backgrounded/killed.
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

describe("pushNotifications.sendMessageNotification", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        sendEachForMulticast.mockClear();
    });

    test("sends Android messages as true data-only high-priority pushes", async () => {
        const mockQuery = jest.fn().mockResolvedValue({ rows: [{ device_token: "token1" }] });

        const result = await pushNotifications.sendMessageNotification(
            mockQuery,
            10,
            1,
            {
                conversationId: 456,
                messageId: 123,
                senderId: 7,
                senderName: "Alice",
                messagePreview: "Hello from Alice",
                unreadCount: 5,
            },
        );

        expect(result).toEqual({ succeeded: 1, failed: 0 });

        const sent = sendEachForMulticast.mock.calls[0][0];
        expect(sent.notification).toBeUndefined();
        expect(sent.android).toEqual({ priority: "high" });
        expect(sent.android.notification).toBeUndefined();
        expect(sent.data).toMatchObject({
            type: "chat_message",
            title: "Alice",
            body: "Hello from Alice",
            conversationId: "456",
            messageId: "123",
            senderId: "7",
            senderName: "Alice",
            unreadCount: "5",
            badgeCount: "5",
            dedupeKey: "msg:123",
        });
    });

    test("includes APNs alert and badge for iOS message display", async () => {
        const mockQuery = jest.fn().mockResolvedValue({ rows: [{ device_token: "token1" }] });

        await pushNotifications.sendMessageNotification(
            mockQuery,
            10,
            1,
            {
                conversationId: 456,
                messageId: 123,
                senderId: 7,
                senderName: "Alice",
                messagePreview: "Hello from Alice",
                unreadCount: 5,
            },
        );

        const sent = sendEachForMulticast.mock.calls[0][0];
        expect(sent.apns.headers["apns-push-type"]).toBe("alert");
        expect(sent.apns.payload.aps.badge).toBe(5);
        expect(sent.apns.payload.aps.alert).toEqual({
            title: "Alice",
            body: "Hello from Alice",
        });
    });

    test("handles no device tokens gracefully", async () => {
        const mockQuery = jest.fn().mockResolvedValue({ rows: [] });

        const result = await pushNotifications.sendMessageNotification(
            mockQuery,
            10,
            1,
            {
                conversationId: 456,
                messageId: 123,
                senderId: 7,
                senderName: "Alice",
                messagePreview: "Hello from Alice",
                unreadCount: 5,
            },
        );

        expect(result).toEqual({ succeeded: 0, failed: 0 });
        expect(sendEachForMulticast).not.toHaveBeenCalled();
    });
});
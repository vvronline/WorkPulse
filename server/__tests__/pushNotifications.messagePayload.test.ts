/**
 * Message push payload contract tests.
 *
 * Messages are sent as Android DATA-ONLY FCM pushes (no top-level
 * `notification` block and no `android.notification` block) — exactly like
 * CALLS — so the app's background/headless handler ALWAYS runs and renders the
 * notification itself via Notifee with the sender's circular avatar largeIcon.
 * The top-level `notification` block is retained on the payload object purely
 * to render the webpush (desktop/browser) notification and is omitted from the
 * Android multicast via `androidDataOnly`. iOS still renders via
 * `apns.payload.aps.alert`.
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

    test("sends Android messages as DATA-ONLY high-priority pushes", async () => {
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
        // DATA-ONLY: no top-level `notification` block on the Android multicast
        // (it is omitted via androidDataOnly) so the app's headless/background
        // handler runs and renders the message itself via Notifee with the
        // sender's circular avatar largeIcon.
        expect(sent.notification).toBeUndefined();
        // No android.notification block either — high priority wakes the handler.
        expect(sent.android.priority).toBe("high");
        expect(sent.android.notification).toBeUndefined();
        // data carries everything the client needs: in-app routing, badge sync,
        // foreground/headless Notifee render, and the sender's avatar.
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
            senderAvatar: "",
        });
        expect(sent.data).toHaveProperty("sentAt");
        expect(Number.isNaN(Date.parse(sent.data.sentAt))).toBe(false);
        expect(sent.data.dedupeKey).toBe(`msg:${sent.data.messageId}`);
        // webpush still carries the notification block so desktop/browser render.
        expect(sent.webpush.notification).toMatchObject({
            title: "Alice",
            body: "Hello from Alice",
        });
    });

    test("includes sender avatar and stable routing contract fields", async () => {
        const mockQuery = jest.fn().mockResolvedValue({ rows: [{ device_token: "token1" }] });

        await pushNotifications.sendMessageNotification(
            mockQuery,
            10,
            1,
            {
                conversationId: 777,
                messageId: 888,
                senderId: 99,
                senderName: "Dana",
                senderAvatar: "https://cdn.example.test/dana.png",
                messagePreview: "Avatar payload",
                unreadCount: 2,
            },
        );

        const sent = sendEachForMulticast.mock.calls[0][0];
        expect(sent.data).toMatchObject({
            type: "chat_message",
            conversationId: "777",
            messageId: "888",
            senderId: "99",
            senderName: "Dana",
            senderAvatar: "https://cdn.example.test/dana.png",
            dedupeKey: "msg:888",
            tenantId: "1",
        });
        expect(Number.isNaN(Date.parse(sent.data.sentAt))).toBe(false);
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
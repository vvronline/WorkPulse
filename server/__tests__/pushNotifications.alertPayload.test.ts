export {};
/**
 * Alert (general notification) push payload contract tests.
 *
 * General alerts (leave approved, task assigned, mentions, …) are now sent as
 * Android DATA-ONLY high-priority pushes — exactly like message pushes — so the
 * mobile background/headless handler renders the visible status-bar notification
 * via Notifee in EVERY app state (foreground/background/killed). A top-level
 * `notification` block would be handed straight to the Android system tray and
 * bypass the app handler when backgrounded/killed (and would not auto-display in
 * the foreground), which is why foreground alerts were silently dropped before.
 *
 * iOS still receives a visible APNs alert + badge. The webpush.notification
 * block still renders the browser/desktop alert.
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

describe("pushNotifications.sendNotificationAlert", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        sendEachForMulticast.mockClear();
    });

    test("sends Android alerts as data-only high-priority pushes (no android.notification)", async () => {
        const mockQuery = jest.fn().mockResolvedValue({ rows: [{ device_token: "token1" }] });

        const result = await pushNotifications.sendNotificationAlert(
            mockQuery,
            10,
            1,
            {
                notificationId: 99,
                title: "Leave Approved",
                body: "Your leave on 2026-06-20 has been approved.",
                type: "leave",
                badgeCount: 3,
            },
        );

        expect(result).toEqual({ succeeded: 1, failed: 0 });

        const sent = sendEachForMulticast.mock.calls[0][0];
        // Android side must be data-only — NO android.notification block.
        expect(sent.android).toEqual({ priority: "high" });
        expect(sent.android.notification).toBeUndefined();
        // Title/body/badge travel in the data payload for the app handler.
        expect(sent.data).toMatchObject({
            notificationId: "99",
            type: "leave",
            title: "Leave Approved",
            body: "Your leave on 2026-06-20 has been approved.",
            badgeCount: "3",
            dedupeKey: "notif:99",
        });
    });

    test("includes APNs alert + badge for iOS and webpush notification for browser", async () => {
        const mockQuery = jest.fn().mockResolvedValue({ rows: [{ device_token: "token1" }] });

        await pushNotifications.sendNotificationAlert(
            mockQuery,
            10,
            1,
            {
                notificationId: 99,
                title: "Task Assigned",
                body: "Alice assigned you a task",
                badgeCount: 7,
            },
        );

        const sent = sendEachForMulticast.mock.calls[0][0];
        expect(sent.apns.headers["apns-push-type"]).toBe("alert");
        expect(sent.apns.payload.aps.badge).toBe(7);
        expect(sent.apns.payload.aps.alert).toEqual({
            title: "Task Assigned",
            body: "Alice assigned you a task",
        });
        // Browser/desktop still gets a visible web notification.
        expect(sent.webpush.notification).toMatchObject({
            title: "Task Assigned",
            body: "Alice assigned you a task",
        });
    });

    test("defaults the badge to 1 when badgeCount is omitted", async () => {
        const mockQuery = jest.fn().mockResolvedValue({ rows: [{ device_token: "token1" }] });

        await pushNotifications.sendNotificationAlert(
            mockQuery,
            10,
            1,
            {
                notificationId: 5,
                title: "Mention",
                body: "You were mentioned",
            },
        );

        const sent = sendEachForMulticast.mock.calls[0][0];
        expect(sent.data.badgeCount).toBe("1");
        expect(sent.apns.payload.aps.badge).toBe(1);
    });

    test("handles no device tokens gracefully", async () => {
        const mockQuery = jest.fn().mockResolvedValue({ rows: [] });

        const result = await pushNotifications.sendNotificationAlert(
            mockQuery,
            10,
            1,
            {
                notificationId: 1,
                title: "X",
                body: "Y",
            },
        );

        expect(result).toEqual({ succeeded: 0, failed: 0 });
        expect(sendEachForMulticast).not.toHaveBeenCalled();
    });
});
"use strict";
/**
 * Firebase Cloud Messaging service for push notifications.
 * Manages FCM integration for calls, messages, and notifications.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.pushNotifications = void 0;
const app_1 = require("firebase-admin/app");
const messaging_1 = require("firebase-admin/messaging");
const logger_1 = require("../utils/logger");
class PushNotificationService {
    initialized = false;
    app = null;
    constructor() {
        this.initialize();
    }
    buildCommonData(base, tenantId) {
        return {
            ...base,
            tenantId: tenantId != null ? String(tenantId) : "",
            sentAt: new Date().toISOString(),
        };
    }
    buildAndroidNotification(channelId, priority = "high", visibility = "private") {
        return {
            priority: "high",
            notification: {
                sound: "default",
                channelId: process.env.PUSH_DEFAULT_ANDROID_CHANNEL || channelId,
                priority,
                visibility,
                notificationCount: 1,
                defaultVibrateTimings: true,
                defaultLightSettings: true,
            },
        };
    }
    initialize() {
        try {
            const serviceAccountKey = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
            if (!serviceAccountKey) {
                logger_1.logger.warn("FIREBASE_SERVICE_ACCOUNT_KEY not configured — push notifications disabled");
                return;
            }
            const serviceAccount = JSON.parse(serviceAccountKey);
            this.app = (0, app_1.initializeApp)({
                credential: (0, app_1.cert)(serviceAccount),
            }, "workpulse");
            this.initialized = true;
            logger_1.logger.info("Firebase Cloud Messaging initialized");
        }
        catch (err) {
            logger_1.logger.error({ err: err.message }, "Failed to initialize Firebase");
        }
    }
    async registerDeviceToken(query, userId, tenantId, deviceToken, platform) {
        if (!deviceToken || !deviceToken.trim()) {
            throw new Error("Device token is required");
        }
        try {
            // Upsert device token — if it exists, update last_seen_at; otherwise create it
            await query(`
                INSERT INTO device_tokens (user_id, tenant_id, device_token, platform, last_seen_at, created_at)
                VALUES ($1, $2, $3, $4, NOW(), NOW())
                ON CONFLICT (user_id, device_token) DO UPDATE
                SET platform = EXCLUDED.platform, last_seen_at = NOW()
                `, [userId, tenantId || null, deviceToken, platform]);
            logger_1.logger.info({ userId, tenantId, platform }, "Device token registered");
        }
        catch (err) {
            logger_1.logger.error({ err: err.message, userId }, "Failed to register device token");
            throw err;
        }
    }
    async sendCallNotification(query, userId, tenantId, callData) {
        if (!this.initialized || !this.app) {
            return { succeeded: 0, failed: 0 };
        }
        const tokens = await this.getDeviceTokens(query, userId, tenantId);
        if (tokens.length === 0) {
            logger_1.logger.debug({ userId }, "No device tokens found for call notification");
            return { succeeded: 0, failed: 0 };
        }
        const title = callData.callType === "video" ? "Incoming Video Call" : "Incoming Voice Call";
        const body = `${callData.callerName} is calling...`;
        const callTTLSeconds = Number(process.env.PUSH_CALL_TTL_SECONDS || 30);
        const payload = {
            notification: { title, body },
            data: this.buildCommonData({
                callId: String(callData.callId),
                conversationId: String(callData.conversationId),
                callerId: String(callData.callerId),
                callerName: callData.callerName || "",
                callerAvatar: callData.callerAvatar || "",
                callType: callData.callType,
                isGroup: String(callData.isGroup || false),
                groupName: callData.groupName || "",
                expiresAt: new Date(Date.now() + (callTTLSeconds * 1000)).toISOString(),
                dedupeKey: `call:${callData.callId}`,
                callCategory: "incoming-call",
            }, tenantId),
            android: {
                priority: "high",
                notification: {
                    sound: "default",
                    channelId: "calls", // Use dedicated calls channel for system UI display
                    priority: "max",
                    visibility: "public",
                    notificationCount: 1,
                    defaultVibrateTimings: true,
                    defaultLightSettings: true,
                },
            },
            apns: {
                headers: {
                    "apns-priority": "10",
                    "apns-push-type": process.env.PUSH_CALL_APNS_PUSH_TYPE || "alert",
                },
                payload: {
                    aps: {
                        alert: { title, body },
                        badge: 1,
                        sound: "default",
                        "mutable-content": 1,
                        category: "incoming-call",
                    },
                },
            },
        };
        logger_1.logger.info({
            event: "push_dispatch_attempt",
            notificationType: "call",
            tenantId,
            userId,
            callId: callData.callId,
            conversationId: callData.conversationId,
            dedupeKey: payload.data.dedupeKey,
            channelId: payload.android?.notification?.channelId,
            tokenCount: tokens.length,
        }, "Dispatching call notification push");
        return this.sendToDevices(query, tokens, payload, `call-${callData.callId}`);
    }
    async sendMessageNotification(query, userId, tenantId, messageData) {
        if (!this.initialized || !this.app) {
            return { succeeded: 0, failed: 0 };
        }
        const tokens = await this.getDeviceTokens(query, userId, tenantId);
        if (tokens.length === 0) {
            return { succeeded: 0, failed: 0 };
        }
        const preview = messageData.messagePreview.substring(0, 150);
        const unreadCount = messageData.unreadCount || 1;
        // T031: Enrich payload with message type and unread count for badge reconciliation
        const payload = {
            notification: {
                title: messageData.senderName,
                body: preview,
            },
            data: this.buildCommonData({
                type: "message",
                conversationId: String(messageData.conversationId),
                messageId: String(messageData.messageId),
                senderId: String(messageData.senderId),
                senderName: messageData.senderName,
                unreadCount: String(unreadCount),
                badgeCount: String(unreadCount),
                dedupeKey: `msg:${messageData.messageId}`,
                // T031: Add expiry for payload freshness validation (1 hour TTL)
                expiresAt: String(Math.floor(Date.now() / 1000) + 3600),
            }, tenantId),
            // T031: Use dedicated "messages" channel for status-bar visibility
            android: {
                priority: "high",
                notification: {
                    sound: "default",
                    channelId: process.env.PUSH_MESSAGE_ANDROID_CHANNEL || "messages",
                    priority: "high",
                    visibility: "private",
                    notificationCount: unreadCount,
                    defaultVibrateTimings: true,
                    defaultLightSettings: true,
                },
            },
            apns: {
                headers: {
                    "apns-priority": "10",
                    "apns-push-type": "alert",
                },
                payload: {
                    aps: {
                        alert: {
                            title: messageData.senderName,
                            body: preview,
                        },
                        badge: unreadCount,
                        sound: "default",
                        "mutable-content": 1,
                    },
                },
            },
        };
        logger_1.logger.info({
            event: "push_dispatch_attempt",
            notificationType: "message",
            tenantId,
            userId,
            conversationId: messageData.conversationId,
            messageId: messageData.messageId,
            unreadCount,
            dedupeKey: payload.data.dedupeKey,
            channelId: payload.android?.notification?.channelId,
            recipientCount: tokens.length,
        }, "Dispatching message notification push");
        return this.sendToDevices(query, tokens, payload, `msg-${messageData.messageId}`);
    }
    async sendNotificationAlert(query, userId, tenantId, notificationData) {
        if (!this.initialized || !this.app) {
            return { succeeded: 0, failed: 0 };
        }
        const tokens = await this.getDeviceTokens(query, userId, tenantId);
        if (tokens.length === 0) {
            return { succeeded: 0, failed: 0 };
        }
        const payload = {
            notification: {
                title: notificationData.title,
                body: notificationData.body,
            },
            data: this.buildCommonData({
                notificationId: String(notificationData.notificationId),
                type: notificationData.type || "notification",
                dedupeKey: `notif:${notificationData.notificationId}`,
            }, tenantId),
            android: this.buildAndroidNotification("default", "high", "private"),
            apns: {
                headers: {
                    "apns-priority": "10",
                    "apns-push-type": "alert",
                },
                payload: {
                    aps: {
                        alert: {
                            title: notificationData.title,
                            body: notificationData.body,
                        },
                        badge: 1,
                        sound: "default",
                        "mutable-content": 1,
                    },
                },
            },
        };
        return this.sendToDevices(query, tokens, payload, `notif-${notificationData.notificationId}`);
    }
    async getDeviceTokens(query, userId, tenantId) {
        try {
            const result = await query(`SELECT device_token FROM device_tokens
                 WHERE user_id = $1 AND (tenant_id = $2 OR tenant_id IS NULL)
                 AND created_at > NOW() - INTERVAL '1 year'`, [userId, tenantId || null]);
            return result.rows.map((r) => r.device_token);
        }
        catch (err) {
            logger_1.logger.error({ err: err.message, userId }, "Failed to get device tokens");
            return [];
        }
    }
    async sendToDevices(query, tokens, payload, collapseKey) {
        if (!this.app) {
            return { succeeded: 0, failed: 0 };
        }
        let succeeded = 0;
        let failed = 0;
        try {
            const response = await (0, messaging_1.getMessaging)(this.app).sendEachForMulticast({
                tokens,
                notification: payload.notification,
                data: payload.data,
                android: payload.android,
                apns: payload.apns,
                webpush: {
                    data: payload.data,
                    notification: {
                        title: payload.notification.title,
                        body: payload.notification.body,
                        icon: "/icon-192.png",
                    },
                },
            });
            const invalidTokens = [];
            response.responses.forEach((resp, idx) => {
                if (resp.success) {
                    succeeded++;
                }
                else {
                    failed++;
                    const error = resp.error?.code;
                    // Collect invalid/unregistered tokens for cleanup
                    if (error === "messaging/invalid-registration-token" ||
                        error === "messaging/registration-token-not-registered") {
                        invalidTokens.push(tokens[idx]);
                    }
                }
            });
            // Purge invalid tokens from DB so they don't waste future sends
            if (invalidTokens.length > 0) {
                query(`DELETE FROM device_tokens WHERE device_token = ANY($1)`, [invalidTokens]).catch((err) => {
                    logger_1.logger.warn({ err: err.message, count: invalidTokens.length }, "Failed to purge invalid device tokens");
                });
            }
            logger_1.logger.info({
                event: "push_dispatch_result",
                collapseKey,
                notificationType: payload.data.type || (payload.data.callId ? "call" : "notification"),
                tenantId: payload.data.tenantId || null,
                dedupeKey: payload.data.dedupeKey || null,
                channelId: payload.android?.notification?.channelId,
                tokenCount: tokens.length,
                sent: response.successCount,
                failed: response.failureCount,
            }, "Push notifications sent");
        }
        catch (err) {
            logger_1.logger.error({
                event: "push_dispatch_failed",
                err: err.message,
                collapseKey,
                notificationType: payload.data.type || (payload.data.callId ? "call" : "notification"),
                tenantId: payload.data.tenantId || null,
                dedupeKey: payload.data.dedupeKey || null,
                channelId: payload.android?.notification?.channelId,
                tokenCount: tokens.length,
            }, "Failed to send push notifications");
            failed = tokens.length;
        }
        return { succeeded, failed };
    }
}
exports.pushNotifications = new PushNotificationService();
//# sourceMappingURL=pushNotifications.js.map
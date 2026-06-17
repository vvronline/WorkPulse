/**
 * Firebase Cloud Messaging service for push notifications.
 * Manages FCM integration for calls, messages, and notifications.
 */

import { initializeApp, getApp, cert, type App } from "firebase-admin/app";
import { getMessaging, type SendResponse } from "firebase-admin/messaging";
import { logger } from "../utils/logger";
import type { QueryFn } from "../types/domain";

interface FCMPayload {
    notification: {
        title: string;
        body: string;
    };
    data: Record<string, string>;
    android?: {
        priority: "high" | "normal";
        notification: {
            sound: string;
            channelId: string;
            priority?: "min" | "low" | "default" | "high" | "max";
            visibility?: "private" | "public" | "secret";
            notificationCount?: number;
            defaultVibrateTimings?: boolean;
            defaultLightSettings?: boolean;
            click_action?: string;
        };
    };
    apns?: {
        headers?: Record<string, string>;
        payload: {
            aps: {
                alert: {
                    title: string;
                    body: string;
                };
                badge?: number;
                sound: string;
                "mutable-content": number;
                category?: string;
            };
        };
    };
}

class PushNotificationService {
    private initialized = false;
    private app: App | null = null;

    constructor() {
        this.initialize();
    }

    private buildCommonData(base: Record<string, string>, tenantId: number | null): Record<string, string> {
        return {
            ...base,
            tenantId: tenantId != null ? String(tenantId) : "",
            sentAt: new Date().toISOString(),
        };
    }

    private buildAndroidNotification(
        channelId: string,
        priority: "high" | "max" = "high",
        visibility: "private" | "public" = "private",
    ): FCMPayload["android"] {
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

    private initialize() {
        try {
            const serviceAccountKey = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
            if (!serviceAccountKey) {
                logger.warn("FIREBASE_SERVICE_ACCOUNT_KEY not configured — push notifications disabled");
                return;
            }

            const serviceAccount = JSON.parse(serviceAccountKey);
            this.app = initializeApp({
                credential: cert(serviceAccount),
            }, "workpulse");
            this.initialized = true;
            logger.info("Firebase Cloud Messaging initialized");
        } catch (err) {
            logger.error({ err: (err as Error).message }, "Failed to initialize Firebase");
        }
    }

    async registerDeviceToken(
        query: QueryFn,
        userId: number,
        tenantId: number | null,
        deviceToken: string,
        platform: "ios" | "android",
    ): Promise<void> {
        if (!deviceToken || !deviceToken.trim()) {
            throw new Error("Device token is required");
        }

        try {
            // Upsert device token — if it exists, update last_seen_at; otherwise create it
            await query(
                `
                INSERT INTO device_tokens (user_id, tenant_id, device_token, platform, last_seen_at, created_at)
                VALUES ($1, $2, $3, $4, NOW(), NOW())
                ON CONFLICT (user_id, device_token) DO UPDATE
                SET platform = EXCLUDED.platform, last_seen_at = NOW()
                `,
                [userId, tenantId || null, deviceToken, platform],
            );

            logger.info({ userId, tenantId, platform }, "Device token registered");
        } catch (err) {
            logger.error({ err: (err as Error).message, userId }, "Failed to register device token");
            throw err;
        }
    }

    async sendCallNotification(
        query: QueryFn,
        userId: number,
        tenantId: number | null,
        callData: {
            callId: number;
            conversationId: number;
            callerId: number;
            callerName: string;
            callerAvatar?: string;
            callType: "voice" | "video";
            isGroup?: boolean;
            groupName?: string;
        },
    ): Promise<{ succeeded: number; failed: number }> {
        if (!this.initialized || !this.app) {
            return { succeeded: 0, failed: 0 };
        }

        const tokens = await this.getDeviceTokens(query, userId, tenantId);
        if (tokens.length === 0) {
            logger.debug({ userId }, "No device tokens found for call notification");
            return { succeeded: 0, failed: 0 };
        }

        const title = callData.callType === "video" ? "Incoming Video Call" : "Incoming Voice Call";
        const body = `${callData.callerName} is calling...`;
        const callTTLSeconds = Number(process.env.PUSH_CALL_TTL_SECONDS || 30);

        const payload: FCMPayload = {
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

        return this.sendToDevices(query, tokens, payload, `call-${callData.callId}`);
    }

    async sendMessageNotification(
        query: QueryFn,
        userId: number,
        tenantId: number | null,
        messageData: {
            conversationId: number;
            messageId: number;
            senderId: number;
            senderName: string;
            senderAvatar?: string;
            messagePreview: string;
            unreadCount?: number; // T031: Server-authoritative unread count
        },
    ): Promise<{ succeeded: number; failed: number }> {
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
        const payload: FCMPayload = {
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

        // T031: Log message push lifecycle event
        logger.info(
            {
                tenantId,
                userId,
                conversationId: messageData.conversationId,
                messageId: messageData.messageId,
                unreadCount,
                recipientCount: tokens.length,
            },
            '[pushNotifications.sendMessageNotification] Sending message notification'
        );

        return this.sendToDevices(query, tokens, payload, `msg-${messageData.messageId}`);
    }

    async sendNotificationAlert(
        query: QueryFn,
        userId: number,
        tenantId: number | null,
        notificationData: {
            notificationId: number;
            title: string;
            body: string;
            type?: string;
        },
    ): Promise<{ succeeded: number; failed: number }> {
        if (!this.initialized || !this.app) {
            return { succeeded: 0, failed: 0 };
        }

        const tokens = await this.getDeviceTokens(query, userId, tenantId);
        if (tokens.length === 0) {
            return { succeeded: 0, failed: 0 };
        }

        const payload: FCMPayload = {
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

    private async getDeviceTokens(
        query: QueryFn,
        userId: number,
        tenantId: number | null,
    ): Promise<string[]> {
        try {
            const result = await query(
                `SELECT device_token FROM device_tokens
                 WHERE user_id = $1 AND (tenant_id = $2 OR tenant_id IS NULL)
                 AND created_at > NOW() - INTERVAL '1 year'`,
                [userId, tenantId || null],
            );
            return result.rows.map((r: any) => r.device_token);
        } catch (err) {
            logger.error({ err: (err as Error).message, userId }, "Failed to get device tokens");
            return [];
        }
    }

    private async sendToDevices(
        query: QueryFn,
        tokens: string[],
        payload: FCMPayload,
        collapseKey: string,
    ): Promise<{ succeeded: number; failed: number }> {
        if (!this.app) {
            return { succeeded: 0, failed: 0 };
        }

        let succeeded = 0;
        let failed = 0;

        try {
            const response = await getMessaging(this.app!).sendEachForMulticast({
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

            const invalidTokens: string[] = [];
            response.responses.forEach((resp: SendResponse, idx: number) => {
                if (resp.success) {
                    succeeded++;
                } else {
                    failed++;
                    const error = resp.error?.code;
                    // Collect invalid/unregistered tokens for cleanup
                    if (
                        error === "messaging/invalid-registration-token" ||
                        error === "messaging/registration-token-not-registered"
                    ) {
                        invalidTokens.push(tokens[idx]);
                    }
                }
            });

            // Purge invalid tokens from DB so they don't waste future sends
            if (invalidTokens.length > 0) {
                query(
                    `DELETE FROM device_tokens WHERE device_token = ANY($1)`,
                    [invalidTokens],
                ).catch((err: any) => {
                    logger.warn({ err: err.message, count: invalidTokens.length }, "Failed to purge invalid device tokens");
                });
            }

            logger.info(
                { collapseKey, sent: response.successCount, failed: response.failureCount },
                "Push notifications sent",
            );
        } catch (err) {
            logger.error({ err: (err as Error).message, collapseKey }, "Failed to send push notifications");
            failed = tokens.length;
        }

        return { succeeded, failed };
    }
}

export const pushNotifications = new PushNotificationService();

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
            click_action?: string;
        };
    };
    apns?: {
        payload: {
            aps: {
                alert: {
                    title: string;
                    body: string;
                };
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

        const payload: FCMPayload = {
            notification: { title, body },
            data: {
                callId: String(callData.callId),
                conversationId: String(callData.conversationId),
                callerId: String(callData.callerId),
                callType: callData.callType,
                isGroup: String(callData.isGroup || false),
                groupName: callData.groupName || "",
            },
            android: {
                priority: "high",
                notification: {
                    sound: "default",
                    channelId: "calls",
                    click_action: "FLUTTER_NOTIFICATION_CLICK",
                },
            },
            apns: {
                payload: {
                    aps: {
                        alert: { title, body },
                        sound: "default",
                        "mutable-content": 1,
                        category: "INCOMING_CALL",
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
        const payload: FCMPayload = {
            notification: {
                title: messageData.senderName,
                body: preview,
            },
            data: {
                conversationId: String(messageData.conversationId),
                messageId: String(messageData.messageId),
                senderId: String(messageData.senderId),
                senderName: messageData.senderName,
            },
            android: {
                priority: "high",
                notification: {
                    sound: "default",
                    channelId: "messages",
                },
            },
            apns: {
                payload: {
                    aps: {
                        alert: {
                            title: messageData.senderName,
                            body: preview,
                        },
                        sound: "default",
                        "mutable-content": 1,
                    },
                },
            },
        };

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
            data: {
                notificationId: String(notificationData.notificationId),
                type: notificationData.type || "notification",
            },
            android: {
                priority: "high",
                notification: {
                    sound: "default",
                    channelId: "notifications",
                },
            },
            apns: {
                payload: {
                    aps: {
                        alert: {
                            title: notificationData.title,
                            body: notificationData.body,
                        },
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

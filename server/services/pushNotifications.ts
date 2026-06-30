/**
 * Firebase Cloud Messaging service for push notifications.
 * Manages FCM integration for calls, messages, and notifications.
 */

import { initializeApp, getApp, cert, type App } from "firebase-admin/app";
import { getMessaging, type SendResponse } from "firebase-admin/messaging";
import { logger } from "../utils/logger";
import type { QueryFn } from "../types/domain";

interface FCMPayload {
    // Optional: incoming-call pushes are intentionally DATA-ONLY so the mobile
    // background/headless handler always runs (see sendCallNotification).
    notification?: {
        title: string;
        body: string;
    };
    data: Record<string, string>;
    // When true, the top-level `notification` block is NOT applied to the
    // Android/multicast message (it is still used to render the webpush
    // notification, and iOS still renders via `apns.payload.aps.alert`). This
    // forces Android to deliver a DATA-ONLY message so the app's
    // background/headless handler runs and renders the notification itself via
    // Notifee — which is the ONLY way to attach the sender's CIRCULAR avatar as
    // the notification largeIcon (an OS-rendered FCM `notification` message
    // cannot carry an authed circular largeIcon, which is why messages showed
    // no avatar while data-only CALLS did).
    androidDataOnly?: boolean;
    android?: {
        priority: "high" | "normal";
        // Optional. Do NOT set for Android call/message data pushes: if this is
        // present, FCM may treat the message as OS-rendered notification traffic
        // instead of reliably waking the app's background/headless data handler.
        notification?: {
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
            // Log the resolved Firebase project_id so deploys can confirm the
            // server's service account matches the mobile app's
            // google-services.json project. A mismatch here means every send
            // fails with `mismatched-credential` and NO push is delivered.
            logger.info(
                { projectId: serviceAccount.project_id || "unknown", clientEmail: serviceAccount.client_email || "unknown" },
                "Firebase Cloud Messaging initialized",
            );
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
            // Group CALL (huddle) join code. When present the callee joins the
            // n-way meeting mesh via this code instead of the 1:1 p2p flow.
            meetingCode?: string;
        },
    ): Promise<{ succeeded: number; failed: number }> {
        if (!this.initialized || !this.app) {
            return { succeeded: 0, failed: 0 };
        }

        const tokens = await this.getDeviceTokens(query, userId, tenantId);
        if (tokens.length === 0) {
            // info (not debug) so this is visible in production. The #1 cause of
            // "push never shows" is the recipient simply having no registered
            // device token (registration failed, table missing, or never logged
            // in on a build with FCM). Surfacing it here makes that obvious.
            logger.info({ event: "push_skip_no_tokens", notificationType: "call", userId, tenantId, callId: callData.callId }, "No device tokens for call notification recipient");
            return { succeeded: 0, failed: 0 };
        }

        const title = callData.callType === "video" ? "Incoming Video Call" : "Incoming Voice Call";
        const body = `${callData.callerName} is calling...`;
        const callTTLSeconds = Number(process.env.PUSH_CALL_TTL_SECONDS || 30);

        // IMPORTANT: Incoming-call pushes are DATA-ONLY (no top-level
        // `notification` block). On Android, a message that contains a
        // `notification` block is treated as a "notification message" and is
        // rendered by the OS without invoking the app's background message
        // handler when the app is killed. Our headless handler is exactly what
        // calls CallKeep.displayIncomingCall() to show the native full-screen
        // call UI, so the payload MUST be data-only to guarantee it fires in the
        // terminated state. Title/body are carried in `data` for the client to
        // present the call screen.
        const payload: FCMPayload = {
            data: this.buildCommonData({
                type: "incoming_call",
                title,
                body,
                callId: String(callData.callId),
                conversationId: String(callData.conversationId),
                callerId: String(callData.callerId),
                callerName: callData.callerName || "",
                callerAvatar: callData.callerAvatar || "",
                callType: callData.callType,
                isGroup: String(callData.isGroup || false),
                groupName: callData.groupName || "",
                meetingCode: callData.meetingCode || "",
                expiresAt: new Date(Date.now() + (callTTLSeconds * 1000)).toISOString(),
                dedupeKey: `call:${callData.callId}`,
                callCategory: "incoming-call",
            }, tenantId),
            // Android: high-priority DATA-ONLY message wakes the RN Firebase
            // headless JS handler. Do not include `android.notification` here:
            // the mobile app/Notifee must render the full-screen call UI itself.
            android: {
                priority: "high",
            },
            // iOS: use a high-priority alert/VoIP push so the handler runs and
            // CallKit can present the incoming-call UI.
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

        logger.info(
            {
                event: "push_dispatch_attempt",
                notificationType: "call",
                tenantId,
                userId,
                callId: callData.callId,
                conversationId: callData.conversationId,
                dedupeKey: payload.data.dedupeKey,
                channelId: payload.android?.notification?.channelId || payload.data.callCategory || "calls",
                tokenCount: tokens.length,
            },
            "Dispatching call notification push",
        );

        // P2.12 — Push send verification + WS fallback.
        // The WS `call_incoming` event (emitted by the call_initiate handler in
        // server/utils/ws.ts BEFORE this push is dispatched) is the GUARANTEED
        // fallback for any callee device that already has a live socket. This
        // push only matters for backgrounded/locked/killed devices that the WS
        // event can't wake. So when EVERY token fails (succeeded === 0 despite
        // having tokens), it means the only delivery path for an
        // offline/backgrounded device just failed — we log a STRUCTURED error
        // (so it's alertable) and attempt ONE retry before giving up. A live
        // device will still ring via the WS event regardless of this outcome.
        let result = await this.sendToDevices(query, tokens, payload, `call-${callData.callId}`);

        if (result.succeeded === 0) {
            logger.error(
                {
                    event: "push_call_all_failed",
                    notificationType: "call",
                    tenantId,
                    userId,
                    callId: callData.callId,
                    conversationId: callData.conversationId,
                    dedupeKey: payload.data.dedupeKey,
                    tokenCount: tokens.length,
                    failed: result.failed,
                    note: "WS call_incoming remains the alive-device fallback; retrying push once",
                },
                "Call push notification failed for ALL device tokens — retrying once",
            );

            // Optional single retry. Re-fetch tokens in case invalid ones were
            // purged by the failed attempt; if none remain there is nothing to
            // retry (the WS event still covers any live device).
            const retryTokens = await this.getDeviceTokens(query, userId, tenantId);
            if (retryTokens.length > 0) {
                const retryResult = await this.sendToDevices(query, retryTokens, payload, `call-${callData.callId}-retry`);
                result = {
                    succeeded: retryResult.succeeded,
                    failed: retryResult.failed,
                };
                if (retryResult.succeeded === 0) {
                    logger.error(
                        {
                            event: "push_call_retry_failed",
                            notificationType: "call",
                            tenantId,
                            userId,
                            callId: callData.callId,
                            conversationId: callData.conversationId,
                            dedupeKey: payload.data.dedupeKey,
                            tokenCount: retryTokens.length,
                            failed: retryResult.failed,
                            note: "WS call_incoming remains the alive-device fallback",
                        },
                        "Call push notification retry also failed for ALL device tokens",
                    );
                }
            }
        }

        return result;
    }

    /**
     * Send a DATA-ONLY high-priority "call handled elsewhere" push so a twin
     * device (locked/backgrounded) stops ringing once the call is
     * accepted/rejected/cancelled on another device (or by the caller).
     *
     * The mobile background/headless handler watches for
     * `type === "call_handled_elsewhere"` and dismisses the active incoming-call
     * UI (Notifee/CallKeep) for the matching `callId`.
     */
    async sendCallCancellation(
        query: QueryFn,
        userId: number,
        tenantId: number | null,
        cancelData: {
            callId: number;
            conversationId: number;
            reason?: string;
        },
    ): Promise<{ succeeded: number; failed: number }> {
        if (!this.initialized || !this.app) {
            return { succeeded: 0, failed: 0 };
        }

        const tokens = await this.getDeviceTokens(query, userId, tenantId);
        if (tokens.length === 0) {
            logger.info(
                { event: "push_skip_no_tokens", notificationType: "call_cancel", userId, tenantId, callId: cancelData.callId },
                "No device tokens for call cancellation recipient",
            );
            return { succeeded: 0, failed: 0 };
        }

        // DATA-ONLY high-priority message — wakes the background/headless handler
        // so it can dismiss the active ring. No `notification` block on Android.
        const payload: FCMPayload = {
            data: this.buildCommonData({
                type: "call_handled_elsewhere",
                callId: String(cancelData.callId),
                conversationId: String(cancelData.conversationId),
                reason: cancelData.reason || "handled_elsewhere",
                dedupeKey: `call_cancel:${cancelData.callId}`,
            }, tenantId),
            android: {
                priority: "high",
            },
            apns: {
                headers: {
                    "apns-priority": "10",
                    "apns-push-type": "background",
                },
                payload: {
                    aps: {
                        // Background/silent push so CallKit/JS can dismiss the call.
                        alert: { title: "", body: "" },
                        sound: "",
                        "mutable-content": 1,
                    },
                },
            },
        };

        logger.info(
            {
                event: "push_dispatch_attempt",
                notificationType: "call_cancel",
                tenantId,
                userId,
                callId: cancelData.callId,
                conversationId: cancelData.conversationId,
                reason: cancelData.reason,
                dedupeKey: payload.data.dedupeKey,
                tokenCount: tokens.length,
            },
            "Dispatching call cancellation push",
        );

        return this.sendToDevices(query, tokens, payload, `call-cancel-${cancelData.callId}`);
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
            logger.info({ event: "push_skip_no_tokens", notificationType: "message", userId, tenantId, messageId: messageData.messageId }, "No device tokens for message notification recipient");
            return { succeeded: 0, failed: 0 };
        }

        const preview = messageData.messagePreview.substring(0, 150);
        const unreadCount = messageData.unreadCount || 1;

        // ANDROID DATA-ONLY (messages): chat messages are sent DATA-ONLY on
        // Android (no top-level `notification` block, no `android.notification`)
        // — exactly like CALLS — so the app's background/headless handler ALWAYS
        // runs and renders the notification itself via Notifee. This is the ONLY
        // way to attach the sender's CIRCULAR avatar as the notification
        // largeIcon: the avatar lives behind the server's `/uploads` auth
        // middleware, so it must be downloaded WITH a Bearer token (which an
        // OS-rendered FCM `notification` message cannot do) and clipped to a
        // circle. Previously messages used a HYBRID payload (top-level
        // `notification` + `android.notification`), which made Android render the
        // message itself and BYPASS the headless handler — so the avatar never
        // showed (calls always showed it because they were data-only). We keep
        // `androidDataOnly` so sendToDevices omits the top-level `notification`
        // from the Android multicast; the webpush notification (desktop/browser)
        // and the iOS APNs alert are still rendered. In every Android state
        // (foreground via onMessage, background/killed via the headless task) the
        // handler calls notifeeService.displayMessage, which fetches the authed
        // avatar and posts it as a circular largeIcon.
        const payload: FCMPayload = {
            // Used ONLY for the webpush (desktop/browser) notification render —
            // NOT applied to the Android multicast because androidDataOnly is set
            // below (see sendToDevices).
            notification: {
                title: messageData.senderName,
                body: preview,
            },
            androidDataOnly: true,
            data: this.buildCommonData({
                type: "chat_message",
                title: messageData.senderName,
                body: preview,
                conversationId: String(messageData.conversationId),
                messageId: String(messageData.messageId),
                senderId: String(messageData.senderId),
                senderName: messageData.senderName,
                // Carry the sender's avatar so the mobile client can render it as
                // the notification largeIcon (chat-avatar parity with calls, which
                // already send callerAvatar). Empty string when the sender has no
                // avatar — the client falls back to the app icon.
                senderAvatar: messageData.senderAvatar || "",
                unreadCount: String(unreadCount),
                badgeCount: String(unreadCount),
                dedupeKey: `msg:${messageData.messageId}`,
                // T031: Add expiry for payload freshness validation (1 hour TTL)
                expiresAt: String(Math.floor(Date.now() / 1000) + 3600),
            }, tenantId),
            // Android: high-priority DATA-ONLY message (no `android.notification`)
            // so the RN Firebase headless/background handler runs and renders the
            // message via Notifee with the sender's circular avatar largeIcon.
            android: {
                priority: "high",
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

        logger.info(
            {
                event: "push_dispatch_attempt",
                notificationType: "message",
                tenantId,
                userId,
                conversationId: messageData.conversationId,
                messageId: messageData.messageId,
                unreadCount,
                dedupeKey: payload.data.dedupeKey,
                channelId: payload.android?.notification?.channelId || "messages",
                recipientCount: tokens.length,
            },
            "Dispatching message notification push",
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
            // Server-authoritative total unread/alert count for the launcher
            // badge (defaults to 1 when omitted).
            badgeCount?: number;
            // Optional avatar of the user who triggered this alert (the "actor"
            // — e.g. the assigner of a task, the approver of a leave request).
            // When present the mobile client renders it as the notification's
            // circular largeIcon (chat-avatar parity); when absent the client
            // falls back to the org branding logo, and the app-logo silhouette
            // is always the status-bar smallIcon.
            actorAvatar?: string;
            actorName?: string;
        },
    ): Promise<{ succeeded: number; failed: number }> {
        if (!this.initialized || !this.app) {
            return { succeeded: 0, failed: 0 };
        }

        const tokens = await this.getDeviceTokens(query, userId, tenantId);
        if (tokens.length === 0) {
            logger.info({ event: "push_skip_no_tokens", notificationType: "notification", userId, tenantId, notificationId: notificationData.notificationId }, "No device tokens for alert notification recipient");
            return { succeeded: 0, failed: 0 };
        }

        // IMPORTANT: Like message pushes, alert pushes are DATA-ONLY on Android
        // (no top-level `notification` block and no `android.notification`). A
        // payload containing a `notification` block is handed straight to the
        // Android system tray and does NOT invoke the app's background/headless
        // message handler when backgrounded/killed, and is NOT auto-displayed by
        // RN Firebase's `onMessage` in the foreground — so foreground alerts were
        // silently dropped and the headless path was bypassed. Routing alerts
        // through `data` makes the app's handler post them via Notifee in all
        // states (foreground/background/killed). Title/body travel in `data`.
        // The webpush.notification block (added in sendToDevices) still renders
        // the browser/desktop alert. iOS keeps its visible APNs alert below.
        const badge = notificationData.badgeCount ?? 1;
        const payload: FCMPayload = {
            data: this.buildCommonData({
                notificationId: String(notificationData.notificationId),
                type: notificationData.type || "notification",
                title: notificationData.title,
                body: notificationData.body,
                badgeCount: String(badge),
                dedupeKey: `notif:${notificationData.notificationId}`,
                // Carry the actor's avatar/name so the mobile client can render
                // the triggering user's circular avatar as the notification
                // largeIcon (chat-avatar parity). Empty when there is no actor —
                // the client then falls back to the org branding logo, and the
                // app-logo silhouette is always the status-bar smallIcon.
                actorAvatar: notificationData.actorAvatar || "",
                actorName: notificationData.actorName || "",
            }, tenantId),
            // Keep webpush rendering via the optional notification block below by
            // exposing title/body to sendToDevices.
            notification: {
                title: notificationData.title,
                body: notificationData.body,
            },
            android: {
                priority: "high",
            },
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
                        badge,
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
            const message = (err as Error).message || "";
            // Distinguish a missing table (tenant DB schema not migrated) from a
            // genuine query error. A missing `device_tokens` relation means the
            // migration `2026_06_v13_push_notification_device_tokens` (or the
            // base initTenantSchema) never ran for this tenant — device-token
            // registration INSERTs are also failing, so NO push is ever sent.
            if (/device_tokens.*does not exist|relation .*device_tokens/i.test(message)) {
                logger.error(
                    { err: message, userId, tenantId },
                    "device_tokens table missing for tenant — run migrations (initTenantSchema / 2026_06_v13). Push notifications disabled until fixed.",
                );
            } else {
                logger.error({ err: message, userId, tenantId }, "Failed to get device tokens");
            }
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
            // `androidDataOnly` (chat messages) keeps the top-level
            // `notification` block OFF the multicast so Android delivers a
            // DATA-ONLY message — the app's headless/background handler then
            // renders it via Notifee WITH the sender's circular avatar largeIcon
            // (an OS-rendered FCM notification can't fetch the authed avatar).
            // The webpush block below still renders the desktop/browser
            // notification, and iOS still renders via `apns.payload.aps.alert`.
            const includeTopLevelNotification =
                !!payload.notification && !payload.androidDataOnly;
            const response = await getMessaging(this.app!).sendEachForMulticast({
                tokens,
                // Omitted for data-only payloads (e.g. incoming calls AND chat
                // messages) so Android delivers a data message that wakes the
                // background/headless handler.
                ...(includeTopLevelNotification
                    ? { notification: payload.notification }
                    : {}),
                data: payload.data,
                android: payload.android,
                apns: payload.apns,
                webpush: {
                    data: payload.data,
                    ...(payload.notification
                        ? {
                              notification: {
                                  title: payload.notification.title,
                                  body: payload.notification.body,
                                  icon: "/icon-192.png",
                              },
                          }
                        : {}),
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
                {
                    event: "push_dispatch_result",
                    collapseKey,
                    notificationType: payload.data.type || (payload.data.callId ? "call" : "notification"),
                    tenantId: payload.data.tenantId || null,
                    dedupeKey: payload.data.dedupeKey || null,
                    channelId: payload.android?.notification?.channelId,
                    tokenCount: tokens.length,
                    sent: response.successCount,
                    failed: response.failureCount,
                },
                "Push notifications sent",
            );
        } catch (err) {
            logger.error(
                {
                    event: "push_dispatch_failed",
                    err: (err as Error).message,
                    collapseKey,
                    notificationType: payload.data.type || (payload.data.callId ? "call" : "notification"),
                    tenantId: payload.data.tenantId || null,
                    dedupeKey: payload.data.dedupeKey || null,
                    channelId: payload.android?.notification?.channelId,
                    tokenCount: tokens.length,
                },
                "Failed to send push notifications",
            );
            failed = tokens.length;
        }

        return { succeeded, failed };
    }
}

export const pushNotifications = new PushNotificationService();

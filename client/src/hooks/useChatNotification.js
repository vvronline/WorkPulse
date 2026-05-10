import { useRef, useCallback } from 'react';
import { useNotificationPrefs } from '../NotificationPrefsContext';

/* ─── Browser Notification helper ────────────────────────────────────── */

function showBrowserNotification(title, body, tag) {
    if (typeof Notification === 'undefined') return;
    if (Notification.permission !== 'granted') return;
    if (document.visibilityState === 'visible' && document.hasFocus()) return;

    try {
        new Notification(title, {
            body: body?.slice(0, 200),
            tag: tag || 'workpulse-chat',
            icon: '/icon-192.svg',
            silent: true, // we play our own sound (controlled via NotificationPrefsContext)
        });
    } catch { /* ignore */ }
}

/* ─── Throttle helper (one sound per type per interval) ──────────────── */

const THROTTLE_MS = 1500;

/* ─── Main hook ──────────────────────────────────────────────────────── */

/**
 * Returns helpers to fire chat notification sounds + browser notifications.
 * Sounds are routed through `NotificationPrefsContext` so they respect the
 * user's chosen tones, volumes and the master mute toggle.
 *
 * Call `requestPermission()` once (on user gesture) to enable browser notifs.
 */
export default function useChatNotification() {
    const lastPlayed = useRef({});
    const { playMessageTone, playMentionTone, playReactionTone } = useNotificationPrefs();

    const throttled = useCallback((key, playFn) => {
        const now = Date.now();
        if (now - (lastPlayed.current[key] || 0) < THROTTLE_MS) return;
        lastPlayed.current[key] = now;
        playFn();
    }, []);

    /** New chat message from someone else */
    const notifyMessage = useCallback((senderName, content, conversationId) => {
        throttled('message', playMessageTone);
        showBrowserNotification(
            senderName || 'New message',
            content || 'Sent a file',
            `chat-msg-${conversationId}`
        );
    }, [throttled, playMessageTone]);

    /** @mention in chat */
    const notifyMention = useCallback((senderName, content, conversationId) => {
        throttled('mention', playMentionTone);
        showBrowserNotification(
            `${senderName || 'Someone'} mentioned you`,
            content || '',
            `chat-mention-${conversationId}`
        );
    }, [throttled, playMentionTone]);

    /** Reaction added to your message */
    const notifyReaction = useCallback(() => {
        throttled('reaction', playReactionTone);
    }, [throttled, playReactionTone]);

    /** General notification (leave, task, approval, meeting) */
    const notifyGeneral = useCallback((title, body) => {
        throttled('general', playMentionTone);
        showBrowserNotification(title || 'Notification', body);
    }, [throttled, playMentionTone]);

    /** Request browser notification permission (call on user gesture) */
    const requestPermission = useCallback(() => {
        if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
            Notification.requestPermission();
        }
    }, []);

    return { notifyMessage, notifyMention, notifyReaction, notifyGeneral, requestPermission };
}
import { useRef, useCallback } from 'react';

/* ─── Synthesised notification sounds via Web Audio API ──────────────── */

let audioCtx = null;
function getAudioCtx() {
    if (!audioCtx || audioCtx.state === 'closed') {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (audioCtx.state === 'suspended') audioCtx.resume();
    return audioCtx;
}

/** Short rising two-tone "ding" for new messages */
function playMessageSound() {
    try {
        const ctx = getAudioCtx();
        const gain = ctx.createGain();
        gain.connect(ctx.destination);
        gain.gain.setValueAtTime(0.18, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.35);

        const osc1 = ctx.createOscillator();
        osc1.type = 'sine';
        osc1.frequency.setValueAtTime(880, ctx.currentTime);
        osc1.connect(gain);
        osc1.start(ctx.currentTime);
        osc1.stop(ctx.currentTime + 0.12);

        const osc2 = ctx.createOscillator();
        osc2.type = 'sine';
        osc2.frequency.setValueAtTime(1174.66, ctx.currentTime + 0.12);
        osc2.connect(gain);
        osc2.start(ctx.currentTime + 0.12);
        osc2.stop(ctx.currentTime + 0.35);
    } catch { /* audio not available */ }
}

/** Softer single blip for reactions / edits / pins */
function playSubtleSound() {
    try {
        const ctx = getAudioCtx();
        const gain = ctx.createGain();
        gain.connect(ctx.destination);
        gain.gain.setValueAtTime(0.10, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.15);

        const osc = ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(1046.50, ctx.currentTime); // C6
        osc.connect(gain);
        osc.start(ctx.currentTime);
        osc.stop(ctx.currentTime + 0.15);
    } catch { /* audio not available */ }
}

/** Three-tone alert for mentions / notifications */
function playMentionSound() {
    try {
        const ctx = getAudioCtx();
        const notes = [783.99, 987.77, 1174.66]; // G5, B5, D6
        notes.forEach((freq, i) => {
            const gain = ctx.createGain();
            gain.connect(ctx.destination);
            const t = ctx.currentTime + i * 0.1;
            gain.gain.setValueAtTime(0.15, t);
            gain.gain.exponentialRampToValueAtTime(0.001, t + 0.15);

            const osc = ctx.createOscillator();
            osc.type = 'sine';
            osc.frequency.setValueAtTime(freq, t);
            osc.connect(gain);
            osc.start(t);
            osc.stop(t + 0.15);
        });
    } catch { /* audio not available */ }
}

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
            silent: true, // we play our own sound
        });
    } catch { /* ignore */ }
}

/* ─── Throttle helper (one sound per type per interval) ──────────────── */

const THROTTLE_MS = 1500;

/* ─── Main hook ──────────────────────────────────────────────────────── */

/**
 * Returns helpers to fire chat notification sounds + browser notifications.
 * Call `requestPermission()` once (on user gesture) to enable browser notifs.
 */
export default function useChatNotification() {
    const lastPlayed = useRef({});

    const throttled = useCallback((key, playFn) => {
        const now = Date.now();
        if (now - (lastPlayed.current[key] || 0) < THROTTLE_MS) return;
        lastPlayed.current[key] = now;
        playFn();
    }, []);

    /** New chat message from someone else */
    const notifyMessage = useCallback((senderName, content, conversationId) => {
        throttled('message', playMessageSound);
        showBrowserNotification(
            senderName || 'New message',
            content || 'Sent a file',
            `chat-msg-${conversationId}`
        );
    }, [throttled]);

    /** @mention in chat */
    const notifyMention = useCallback((senderName, content, conversationId) => {
        throttled('mention', playMentionSound);
        showBrowserNotification(
            `${senderName || 'Someone'} mentioned you`,
            content || '',
            `chat-mention-${conversationId}`
        );
    }, [throttled]);

    /** Reaction added to your message */
    const notifyReaction = useCallback(() => {
        throttled('reaction', playSubtleSound);
    }, [throttled]);

    /** General notification (leave, task, approval, meeting) */
    const notifyGeneral = useCallback((title, body) => {
        throttled('general', playMentionSound);
        showBrowserNotification(title || 'Notification', body);
    }, [throttled]);

    /** Request browser notification permission (call on user gesture) */
    const requestPermission = useCallback(() => {
        if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
            Notification.requestPermission();
        }
    }, []);

    return { notifyMessage, notifyMention, notifyReaction, notifyGeneral, requestPermission };
}

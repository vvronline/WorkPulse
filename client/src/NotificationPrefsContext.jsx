import React, { createContext, useContext, useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { useAuth } from './AuthContext';
import { getNotificationPrefs, updateNotificationPrefs } from './api';
import { DEFAULT_PREFS, playSound, previewSound } from './utils/sounds';

const NotificationPrefsContext = createContext(null);

const LS_KEY = 'workpulse.notificationPrefs';

function loadFromCache() {
    try {
        const raw = localStorage.getItem(LS_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') return parsed;
    } catch { /* corrupted */ }
    return null;
}

function saveToCache(prefs) {
    try { localStorage.setItem(LS_KEY, JSON.stringify(prefs)); } catch { /* quota */ }
}

export function NotificationPrefsProvider({ children }) {
    const { isAuthenticated, user } = useAuth();

    // Merge defaults <- localStorage cache <- server response so the first
    // render already has sane values without flicker.
    const initial = useMemo(() => ({ ...DEFAULT_PREFS, ...(loadFromCache() || {}) }), []);
    const [prefs, setPrefs] = useState(initial);
    const saveTimerRef = useRef(null);
    const initialLoadDoneRef = useRef(false);

    // Pull canonical prefs from the server when user logs in. Falls back to
    // the cached/default prefs if the request fails (offline, server down).
    useEffect(() => {
        if (!isAuthenticated) return;
        // If the auth profile already shipped notification_prefs, prefer that
        // (avoids the extra round-trip on initial app load).
        if (user?.notification_prefs && Object.keys(user.notification_prefs).length > 0) {
            const merged = { ...DEFAULT_PREFS, ...user.notification_prefs };
            setPrefs(merged);
            saveToCache(merged);
            initialLoadDoneRef.current = true;
            return;
        }
        let cancelled = false;
        getNotificationPrefs()
            .then(res => {
                if (cancelled) return;
                const merged = { ...DEFAULT_PREFS, ...(res.data || {}) };
                setPrefs(merged);
                saveToCache(merged);
                initialLoadDoneRef.current = true;
            })
            .catch(() => {
                initialLoadDoneRef.current = true;
            });
        return () => { cancelled = true; };
    }, [isAuthenticated, user?.id]);

    /**
     * Update prefs locally, persist to localStorage immediately, debounce-save
     * to the server. Returns the merged result so callers can chain.
     */
    const updatePrefs = useCallback((partial) => {
        setPrefs(prev => {
            const merged = { ...prev, ...partial };
            saveToCache(merged);

            // Debounce server save (avoid spamming PUT while user drags slider)
            clearTimeout(saveTimerRef.current);
            saveTimerRef.current = setTimeout(() => {
                if (!isAuthenticated) return;
                updateNotificationPrefs(partial).catch(() => {
                    /* will retry on next change; cache already saved */
                });
            }, 500);

            return merged;
        });
    }, [isAuthenticated]);

    const resetPrefs = useCallback(() => {
        setPrefs(DEFAULT_PREFS);
        saveToCache(DEFAULT_PREFS);
        clearTimeout(saveTimerRef.current);
        if (isAuthenticated) {
            // Push every default field so the server stores a complete record.
            const { v: _v, ...rest } = DEFAULT_PREFS;
            updateNotificationPrefs(rest).catch(() => { });
        }
    }, [isAuthenticated]);

    /* ─── Playback helpers used by the rest of the app ───────────────── */

    const shouldPlay = useCallback(() => {
        if (prefs.muteAll) return false;
        // Slack/Teams default: don't play when the tab is focused unless the
        // user has explicitly opted in.
        if (typeof document !== 'undefined') {
            const focused = document.visibilityState === 'visible' && document.hasFocus();
            if (focused && !prefs.playWhenFocused) return false;
        }
        return true;
    }, [prefs.muteAll, prefs.playWhenFocused]);

    /** Start the incoming-call ringtone (loops). Returns a stop() fn. */
    const playRingtone = useCallback(() => {
        if (prefs.muteAll) return () => { };
        // Ringtones always play (even if window focused) — incoming calls
        // are always urgent.
        return playSound('ringtone', prefs.ringtone, {
            volume: prefs.ringtoneVolume ?? DEFAULT_PREFS.ringtoneVolume,
            loop: true,
        });
    }, [prefs.muteAll, prefs.ringtone, prefs.ringtoneVolume]);

    /** Start the outgoing dial ring-back (loops). Returns a stop() fn. */
    const playOutgoing = useCallback(() => {
        if (prefs.muteAll) return () => { };
        return playSound('outgoing', prefs.outgoingTone, {
            volume: prefs.outgoingVolume ?? DEFAULT_PREFS.outgoingVolume,
            loop: true,
        });
    }, [prefs.muteAll, prefs.outgoingTone, prefs.outgoingVolume]);

    const playMessageTone = useCallback(() => {
        if (!shouldPlay()) return;
        playSound('message', prefs.messageTone, {
            volume: prefs.messageVolume ?? DEFAULT_PREFS.messageVolume,
        });
    }, [shouldPlay, prefs.messageTone, prefs.messageVolume]);

    const playMentionTone = useCallback(() => {
        if (!shouldPlay()) return;
        playSound('mention', prefs.mentionTone, {
            volume: prefs.mentionVolume ?? DEFAULT_PREFS.mentionVolume,
        });
    }, [shouldPlay, prefs.mentionTone, prefs.mentionVolume]);

    const playReactionTone = useCallback(() => {
        if (!shouldPlay()) return;
        playSound('reaction', prefs.reactionTone, {
            volume: prefs.reactionVolume ?? DEFAULT_PREFS.reactionVolume,
        });
    }, [shouldPlay, prefs.reactionTone, prefs.reactionVolume]);

    /** Preview a specific preset id at a specific volume (for the settings UI). */
    const preview = useCallback((category, id, volume) => {
        previewSound(category, id, volume);
    }, []);

    const value = useMemo(() => ({
        prefs,
        updatePrefs,
        resetPrefs,
        playRingtone,
        playOutgoing,
        playMessageTone,
        playMentionTone,
        playReactionTone,
        preview,
    }), [prefs, updatePrefs, resetPrefs, playRingtone, playOutgoing, playMessageTone, playMentionTone, playReactionTone, preview]);

    return (
        <NotificationPrefsContext.Provider value={value}>
            {children}
        </NotificationPrefsContext.Provider>
    );
}

export function useNotificationPrefs() {
    const ctx = useContext(NotificationPrefsContext);
    if (!ctx) {
        // Safe fallback so components that may render before the provider
        // mounts don't crash. Returns no-op helpers + defaults.
        return {
            prefs: DEFAULT_PREFS,
            updatePrefs: () => { },
            resetPrefs: () => { },
            playRingtone: () => () => { },
            playOutgoing: () => () => { },
            playMessageTone: () => { },
            playMentionTone: () => { },
            playReactionTone: () => { },
            preview: () => { },
        };
    }
    return ctx;
}
import {
    createContext,
    useContext,
    useEffect,
    useMemo,
    useRef,
    useState,
    useCallback,
    type ReactNode,
} from "react";
import { useAuth } from "./AuthContext";
import { getNotificationPrefs, updateNotificationPrefs } from "./api";
import {
    DEFAULT_PREFS,
    playSound,
    previewSound,
    type SoundCategory,
} from "./utils/sounds";

export type NotificationPrefs = typeof DEFAULT_PREFS;

interface NotificationPrefsContextValue {
    prefs: NotificationPrefs;
    updatePrefs: (partial: Partial<NotificationPrefs>) => void;
    resetPrefs: () => void;
    playRingtone: () => () => void;
    playOutgoing: () => () => void;
    playMessageTone: () => void;
    playMentionTone: () => void;
    playReactionTone: () => void;
    preview: (category: SoundCategory, id: string, volume?: number) => void;
}

const NotificationPrefsContext =
    createContext<NotificationPrefsContextValue | null>(null);

const LS_KEY = "workpulse.notificationPrefs";

function loadFromCache(): Partial<NotificationPrefs> | null {
    try {
        const raw = localStorage.getItem(LS_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object") return parsed;
    } catch {
        /* corrupted */
    }
    return null;
}

function saveToCache(prefs: NotificationPrefs) {
    try {
        localStorage.setItem(LS_KEY, JSON.stringify(prefs));
    } catch {
        /* quota */
    }
}

export function NotificationPrefsProvider({
    children,
}: {
    children: ReactNode;
}) {
    const { isAuthenticated, user } = useAuth();

    // Merge defaults <- localStorage cache <- server response so the first
    // render already has sane values without flicker.
    const initial = useMemo(
        () => ({ ...DEFAULT_PREFS, ...(loadFromCache() || {}) }),
        [],
    );
    const [prefs, setPrefs] = useState<NotificationPrefs>(initial);
    const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const initialLoadDoneRef = useRef(false);

    // Pull canonical prefs from the server when user logs in. Falls back to
    // the cached/default prefs if the request fails (offline, server down).
    useEffect(() => {
        if (!isAuthenticated) return;
        // If the auth profile already shipped notification_prefs, prefer that
        // (avoids the extra round-trip on initial app load).
        const userPrefs = user?.notification_prefs as
            | Partial<NotificationPrefs>
            | undefined;
        if (userPrefs && Object.keys(userPrefs).length > 0) {
            const merged = { ...DEFAULT_PREFS, ...userPrefs };
            setPrefs(merged);
            saveToCache(merged);
            initialLoadDoneRef.current = true;
            return;
        }
        let cancelled = false;
        getNotificationPrefs()
            .then((res) => {
                if (cancelled) return;
                const merged = { ...DEFAULT_PREFS, ...(res.data || {}) };
                setPrefs(merged);
                saveToCache(merged);
                initialLoadDoneRef.current = true;
            })
            .catch(() => {
                initialLoadDoneRef.current = true;
            });
        return () => {
            cancelled = true;
        };
    }, [isAuthenticated, user?.id]);

    /**
     * Update prefs locally, persist to localStorage immediately, debounce-save
     * to the server. Returns the merged result so callers can chain.
     */
    const updatePrefs = useCallback(
        (partial: Partial<NotificationPrefs>) => {
            setPrefs((prev) => {
                const merged = { ...prev, ...partial };
                saveToCache(merged);

                // Debounce server save (avoid spamming PUT while user drags slider)
                if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
                saveTimerRef.current = setTimeout(() => {
                    if (!isAuthenticated) return;
                    updateNotificationPrefs(partial).catch(() => {
                        /* will retry on next change; cache already saved */
                    });
                }, 500);

                return merged;
            });
        },
        [isAuthenticated],
    );

    const resetPrefs = useCallback(() => {
        setPrefs(DEFAULT_PREFS);
        saveToCache(DEFAULT_PREFS);
        if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
        if (isAuthenticated) {
            // Push every default field so the server stores a complete record.
            const { v: _v, ...rest } = DEFAULT_PREFS;
            void _v;
            updateNotificationPrefs(rest).catch(() => {});
        }
    }, [isAuthenticated]);

    /* ─── Playback helpers used by the rest of the app ───────────────── */

    const shouldPlay = useCallback(() => {
        if (prefs.muteAll) return false;
        // Slack/Teams default: don't play when the tab is focused unless the
        // user has explicitly opted in.
        if (typeof document !== "undefined") {
            const focused =
                document.visibilityState === "visible" && document.hasFocus();
            if (focused && !prefs.playWhenFocused) return false;
        }
        return true;
    }, [prefs.muteAll, prefs.playWhenFocused]);

    /** Start the incoming-call ringtone (loops). Returns a stop() fn. */
    const playRingtone = useCallback(() => {
        if (prefs.muteAll) return () => {};
        // Ringtones always play (even if window focused) — incoming calls
        // are always urgent.
        return playSound("ringtone", prefs.ringtone, {
            volume: prefs.ringtoneVolume ?? DEFAULT_PREFS.ringtoneVolume,
            loop: true,
        });
    }, [prefs.muteAll, prefs.ringtone, prefs.ringtoneVolume]);

    /** Start the outgoing dial ring-back (loops). Returns a stop() fn. */
    const playOutgoing = useCallback(() => {
        if (prefs.muteAll) return () => {};
        return playSound("outgoing", prefs.outgoingTone, {
            volume: prefs.outgoingVolume ?? DEFAULT_PREFS.outgoingVolume,
            loop: true,
        });
    }, [prefs.muteAll, prefs.outgoingTone, prefs.outgoingVolume]);

    const playMessageTone = useCallback(() => {
        if (!shouldPlay()) return;
        playSound("message", prefs.messageTone, {
            volume: prefs.messageVolume ?? DEFAULT_PREFS.messageVolume,
        });
    }, [shouldPlay, prefs.messageTone, prefs.messageVolume]);

    const playMentionTone = useCallback(() => {
        if (!shouldPlay()) return;
        playSound("mention", prefs.mentionTone, {
            volume: prefs.mentionVolume ?? DEFAULT_PREFS.mentionVolume,
        });
    }, [shouldPlay, prefs.mentionTone, prefs.mentionVolume]);

    const playReactionTone = useCallback(() => {
        if (!shouldPlay()) return;
        playSound("reaction", prefs.reactionTone, {
            volume: prefs.reactionVolume ?? DEFAULT_PREFS.reactionVolume,
        });
    }, [shouldPlay, prefs.reactionTone, prefs.reactionVolume]);

    /** Preview a specific preset id at a specific volume (for the settings UI). */
    const preview = useCallback(
        (category: SoundCategory, id: string, volume?: number) => {
            previewSound(category, id, volume);
        },
        [],
    );

    const value = useMemo(
        () => ({
            prefs,
            updatePrefs,
            resetPrefs,
            playRingtone,
            playOutgoing,
            playMessageTone,
            playMentionTone,
            playReactionTone,
            preview,
        }),
        [
            prefs,
            updatePrefs,
            resetPrefs,
            playRingtone,
            playOutgoing,
            playMessageTone,
            playMentionTone,
            playReactionTone,
            preview,
        ],
    );

    return (
        <NotificationPrefsContext.Provider value={value}>
            {children}
        </NotificationPrefsContext.Provider>
    );
}

export function useNotificationPrefs(): NotificationPrefsContextValue {
    const ctx = useContext(NotificationPrefsContext);
    if (!ctx) {
        // Safe fallback so components that may render before the provider
        // mounts don't crash. Returns no-op helpers + defaults.
        return {
            prefs: DEFAULT_PREFS,
            updatePrefs: () => {},
            resetPrefs: () => {},
            playRingtone: () => () => {},
            playOutgoing: () => () => {},
            playMessageTone: () => {},
            playMentionTone: () => {},
            playReactionTone: () => {},
            preview: () => {},
        };
    }
    return ctx;
}
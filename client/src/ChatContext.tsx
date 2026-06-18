import {
    createContext,
    useContext,
    useState,
    useEffect,
    useCallback,
    useMemo,
    type ReactNode,
} from "react";
import { getConversations } from "./api";
import { useAuth } from "./AuthContext";
import type { Conversation } from "./types";

interface ChatContextValue {
    unreadCount: number;
    refreshUnread: () => Promise<void> | void;
}

const ChatCtx = createContext<ChatContextValue>({
    unreadCount: 0,
    refreshUnread: () => {},
});

export function ChatProvider({ children }: { children: ReactNode }) {
    const { isAuthenticated } = useAuth();
    const [unreadCount, setUnreadCount] = useState(0);

    const refreshUnread = useCallback(async () => {
        if (!isAuthenticated) {
            setUnreadCount(0);
            return;
        }
        try {
            const { data } = await getConversations();
            setUnreadCount(
                ((data as Conversation[]) || []).reduce(
                    (sum, c) => sum + (Number(c.unread_count) || 0),
                    0,
                ),
            );
        } catch {
            /* ignore */
        }
    }, [isAuthenticated]);

    useEffect(() => {
        refreshUnread();
    }, [refreshUnread]);

    // Mirror the unread total onto the desktop taskbar/dock badge (Electron)
    // and the PWA app badge so the OS shows e.g. "3" without the window open.
    // Cleared to 0 automatically when everything is read.
    useEffect(() => {
        const total = Math.max(0, unreadCount);
        try {
            (window as any).electronAPI?.setBadgeCount?.(total);
        } catch {
            /* ignore — non-Electron or older preload */
        }
        try {
            if (typeof (navigator as any).setAppBadge === "function") {
                if (total > 0) (navigator as any).setAppBadge(total);
                else (navigator as any).clearAppBadge?.();
            }
        } catch {
            /* ignore — Badging API unsupported */
        }
    }, [unreadCount]);

    const value = useMemo(
        () => ({ unreadCount, refreshUnread }),
        [unreadCount, refreshUnread],
    );

    return <ChatCtx.Provider value={value}>{children}</ChatCtx.Provider>;
}

export const useChatUnread = () => useContext(ChatCtx);
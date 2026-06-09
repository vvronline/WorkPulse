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

    const value = useMemo(
        () => ({ unreadCount, refreshUnread }),
        [unreadCount, refreshUnread],
    );

    return <ChatCtx.Provider value={value}>{children}</ChatCtx.Provider>;
}

export const useChatUnread = () => useContext(ChatCtx);
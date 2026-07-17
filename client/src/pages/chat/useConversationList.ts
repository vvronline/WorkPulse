import { useCallback, useEffect, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { getConversations, getPresence } from "../../api";
import type { AnyRecord } from "../../types";

export type ChatConversation = AnyRecord & { id: number | string };

type UseConversationListOptions = {
    updateUnreadFromConversations: (
        conversations: Array<{ [key: string]: unknown; unread_count?: unknown }>,
    ) => void;
};

type UseConversationListResult = {
    conversations: ChatConversation[];
    setConversations: Dispatch<SetStateAction<ChatConversation[]>>;
    loadingConversations: boolean;
    onlineUsers: Set<number | string>;
    setOnlineUsers: Dispatch<SetStateAction<Set<number | string>>>;
    userStatusMap: Record<string, string>;
    setUserStatusMap: Dispatch<SetStateAction<Record<string, string>>>;
    userWorkModeMap: Record<string, string | null>;
    loadConversations: () => Promise<void>;
};

/**
 * Owns conversation-list hydration and bulk presence resolution.
 *
 * The hook publishes the already-fetched list to ChatContext so unread badges
 * do not trigger a duplicate conversations request while the chat page is open.
 */
export default function useConversationList({
    updateUnreadFromConversations,
}: UseConversationListOptions): UseConversationListResult {
    const [conversations, setConversations] = useState<ChatConversation[]>([]);
    const [loadingConversations, setLoadingConversations] = useState(true);
    const [onlineUsers, setOnlineUsers] = useState<Set<number | string>>(
        new Set(),
    );
    const [userStatusMap, setUserStatusMap] = useState<Record<string, string>>(
        {},
    );
    const [userWorkModeMap, setUserWorkModeMap] = useState<
        Record<string, string | null>
    >({});

    const loadConversations = useCallback(async () => {
        setLoadingConversations(true);
        try {
            const { data } = await getConversations();
            const loaded = data as ChatConversation[];
            setConversations(loaded);
            updateUnreadFromConversations(loaded);

            const userIds = new Set<number | string>();
            loaded.forEach((conversation) => {
                if (conversation.other_user_id) {
                    userIds.add(
                        conversation.other_user_id as number | string,
                    );
                }
            });

            if (userIds.size > 0) {
                try {
                    const { data: presence } = await getPresence([...userIds]);
                    const nextOnline = new Set<number | string>();
                    const nextStatuses: Record<string, string> = {};
                    const nextWorkModes: Record<string, string | null> = {};

                    for (const [key, value] of Object.entries(
                        presence as Record<string, unknown>,
                    )) {
                        const userId = Number(key);
                        if (typeof value === "object" && value !== null) {
                            const resolved = value as {
                                presence?: string;
                                userStatus?: string;
                                workMode?: string | null;
                            };
                            const online = resolved.presence === "online";
                            if (online) nextOnline.add(userId);
                            nextStatuses[userId] = online
                                ? resolved.userStatus || "available"
                                : "offline";
                            nextWorkModes[userId] =
                                resolved.workMode ?? null;
                        } else {
                            if (value === "online") nextOnline.add(userId);
                            nextStatuses[userId] =
                                value === "online"
                                    ? "available"
                                    : "offline";
                            nextWorkModes[userId] = null;
                        }
                    }

                    setOnlineUsers(nextOnline);
                    setUserStatusMap((current) => ({
                        ...current,
                        ...nextStatuses,
                    }));
                    setUserWorkModeMap((current) => ({
                        ...current,
                        ...nextWorkModes,
                    }));
                } catch (error) {
                    console.error("Failed to load presence", error);
                }
            }
        } catch (error) {
            console.error("Failed to load conversations", error);
        } finally {
            setLoadingConversations(false);
        }
    }, [updateUnreadFromConversations]);

    useEffect(() => {
        void loadConversations();
    }, [loadConversations]);

    useEffect(() => {
        updateUnreadFromConversations(conversations);
    }, [conversations, updateUnreadFromConversations]);

    return {
        conversations,
        setConversations,
        loadingConversations,
        onlineUsers,
        setOnlineUsers,
        userStatusMap,
        setUserStatusMap,
        userWorkModeMap,
        loadConversations,
    };
}
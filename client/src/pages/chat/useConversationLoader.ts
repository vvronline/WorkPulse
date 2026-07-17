import { useCallback, useRef } from "react";
import type { Dispatch, MutableRefObject, RefObject, SetStateAction } from "react";
import {
    getMembers,
    getMessages,
    getReadStatus,
    markConversationRead,
} from "../../api";
import type { AnyRecord } from "../../types";
import {
    isCurrentConversationRequest,
    mergeTimelineMessages,
} from "./conversationStateUtils";

type Message = AnyRecord & { id: number | string };
type Conversation = AnyRecord & { id: number | string };

type UseConversationLoaderOptions = {
    activeConversation: Conversation | null;
    activeConversationRef: MutableRefObject<Conversation | null>;
    messages: Message[];
    hasMore: boolean;
    messagesContainerRef: RefObject<HTMLDivElement | null>;
    setMessages: Dispatch<SetStateAction<Message[]>>;
    setHasMore: Dispatch<SetStateAction<boolean>>;
    setLoading: Dispatch<SetStateAction<boolean>>;
    setReadReceipts: Dispatch<SetStateAction<Record<string, unknown>>>;
    setMembers: Dispatch<SetStateAction<AnyRecord[]>>;
    onSelectConversation: (
        conversationId: number | string,
        data: AnyRecord,
    ) => void;
    onMarkedRead: (conversationId: number | string) => void;
    sendReadReceipt: (conversationId: number | string) => void;
};

type ConversationLoader = {
    openConversation: (
        conversationId: number | string,
        data: AnyRecord,
    ) => Promise<void>;
    loadMore: () => Promise<void>;
};

/**
 * Owns race-safe thread hydration and cursor pagination.
 *
 * A monotonically increasing generation prevents a late response from a
 * previously selected conversation mutating the current thread.
 */
export default function useConversationLoader({
    activeConversation,
    activeConversationRef,
    messages,
    hasMore,
    messagesContainerRef,
    setMessages,
    setHasMore,
    setLoading,
    setReadReceipts,
    setMembers,
    onSelectConversation,
    onMarkedRead,
    sendReadReceipt,
}: UseConversationLoaderOptions): ConversationLoader {
    const generationRef = useRef(0);

    const openConversation = useCallback(
        async (conversationId: number | string, data: AnyRecord) => {
            const generation = ++generationRef.current;
            const isCurrent = () =>
                isCurrentConversationRequest(
                    generation,
                    generationRef.current,
                    conversationId,
                    activeConversationRef.current?.id,
                );

            onSelectConversation(conversationId, data);
            setMessages([]);
            setReadReceipts({});
            setMembers([]);
            setHasMore(false);
            setLoading(true);

            try {
                const response = await getMessages(conversationId);
                if (!isCurrent()) return;

                const fetched = response.data as Message[];
                setMessages(
                    (current) =>
                        mergeTimelineMessages(current, fetched) as Message[],
                );
                setHasMore(fetched.length >= 50);

                await markConversationRead(conversationId);
                if (!isCurrent()) return;

                onMarkedRead(conversationId);
                sendReadReceipt(conversationId);

                try {
                    const readResponse = await getReadStatus(conversationId);
                    if (!isCurrent()) return;

                    const map: Record<string, unknown> = {};
                    (readResponse.data as AnyRecord[]).forEach((row) => {
                        map[String(row.user_id)] = row.last_read_at;
                    });
                    setReadReceipts(map);
                } catch (error) {
                    if (isCurrent()) {
                        console.error("Failed to load read status", error);
                    }
                }

                try {
                    const memberResponse = await getMembers(conversationId);
                    if (!isCurrent()) return;
                    setMembers(memberResponse.data as AnyRecord[]);
                } catch (error) {
                    if (isCurrent()) {
                        setMembers([]);
                        console.error("Failed to load members", error);
                    }
                }
            } catch (error) {
                if (isCurrent()) {
                    console.error("Failed to open conversation", error);
                }
            } finally {
                if (isCurrent()) setLoading(false);
            }
        },
        [
            activeConversationRef,
            onMarkedRead,
            onSelectConversation,
            sendReadReceipt,
            setHasMore,
            setLoading,
            setMembers,
            setMessages,
            setReadReceipts,
        ],
    );

    const loadMore = useCallback(async () => {
        if (!activeConversation || messages.length === 0 || !hasMore) return;

        const conversationId = activeConversation.id;
        const generation = generationRef.current;
        const before = String(messages[0].id);
        const container = messagesContainerRef.current;
        const previousHeight = container?.scrollHeight || 0;

        try {
            const response = await getMessages(conversationId, before);
            if (
                !isCurrentConversationRequest(
                    generation,
                    generationRef.current,
                    conversationId,
                    activeConversationRef.current?.id,
                )
            ) {
                return;
            }

            const fetched = response.data as Message[];
            // Existing/current rows win over overlapping historical rows.
            setMessages(
                (current) =>
                    mergeTimelineMessages(fetched, current) as Message[],
            );
            setHasMore(fetched.length >= 50);

            requestAnimationFrame(() => {
                if (container) {
                    container.scrollTop =
                        container.scrollHeight - previousHeight;
                }
            });
        } catch (error) {
            console.error("Failed to load more messages", error);
        }
    }, [
        activeConversation,
        activeConversationRef,
        hasMore,
        messages,
        messagesContainerRef,
        setHasMore,
        setMessages,
    ]);

    return { openConversation, loadMore };
}
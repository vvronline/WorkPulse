import {
    deleteConversation,
    clearChat,
    togglePinConversation,
    toggleFavouriteConversation,
    getMembers,
} from "../../api";
import type useChatState from "./useChatState";

type ChatState = ReturnType<typeof useChatState>;

export default function useConversationActions(state: ChatState) {
    const {
        activeConv,
        conversations,
        setActiveConv,
        setMessages,
        setConversations,
        setDeleteConfirm,
        setConvMenu,
        setShowGroupModal,
        setGroupEditData,
        refreshUnread,
    } = state;

    const handleDeleteConv = async (convId: number | string) => {
        try {
            await deleteConversation(convId);
            if (activeConv?.id === convId) {
                setActiveConv(null);
                setMessages([]);
            }
            setConversations((prev) => prev.filter((c) => c.id !== convId));
            refreshUnread();
        } catch {
            /* ignore */
        }
        setDeleteConfirm(null);
    };

    const handleClearChat = async (convId: number | string) => {
        try {
            await clearChat(convId);
            if (activeConv?.id === convId) setMessages([]);
            setConversations((prev) =>
                prev.map((c) =>
                    c.id === convId
                        ? { ...c, last_message: null, last_sender_id: null }
                        : c,
                ),
            );
        } catch {
            /* ignore */
        }
    };

    const handlePinConv = async (convId: number | string) => {
        try {
            const { data } = await togglePinConversation(convId);
            setConversations((prev) =>
                prev.map((c) =>
                    c.id === convId
                        ? {
                              ...c,
                              is_pinned: (data as { pinned?: boolean }).pinned,
                          }
                        : c,
                ),
            );
        } catch {
            /* ignore */
        }
        setConvMenu(null);
    };

    const handleFavConv = async (convId: number | string) => {
        try {
            const { data } = await toggleFavouriteConversation(convId);
            setConversations((prev) =>
                prev.map((c) =>
                    c.id === convId
                        ? {
                              ...c,
                              is_favourite: (data as { favourite?: boolean })
                                  .favourite,
                          }
                        : c,
                ),
            );
        } catch {
            /* ignore */
        }
        setConvMenu(null);
    };

    const openGroupEdit = async () => {
        if (!activeConv?.is_group) return;
        try {
            const { data } = await getMembers(activeConv.id);
            // activeConv carries only a minimal meta (no my_role /
            // group_description). Merge the full conversation row from the
            // loaded list so GroupModal can gate admin controls correctly.
            const full =
                conversations.find((c) => c.id === activeConv.id) || activeConv;
            setGroupEditData({ group: { ...activeConv, ...full }, members: data });
            setShowGroupModal(true);
        } catch {
            /* ignore */
        }
    };

    return {
        handleDeleteConv,
        handleClearChat,
        handlePinConv,
        handleFavConv,
        openGroupEdit,
    };
}
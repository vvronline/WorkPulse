import {
    deleteConversation,
    togglePinConversation,
    toggleFavouriteConversation,
    muteConversation,
    toggleArchiveConversation,
    blockUser,
    unblockUser,
    getMembers,
} from "../../api";
import { setClearedAt } from "./chatLocalDeletes";
import type useChatState from "./useChatState";

type ChatState = ReturnType<typeof useChatState>;

export default function useConversationActions(state: ChatState) {
    const {
        activeConv,
        conversations,
        setActiveConv,
        setMessages,
        setConversations,
        setHasMore,
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

    // Clear chat — Signal-style, LOCAL/device-only. This never touches the
    // other participant's copy (the old behaviour called the server, which
    // wiped the conversation for everyone). We record a per-conversation
    // "cleared at" cutoff so every message up to now is hidden on THIS device —
    // including messages not yet loaded via pagination — while NEW messages
    // that arrive afterwards still appear. The cutoff persists in localStorage
    // so the clear survives reloads.
    const handleClearChat = async (convId: number | string) => {
        setClearedAt(convId);
        if (activeConv?.id === convId) {
            setMessages([]);
            setHasMore(false);
        }
        setConversations((prev) =>
            prev.map((c) =>
                c.id === convId
                    ? { ...c, last_message: null, last_sender_id: null }
                    : c,
            ),
        );
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

    // Signal-style mute with duration: "1h" | "8h" | "1d" | "1w" | "always",
    // or null to unmute.
    const handleMuteConv = async (
        convId: number | string,
        duration: "1h" | "8h" | "1d" | "1w" | "always" | null,
    ) => {
        try {
            const { data } = await muteConversation(convId, duration);
            const d = data as { muted?: boolean; mutedUntil?: string | null };
            setConversations((prev) =>
                prev.map((c) =>
                    c.id === convId
                        ? { ...c, is_muted: d.muted, muted_until: d.mutedUntil }
                        : c,
                ),
            );
        } catch {
            /* ignore */
        }
        setConvMenu(null);
    };

    // Archive / unarchive (Signal parity: stays archived on new messages).
    const handleArchiveConv = async (convId: number | string) => {
        try {
            const { data } = await toggleArchiveConversation(convId);
            const archived = (data as { archived?: boolean }).archived;
            setConversations((prev) =>
                prev.map((c) =>
                    c.id === convId ? { ...c, is_archived: archived } : c,
                ),
            );
            if (archived && activeConv?.id === convId) {
                setActiveConv(null);
                setMessages([]);
            }
        } catch {
            /* ignore */
        }
        setConvMenu(null);
    };

    // Block / unblock the other user of a direct chat (Signal parity — the
    // blocked party is never notified).
    const handleToggleBlock = async (conv: {
        id: number | string;
        other_user_id?: number | string;
        is_blocked?: boolean;
    }) => {
        if (!conv?.other_user_id) return;
        try {
            if (conv.is_blocked) {
                await unblockUser(conv.other_user_id);
            } else {
                await blockUser(conv.other_user_id);
            }
            const nowBlocked = !conv.is_blocked;
            setConversations((prev) =>
                prev.map((c) =>
                    c.id === conv.id ? { ...c, is_blocked: nowBlocked } : c,
                ),
            );
            if (activeConv?.id === conv.id) {
                setActiveConv((prevConv: any) =>
                    prevConv ? { ...prevConv, is_blocked: nowBlocked } : prevConv,
                );
            }
        } catch {
            /* ignore */
        }
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
        handleMuteConv,
        handleArchiveConv,
        handleToggleBlock,
        openGroupEdit,
    };
}

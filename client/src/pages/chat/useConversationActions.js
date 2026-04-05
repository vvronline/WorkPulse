import {
    deleteConversation, clearChat,
    togglePinConversation, toggleFavouriteConversation, getMembers
} from '../../api';

export default function useConversationActions(state) {
    const {
        activeConv, setActiveConv,
        setMessages, setConversations,
        setDeleteConfirm, setConvMenu,
        setShowGroupModal, setGroupEditData,
        refreshUnread,
    } = state;

    const handleDeleteConv = async (convId) => {
        try {
            await deleteConversation(convId);
            if (activeConv?.id === convId) { setActiveConv(null); setMessages([]); }
            setConversations(prev => prev.filter(c => c.id !== convId));
            refreshUnread();
        } catch { /* ignore */ }
        setDeleteConfirm(null);
    };

    const handleClearChat = async (convId) => {
        try {
            await clearChat(convId);
            if (activeConv?.id === convId) setMessages([]);
            setConversations(prev => prev.map(c =>
                c.id === convId ? { ...c, last_message: null, last_sender_id: null } : c
            ));
        } catch { /* ignore */ }
    };

    const handlePinConv = async (convId) => {
        try {
            const { data } = await togglePinConversation(convId);
            setConversations(prev => prev.map(c =>
                c.id === convId ? { ...c, is_pinned: data.pinned } : c
            ));
        } catch { /* ignore */ }
        setConvMenu(null);
    };

    const handleFavConv = async (convId) => {
        try {
            const { data } = await toggleFavouriteConversation(convId);
            setConversations(prev => prev.map(c =>
                c.id === convId ? { ...c, is_favourite: data.favourite } : c
            ));
        } catch { /* ignore */ }
        setConvMenu(null);
    };

    const openGroupEdit = async () => {
        if (!activeConv?.is_group) return;
        try {
            const { data } = await getMembers(activeConv.id);
            setGroupEditData({ group: activeConv, members: data });
            setShowGroupModal(true);
        } catch { /* ignore */ }
    };

    return {
        handleDeleteConv, handleClearChat, handlePinConv, handleFavConv, openGroupEdit,
    };
}

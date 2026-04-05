import useMessageActions from './useMessageActions';
import useConversationActions from './useConversationActions';
import useCallActions from './useCallActions';

export default function useChatActions(state) {
    const {
        activeConv,
        typingTimerRef,
        wsSend,
    } = state;

    const messageActions = useMessageActions(state);
    const conversationActions = useConversationActions(state);
    const callActions = useCallActions(state);

    const handleTyping = () => {
        if (!activeConv) return;
        clearTimeout(typingTimerRef.current);
        typingTimerRef.current = setTimeout(() => {
            wsSend('chat_typing', { conversationId: activeConv.id });
        }, 200);
    };

    return {
        ...messageActions,
        ...conversationActions,
        ...callActions,
        handleTyping,
    };
}

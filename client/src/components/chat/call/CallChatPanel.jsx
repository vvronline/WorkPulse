import { useState, useRef, useEffect } from 'react';
import { SendIcon } from './CallIcons';
import s from '../CallOverlay.module.css';

/**
 * In-call personal chat panel. Slides in from the right side of the
 * CallOverlay so participants can exchange text messages without leaving
 * the call. Messages are the same chat-conversation messages used by the
 * Chat page — sending/receiving is wired through the existing chat
 * WebSocket pipeline (handleSend + messages from useChatState).
 */
export default function CallChatPanel({
    messages = [],
    currentUserId,
    onSend,
    onClose,
}) {
    const [text, setText] = useState('');
    const bottomRef = useRef(null);
    const inputRef = useRef(null);

    useEffect(() => {
        bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [messages]);

    useEffect(() => {
        // Focus the input when the panel opens
        setTimeout(() => inputRef.current?.focus(), 50);
    }, []);

    const send = () => {
        const trimmed = text.trim();
        if (!trimmed) return;
        onSend(trimmed);
        setText('');
    };

    const handleKey = (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            send();
        }
    };

    const formatTime = (ts) => {
        if (!ts) return '';
        try {
            return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        } catch {
            return '';
        }
    };

    // Filter out deleted messages and pending-only placeholders should still show
    const visible = messages.filter(m => !m.deleted_at);

    return (
        <div className={s.chatPanel} role="dialog" aria-label="In-call chat">
            <div className={s.chatPanelHeader}>
                <span>Chat</span>
                <button
                    className={s.chatPanelClose}
                    onClick={onClose}
                    title="Close chat"
                    aria-label="Close chat"
                >×</button>
            </div>

            <div className={s.chatPanelMessages}>
                {visible.length === 0 ? (
                    <div className={s.chatPanelEmpty}>
                        No messages yet.<br />
                        Send a message to start chatting.
                    </div>
                ) : (
                    visible.map((m, i) => {
                        const isMine = m.sender_id === currentUserId;
                        return (
                            <div
                                key={m.id || `msg-${i}`}
                                className={`${s.chatPanelMsg} ${isMine ? s.chatPanelMsgMine : ''}`}
                            >
                                {!isMine && (
                                    <span className={s.chatPanelMsgSender}>
                                        {m.sender_name || 'Participant'}
                                    </span>
                                )}
                                <div className={s.chatPanelMsgBubble}>
                                    {m.file_url ? (
                                        <a
                                            href={m.file_url}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            className={s.chatPanelMsgFile}
                                        >
                                            📎 {m.file_name || 'File'}
                                        </a>
                                    ) : (
                                        <span className={s.chatPanelMsgText}>{m.content}</span>
                                    )}
                                </div>
                                <span className={s.chatPanelMsgTime}>
                                    {formatTime(m.created_at)}
                                </span>
                            </div>
                        );
                    })
                )}
                <div ref={bottomRef} />
            </div>

            <div className={s.chatPanelInputWrap}>
                <textarea
                    ref={inputRef}
                    className={s.chatPanelInput}
                    value={text}
                    onChange={e => setText(e.target.value)}
                    onKeyDown={handleKey}
                    placeholder="Type a message…"
                    rows={1}
                />
                <button
                    className={s.chatPanelSendBtn}
                    onClick={send}
                    disabled={!text.trim()}
                    title="Send"
                    aria-label="Send message"
                >
                    <SendIcon />
                </button>
            </div>
        </div>
    );
}
import { useState, useRef, useEffect } from "react";
import { SendIcon } from "./CallIcons";
import s from "../CallOverlay.module.css";

// Inline paperclip icon (avoids pulling another icon set)
const AttachIcon = () => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
        <path
            d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
        />
    </svg>
);

function formatFileSize(bytes?: number): string {
    if (!bytes && bytes !== 0) return "";
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1048576).toFixed(1)} MB`;
}

// Frameless Electron windows on Windows/Linux render their own caption
// buttons (min / max / close) inside the page at top:0, right:0. Without
// this offset the chat panel's own close (×) button sits directly below
// the OS close button and the two overlap visually.
const isElectron = !!window.electronAPI?.isElectron;
const isWinLikeElectron = isElectron && window.electronAPI?.platform !== "darwin";

interface CallChatPanelProps {
    messages?: any[];
    currentUserId?: string;
    onSend: (text: string) => void;
    onSendFile?: (file: File) => void;
    onClose: () => void;
}

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
    onSendFile,
    onClose,
}: CallChatPanelProps) {
    const [text, setText] = useState("");
    const bottomRef = useRef<HTMLDivElement | null>(null);
    const inputRef = useRef<HTMLTextAreaElement | null>(null);
    const fileInputRef = useRef<HTMLInputElement | null>(null);

    useEffect(() => {
        bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }, [messages]);

    useEffect(() => {
        // Focus the input when the panel opens
        setTimeout(() => inputRef.current?.focus(), 50);
    }, []);

    const send = () => {
        const trimmed = text.trim();
        if (!trimmed) return;
        onSend(trimmed);
        setText("");
    };

    const handleKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            send();
        }
    };

    const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        e.target.value = "";
        if (!file) return;
        if (file.size > 25 * 1024 * 1024) {
            alert("File must be under 25MB");
            return;
        }
        if (onSendFile) onSendFile(file);
    };

    const formatTime = (ts?: string | number): string => {
        if (!ts) return "";
        try {
            return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
        } catch {
            return "";
        }
    };

    // Filter out deleted messages and pending-only placeholders should still show
    const visible = messages.filter((m: any) => !m.deleted_at);

    return (
        <div
            className={`${s.chatPanel} ${isWinLikeElectron ? s.chatPanelElectron : ""}`}
            role="dialog"
            aria-label="In-call chat"
        >
            <div className={s.chatPanelHeader}>
                <span>Chat</span>
                <button
                    className={s.chatPanelClose}
                    onClick={onClose}
                    title="Close chat"
                    aria-label="Close chat"
                >
                    ×
                </button>
            </div>

            <div className={s.chatPanelMessages}>
                {visible.length === 0 ? (
                    <div className={s.chatPanelEmpty}>
                        No messages yet.
                        <br />
                        Send a message to start chatting.
                    </div>
                ) : (
                    visible.map((m: any, i: number) => {
                        const isMine = m.sender_id === currentUserId;
                        return (
                            <div
                                key={m.id || `msg-${i}`}
                                className={`${s.chatPanelMsg} ${isMine ? s.chatPanelMsgMine : ""}`}
                            >
                                {!isMine && (
                                    <span className={s.chatPanelMsgSender}>
                                        {m.sender_name || "Participant"}
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
                                            <span className={s.chatPanelMsgFileIcon}>📎</span>
                                            <span className={s.chatPanelMsgFileMeta}>
                                                <span className={s.chatPanelMsgFileName}>
                                                    {m.file_name || "File"}
                                                </span>
                                                {m.file_size ? (
                                                    <span className={s.chatPanelMsgFileSize}>
                                                        {formatFileSize(m.file_size)}
                                                    </span>
                                                ) : null}
                                            </span>
                                        </a>
                                    ) : (
                                        <span className={s.chatPanelMsgText}>{m.content}</span>
                                    )}
                                </div>
                                <span className={s.chatPanelMsgTime}>{formatTime(m.created_at)}</span>
                            </div>
                        );
                    })
                )}
                <div ref={bottomRef} />
            </div>

            <div className={s.chatPanelInputWrap}>
                {onSendFile && (
                    <>
                        <button
                            type="button"
                            className={s.chatPanelAttachBtn}
                            onClick={() => fileInputRef.current?.click()}
                            title="Attach file"
                            aria-label="Attach file"
                        >
                            <AttachIcon />
                        </button>
                        <input
                            ref={fileInputRef}
                            type="file"
                            style={{ display: "none" }}
                            onChange={handleFileSelect}
                        />
                    </>
                )}
                <textarea
                    ref={inputRef}
                    className={s.chatPanelInput}
                    value={text}
                    onChange={(e) => setText(e.target.value)}
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
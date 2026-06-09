import React, { useState, useRef, useEffect } from "react";
import { Paperclip, FileText, Send, AlertCircle, Loader2, RefreshCcw } from "lucide-react";
import "./MeetingRoom.css";

function formatFileSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1048576).toFixed(1)} MB`;
}

/**
 * Derive a STABLE React key for a message row. Using the array index as
 * a key was masking a bug where dedupe/prepend mutations of the
 * `messages` array reused the wrong DOM nodes — briefly flashing the
 * wrong text into the wrong bubble while the React tree re-conciled.
 *
 * Priority:
 *   1. Server primary key (`id`)        — set after persistence.
 *   2. Client-minted UUID (`clientMsgId`) — present from the moment the
 *      message is enqueued for send; survives the ack round-trip without
 *      changing identity.
 *   3. A composite of sender + timestamp — legacy fallback for messages
 *      that pre-date the clientMsgId field.
 */
function rowKey(m: any, i: number): string {
    if (m.id != null) return `id:${m.id}`;
    if (m.clientMsgId) return `cid:${m.clientMsgId}`;
    return `legacy:${m.sender_id || "x"}:${m.created_at || ""}:${i}`;
}

interface MeetingChatProps {
    messages: any[];
    onSend: (text: string) => void;
    onSendFile?: (file: File) => void;
    onRetry?: (clientMsgId: string) => void;
}

/**
 * In-meeting chat panel (sidebar).
 *
 * `onRetry(clientMsgId)` (optional) is invoked when the user taps the
 * "Failed — retry" badge on an outbound message that didn't get acked
 * within the pending-send timeout. Wired by `useMeetingState`'s
 * `retryMessage`.
 */
export default function MeetingChat({ messages, onSend, onSendFile, onRetry }: MeetingChatProps) {
    const [text, setText] = useState("");
    const bottomRef = useRef<HTMLDivElement | null>(null);
    const fileRef = useRef<HTMLInputElement | null>(null);

    useEffect(() => {
        bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }, [messages]);

    const send = () => {
        if (!text.trim()) return;
        onSend(text.trim());
        setText("");
    };

    const handleKey = (e: React.KeyboardEvent) => {
        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            send();
        }
    };

    const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;
        if (file.size > 10 * 1024 * 1024) {
            alert("File must be under 10MB");
            return;
        }
        onSendFile && onSendFile(file);
        e.target.value = "";
    };

    return (
        <div className="mc-panel">
            <div className="mc-messages">
                {messages.length === 0 && <div className="mc-empty">No messages yet</div>}
                {messages.map((m, i) => {
                    const isFailed = !!m._failed;
                    const isUploading = !!m._uploading;
                    const isPending = !isFailed && !isUploading && !!m._optimistic;
                    return (
                        <div
                            key={rowKey(m, i)}
                            className={`mc-msg${isFailed ? " mc-msg-failed" : ""}${
                                isPending ? " mc-msg-pending" : ""
                            }`}
                        >
                            <span className="mc-msg-sender">{m.sender_name || "Participant"}</span>
                            {m.file_url ? (
                                <a
                                    className="mc-file-msg"
                                    href={m.file_url}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                >
                                    <FileText size={16} />
                                    <span className="mc-file-name">{m.file_name || "File"}</span>
                                    {m.file_size && (
                                        <span className="mc-file-size">{formatFileSize(m.file_size)}</span>
                                    )}
                                </a>
                            ) : (
                                <span className="mc-msg-text">{m.text}</span>
                            )}
                            <span className="mc-msg-time">
                                {new Date(m.created_at || Date.now()).toLocaleTimeString([], {
                                    hour: "2-digit",
                                    minute: "2-digit",
                                })}
                            </span>

                            {isUploading && (
                                <span className="mc-msg-status mc-msg-status-uploading" title="Uploading…">
                                    <Loader2 size={12} className="mc-spin" />
                                    <span>Uploading…</span>
                                </span>
                            )}
                            {isPending && !isUploading && (
                                <span className="mc-msg-status mc-msg-status-pending" title="Sending…">
                                    <Loader2 size={12} className="mc-spin" />
                                    <span>Sending…</span>
                                </span>
                            )}
                            {isFailed && (
                                <button
                                    type="button"
                                    className="mc-msg-status mc-msg-status-failed"
                                    title={
                                        m._failureReason
                                            ? `Failed: ${m._failureReason}. Tap to retry.`
                                            : "Failed — tap to retry"
                                    }
                                    onClick={() => onRetry && m.clientMsgId && onRetry(m.clientMsgId)}
                                >
                                    <AlertCircle size={12} />
                                    <span>Failed</span>
                                    <RefreshCcw size={12} />
                                </button>
                            )}
                        </div>
                    );
                })}
                <div ref={bottomRef} />
            </div>
            <div className="mc-input-wrap">
                <button className="mc-attach-btn" onClick={() => fileRef.current?.click()} title="Attach file">
                    <Paperclip size={18} />
                </button>
                <input type="file" ref={fileRef} style={{ display: "none" }} onChange={handleFileSelect} />
                <textarea
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    onKeyDown={handleKey}
                    placeholder="Send a message…"
                    rows={1}
                    className="mc-input"
                />
                <button className="mc-send" onClick={send} disabled={!text.trim()}>
                    <Send size={16} />
                </button>
            </div>
        </div>
    );
}
import { useState, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { VoiceRecorder, ReplyPreview, EmojiGifPicker, MentionInput } from "../../components/chat";
import CameraCapture from "../../components/chat/CameraCapture";
import MediaEditor, { type MediaEditorResult } from "../../components/chat/MediaEditor";
import s from "./ChatInputBar.module.css";

interface ChatInputBarProps {
    input: string;
    setInput: (val: string) => void;
    editingMsg: any;
    replyTo: any;
    recording: boolean;
    showEmojiPicker: boolean;
    convMembers: any;
    mentionInputRef: any;
    fileInputRef: React.RefObject<HTMLInputElement>;
    isGroup: boolean;
    onSend: (e?: any) => void;
    onFileUpload: (file: File, opts?: { viewOnce?: boolean; caption?: string }) => void;
    onVoiceSend: (...args: any[]) => void;
    onCancelRecording: () => void;
    onStartRecording: () => void;
    onEmojiInsert: (...args: any[]) => void;
    onToggleEmoji: () => void;
    onOpenPollCreator: () => void;
    onClearReply: () => void;
    onClearEdit: () => void;
    onTyping: () => void;
}

const EDITABLE_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/bmp"];

export default function ChatInputBar({
    input,
    setInput,
    editingMsg,
    replyTo,
    recording,
    showEmojiPicker,
    convMembers,
    mentionInputRef,
    fileInputRef,
    isGroup,
    onSend,
    onFileUpload,
    onVoiceSend,
    onCancelRecording,
    onStartRecording,
    onEmojiInsert,
    onToggleEmoji,
    onOpenPollCreator,
    onClearReply,
    onClearEdit,
    onTyping,
}: ChatInputBarProps) {
    const [plusOpen, setPlusOpen] = useState(false);
    const [cameraOpen, setCameraOpen] = useState(false);
    const [editorFiles, setEditorFiles] = useState<File[] | null>(null);
    const plusMenuRef = useRef<HTMLDivElement | null>(null);
    const hasText = !!input.trim();

    useEffect(() => {
        if (!plusOpen) return;
        const handleClick = (e: MouseEvent) => {
            if (plusMenuRef.current && !plusMenuRef.current.contains(e.target as Node)) {
                setPlusOpen(false);
            }
        };
        document.addEventListener("mousedown", handleClick);
        return () => document.removeEventListener("mousedown", handleClick);
    }, [plusOpen]);

    // Route a picked/captured image through the Signal-style media editor.
    // Non-image files (documents, etc.) upload directly.
    const routeFile = (file: File) => {
        if (file && EDITABLE_IMAGE_TYPES.includes(file.type)) {
            setEditorFiles([file]);
        } else {
            onFileUpload(file);
        }
    };

    const handleEditorSend = (results: MediaEditorResult[]) => {
        results.forEach((r, i) => {
            onFileUpload(r.file, {
                viewOnce: r.viewOnce,
                // Only attach the caption to the first item, matching Signal.
                caption: i === 0 ? r.caption : undefined,
            });
        });
        setEditorFiles(null);
    };

    return (
        <>
            {(replyTo || editingMsg) && (
                <div className={s.replyBar}>
                    {editingMsg ? (
                        <ReplyPreview senderName="Editing" content={editingMsg.content} onClear={onClearEdit} />
                    ) : (
                        <ReplyPreview
                            senderName={replyTo.sender_name}
                            content={replyTo.content}
                            onClear={onClearReply}
                        />
                    )}
                </div>
            )}

            {recording && (
                <div className={s.voiceBar}>
                    <VoiceRecorder onSend={onVoiceSend} onCancel={onCancelRecording} />
                </div>
            )}

            {!recording && (
                <div className={s.inputArea}>
                    <form className={s.inputBar} onSubmit={onSend}>
                        <input
                            type="file"
                            ref={fileInputRef}
                            className={s.fileInput}
                            onChange={(e) => {
                                if (e.target.files?.[0]) routeFile(e.target.files[0]);
                                e.target.value = "";
                            }}
                        />

                        <div className={s.inputBoxWrap}>
                            <button
                                type="button"
                                className={`${s.emojiToggle} ${showEmojiPicker ? s.emojiToggleActive : ""}`}
                                onClick={onToggleEmoji}
                                title={showEmojiPicker ? "Keyboard" : "Emoji"}
                                aria-label={showEmojiPicker ? "Show keyboard" : "Show emoji"}
                            >
                                {showEmojiPicker ? (
                                    /* keyboard icon */
                                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
                                        <rect x="2" y="5" width="20" height="14" rx="2" stroke="currentColor" strokeWidth="1.6" />
                                        <path
                                            d="M6 9h.01M10 9h.01M14 9h.01M18 9h.01M6 13h.01M10 13h.01M14 13h.01M18 13h.01M8 16h8"
                                            stroke="currentColor"
                                            strokeWidth="1.6"
                                            strokeLinecap="round"
                                        />
                                    </svg>
                                ) : (
                                    /* smiley icon */
                                    <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
                                        <circle cx="10" cy="10" r="8" stroke="currentColor" strokeWidth="1.5" />
                                        <circle cx="7" cy="8" r="1" fill="currentColor" />
                                        <circle cx="13" cy="8" r="1" fill="currentColor" />
                                        <path
                                            d="M6.5 12.5a4 4 0 007 0"
                                            stroke="currentColor"
                                            strokeWidth="1.3"
                                            strokeLinecap="round"
                                        />
                                    </svg>
                                )}
                            </button>

                            <MentionInput
                                ref={mentionInputRef}
                                value={input}
                                onChange={(val: string) => {
                                    setInput(val);
                                    onTyping();
                                }}
                                members={convMembers}
                                placeholder={editingMsg ? "Edit message..." : "Type a message..."}
                                className={s.msgInput}
                                maxLength={5000}
                                onSubmit={onSend}
                            />

                            {/* Signal-style: camera + mic live INSIDE the pill, on the
                                right. They collapse while the user is typing to make
                                room for the text, and the send button takes over. */}
                            {!hasText && !editingMsg && (
                                <>
                                    <button
                                        type="button"
                                        className={s.cameraBtn}
                                        onClick={() => setCameraOpen(true)}
                                        title="Camera"
                                        aria-label="Open camera"
                                    >
                                        <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
                                            <rect x="2.5" y="5" width="13" height="10" rx="2" stroke="currentColor" strokeWidth="1.4" />
                                            <path d="M6 5l1.2-2h3.6L12 5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                                            <circle cx="9" cy="10" r="2.6" stroke="currentColor" strokeWidth="1.4" />
                                        </svg>
                                    </button>
                                    <button
                                        type="button"
                                        className={s.micBtn}
                                        onClick={onStartRecording}
                                        title="Voice message"
                                        aria-label="Record voice message"
                                    >
                                        <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
                                            <rect
                                                x="6.5"
                                                y="2"
                                                width="5"
                                                height="9"
                                                rx="2.5"
                                                stroke="currentColor"
                                                strokeWidth="1.5"
                                            />
                                            <path
                                                d="M4 9a5 5 0 0010 0"
                                                stroke="currentColor"
                                                strokeWidth="1.5"
                                                strokeLinecap="round"
                                            />
                                            <path
                                                d="M9 14v2.5"
                                                stroke="currentColor"
                                                strokeWidth="1.5"
                                                strokeLinecap="round"
                                            />
                                        </svg>
                                    </button>
                                </>
                            )}

                            {showEmojiPicker && (
                                <div className={s.emojiDock}>
                                    <EmojiGifPicker
                                        onSelectEmoji={onEmojiInsert}
                                        onSelectMediaFile={routeFile}
                                        onClose={onToggleEmoji}
                                    />
                                </div>
                            )}
                        </div>

                        {/* Right-outside slot: send button when typing, otherwise the
                            "+" attach menu (Signal places "+" outside, on the right). */}
                        {hasText || editingMsg ? (
                            <button
                                type="submit"
                                className={`${s.sendBtn} ${s.sendBtnVisible}`}
                                disabled={!input.trim()}
                            >
                                <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
                                    <path d="M2 3l14 6-14 6V10l10-1-10-1V3z" fill="currentColor" />
                                </svg>
                            </button>
                        ) : (
                            <div ref={plusMenuRef} className={s.plusWrap}>
                                <button
                                    type="button"
                                    className={`${s.plusBtn} ${plusOpen ? s.plusBtnOpen : ""}`}
                                    onClick={() => setPlusOpen((v) => !v)}
                                    title="More options"
                                >
                                    <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
                                        <path
                                            d="M10 4v12M4 10h12"
                                            stroke="currentColor"
                                            strokeWidth="2"
                                            strokeLinecap="round"
                                        />
                                    </svg>
                                </button>

                                {plusOpen && (
                                    <div className={s.plusMenu}>
                                        {isGroup && (
                                            <button
                                                type="button"
                                                className={s.plusMenuItem}
                                                onClick={() => {
                                                    onOpenPollCreator();
                                                    setPlusOpen(false);
                                                }}
                                            >
                                                <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
                                                    <rect x="2" y="3" width="5" height="3" rx="1" stroke="currentColor" strokeWidth="1.3" />
                                                    <rect x="2" y="7.5" width="10" height="3" rx="1" stroke="currentColor" strokeWidth="1.3" />
                                                    <rect x="2" y="12" width="7" height="3" rx="1" stroke="currentColor" strokeWidth="1.3" />
                                                </svg>
                                                Poll
                                            </button>
                                        )}
                                        <button
                                            type="button"
                                            className={s.plusMenuItem}
                                            onClick={() => {
                                                fileInputRef.current?.click();
                                                setPlusOpen(false);
                                            }}
                                        >
                                            <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
                                                <path
                                                    d="M15.75 8.62l-6.79 6.79a3.83 3.83 0 01-5.41-5.41l6.79-6.79a2.55 2.55 0 013.61 3.61l-6.8 6.79a1.28 1.28 0 01-1.8-1.8l6.26-6.27"
                                                    stroke="currentColor"
                                                    strokeWidth="1.5"
                                                    strokeLinecap="round"
                                                    strokeLinejoin="round"
                                                />
                                            </svg>
                                            Attach file
                                        </button>
                                    </div>
                                )}
                            </div>
                        )}
                    </form>
                </div>
            )}

            {cameraOpen &&
                createPortal(
                    <CameraCapture
                        onCapture={(file) => {
                            setCameraOpen(false);
                            setEditorFiles([file]);
                        }}
                        onClose={() => setCameraOpen(false)}
                    />,
                    document.body,
                )}

            {editorFiles &&
                createPortal(
                    <MediaEditor
                        initialFiles={editorFiles}
                        onSend={handleEditorSend}
                        onClose={() => setEditorFiles(null)}
                    />,
                    document.body,
                )}
        </>
    );
}
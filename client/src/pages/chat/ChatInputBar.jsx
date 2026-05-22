import { useState, useEffect, useRef } from 'react';
import { VoiceRecorder, ReplyPreview, EmojiGifPicker, MentionInput } from '../../components/chat';
import s from './ChatInputBar.module.css';

export default function ChatInputBar({
    input, setInput, editingMsg, replyTo, recording, showEmojiPicker,
    convMembers, mentionInputRef, fileInputRef, isGroup,
    onSend, onFileUpload, onVoiceSend, onCancelRecording, onStartRecording,
    onEmojiInsert, onToggleEmoji, onOpenPollCreator,
    onClearReply, onClearEdit, onTyping
}) {
    const [plusOpen, setPlusOpen] = useState(false);
    const plusMenuRef = useRef(null);

    useEffect(() => {
        if (!plusOpen) return;
        const handleClick = (e) => {
            if (plusMenuRef.current && !plusMenuRef.current.contains(e.target)) {
                setPlusOpen(false);
            }
        };
        document.addEventListener('mousedown', handleClick);
        return () => document.removeEventListener('mousedown', handleClick);
    }, [plusOpen]);

    return (
        <>
            {(replyTo || editingMsg) && (
                <div className={s.replyBar}>
                    {editingMsg
                        ? <ReplyPreview senderName="Editing" content={editingMsg.content} onClear={onClearEdit} />
                        : <ReplyPreview senderName={replyTo.sender_name} content={replyTo.content} onClear={onClearReply} />}
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
                            onChange={e => { if (e.target.files[0]) onFileUpload(e.target.files[0]); e.target.value = ''; }}
                        />

                        <div ref={plusMenuRef} style={{ position: 'relative' }}>
                            <button
                                type="button"
                                className={`${s.plusBtn} ${plusOpen ? s.plusBtnOpen : ''}`}
                                onClick={() => setPlusOpen(v => !v)}
                                title="More options"
                            >
                                <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
                                    <path d="M10 4v12M4 10h12" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
                                </svg>
                            </button>

                            {plusOpen && (
                                <div className={s.plusMenu}>
                                    <button type="button" className={s.plusMenuItem} onClick={() => { onToggleEmoji(); setPlusOpen(false); }}>
                                        <svg width="18" height="18" viewBox="0 0 18 18" fill="none"><circle cx="9" cy="9" r="7.5" stroke="currentColor" strokeWidth="1.5"/><circle cx="6.5" cy="7.5" r="1" fill="currentColor"/><circle cx="11.5" cy="7.5" r="1" fill="currentColor"/><path d="M6 11.5a3.5 3.5 0 006 0" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/></svg>
                                        Emoji
                                    </button>
                                    {isGroup && (
                                        <button type="button" className={s.plusMenuItem} onClick={() => { onOpenPollCreator(); setPlusOpen(false); }}>
                                            <svg width="18" height="18" viewBox="0 0 18 18" fill="none"><rect x="2" y="3" width="5" height="3" rx="1" stroke="currentColor" strokeWidth="1.3"/><rect x="2" y="7.5" width="10" height="3" rx="1" stroke="currentColor" strokeWidth="1.3"/><rect x="2" y="12" width="7" height="3" rx="1" stroke="currentColor" strokeWidth="1.3"/></svg>
                                            Poll
                                        </button>
                                    )}
                                    <button type="button" className={s.plusMenuItem} onClick={() => { onStartRecording(); setPlusOpen(false); }}>
                                        <svg width="18" height="18" viewBox="0 0 18 18" fill="none"><rect x="6.5" y="2" width="5" height="9" rx="2.5" stroke="currentColor" strokeWidth="1.5"/><path d="M4 9a5 5 0 0010 0" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/><path d="M9 14v2.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
                                        Voice message
                                    </button>
                                    <button type="button" className={s.plusMenuItem} onClick={() => { fileInputRef.current?.click(); setPlusOpen(false); }}>
                                        <svg width="18" height="18" viewBox="0 0 18 18" fill="none"><path d="M15.75 8.62l-6.79 6.79a3.83 3.83 0 01-5.41-5.41l6.79-6.79a2.55 2.55 0 013.61 3.61l-6.8 6.79a1.28 1.28 0 01-1.8-1.8l6.26-6.27" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
                                        Attach file
                                    </button>
                                </div>
                            )}
                        </div>

                        <div className={s.inputBoxWrap}>
                            <MentionInput
                                ref={mentionInputRef}
                                value={input}
                                onChange={val => { setInput(val); onTyping(); }}
                                members={convMembers}
                                placeholder={editingMsg ? 'Edit message...' : 'Type a message...'}
                                className={s.msgInput}
                                maxLength={5000}
                                onSubmit={onSend}
                            />
                        </div>

                        <button
                            type="submit"
                            className={`${s.sendBtn} ${input.trim() ? s.sendBtnVisible : ''}`}
                            disabled={!input.trim()}
                        >
                            <svg width="18" height="18" viewBox="0 0 18 18" fill="none"><path d="M2 3l14 6-14 6V10l10-1-10-1V3z" fill="currentColor"/></svg>
                        </button>
                    </form>
                    {showEmojiPicker && (
                        <EmojiGifPicker
                            onSelectEmoji={onEmojiInsert}
                            onClose={onToggleEmoji}
                        />
                    )}
                </div>
            )}
        </>
    );
}

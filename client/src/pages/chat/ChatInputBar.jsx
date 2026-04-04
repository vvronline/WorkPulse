import { VoiceRecorder, ReplyPreview, EmojiGifPicker, MentionInput } from '../../components/chat';
import s from './ChatInputBar.module.css';

export default function ChatInputBar({
    input, setInput, editingMsg, replyTo, recording, showEmojiPicker,
    convMembers, mentionInputRef, fileInputRef, isGroup,
    onSend, onFileUpload, onVoiceSend, onCancelRecording, onStartRecording,
    onEmojiInsert, onToggleEmoji, onOpenPollCreator,
    onClearReply, onClearEdit, onTyping
}) {
    return (
        <>
            {/* Reply / Edit preview */}
            {(replyTo || editingMsg) && (
                <div className={s.replyBar}>
                    {editingMsg
                        ? <ReplyPreview senderName="Editing" content={editingMsg.content} onClear={onClearEdit} />
                        : <ReplyPreview senderName={replyTo.sender_name} content={replyTo.content} onClear={onClearReply} />}
                </div>
            )}

            {/* Voice recorder */}
            {recording && (
                <div className={s.voiceBar}>
                    <VoiceRecorder onSend={onVoiceSend} onCancel={onCancelRecording} />
                </div>
            )}

            {/* Input bar */}
            {!recording && (
                <div className={s.inputArea}>
                    <form className={s.inputBar} onSubmit={onSend}>
                        <input
                            type="file"
                            ref={fileInputRef}
                            className={s.fileInput}
                            onChange={e => { if (e.target.files[0]) onFileUpload(e.target.files[0]); e.target.value = ''; }}
                        />
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
                            <div className={s.inputTools}>
                                <button type="button" className={s.inputIcon} onClick={onToggleEmoji} title="Emoji">
                                    <svg width="18" height="18" viewBox="0 0 18 18" fill="none"><circle cx="9" cy="9" r="7.5" stroke="currentColor" strokeWidth="1.5"/><circle cx="6.5" cy="7.5" r="1" fill="currentColor"/><circle cx="11.5" cy="7.5" r="1" fill="currentColor"/><path d="M6 11.5a3.5 3.5 0 006 0" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/></svg>
                                </button>
                                {isGroup && (
                                    <button type="button" className={s.inputIcon} onClick={onOpenPollCreator} title="Create poll">
                                        <svg width="18" height="18" viewBox="0 0 18 18" fill="none"><rect x="2" y="3" width="5" height="3" rx="1" stroke="currentColor" strokeWidth="1.3"/><rect x="2" y="7.5" width="10" height="3" rx="1" stroke="currentColor" strokeWidth="1.3"/><rect x="2" y="12" width="7" height="3" rx="1" stroke="currentColor" strokeWidth="1.3"/></svg>
                                    </button>
                                )}
                                <button type="button" className={s.inputIcon} onClick={onStartRecording} title="Voice message">
                                    <svg width="18" height="18" viewBox="0 0 18 18" fill="none"><rect x="6.5" y="2" width="5" height="9" rx="2.5" stroke="currentColor" strokeWidth="1.5"/><path d="M4 9a5 5 0 0010 0" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/><path d="M9 14v2.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
                                </button>
                                <button type="button" className={s.inputIcon} onClick={() => fileInputRef.current?.click()} title="Attach file">
                                    <svg width="20" height="20" viewBox="0 0 20 20" fill="none"><path d="M17.5 9.58l-7.54 7.54a4.25 4.25 0 01-6.01-6.01l7.54-7.54a2.83 2.83 0 014.01 4.01l-7.55 7.54a1.42 1.42 0 01-2-2l6.96-6.96" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
                                </button>
                            </div>
                        </div>
                        <button type="submit" className={s.sendBtn} disabled={!input.trim()}>
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

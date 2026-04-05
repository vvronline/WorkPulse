import s from './MessageBubble.module.css';

const QUICK_EMOJIS = ['👍', '❤️', '😂', '😮', '🔥', '🎉'];

export default function MessageToolbar({ msg, isMine, onReply, onReact, onOpenReactions, onOpenContextMenu, onCloseToolbar }) {
    return (
        <div className={s.hoverActions} data-toolbar>
            <div className={s.quickReactions}>
                {QUICK_EMOJIS.map(emoji => (
                    <button key={emoji} className={s.quickEmoji} onClick={() => { onReact?.(msg.id, emoji); onCloseToolbar?.(); }} title={emoji}>
                        {emoji}
                    </button>
                ))}
                <button className={s.moreEmoji} onClick={onOpenReactions} title="More reactions">
                    <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="7" stroke="currentColor" strokeWidth="1.3"/><circle cx="5.2" cy="6.5" r="0.9" fill="currentColor"/><circle cx="10.8" cy="6.5" r="0.9" fill="currentColor"/><path d="M5 10a3.5 3.5 0 006 0" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/></svg>
                </button>
            </div>
            <div className={s.toolbarDivider} />
            <button className={s.toolbarBtn} onClick={() => { onReply?.(msg); onCloseToolbar?.(); }} title="Reply">
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M6 3L2 7l4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/><path d="M2 7h7a5 5 0 010 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
            </button>
            <button className={s.toolbarBtn} onClick={onOpenContextMenu} title="More options">
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="4" cy="8" r="1.2" fill="currentColor"/><circle cx="8" cy="8" r="1.2" fill="currentColor"/><circle cx="12" cy="8" r="1.2" fill="currentColor"/></svg>
            </button>
        </div>
    );
}

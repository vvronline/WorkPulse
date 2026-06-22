import React, { useCallback, useRef } from "react";
import s from "./MessageBubble.module.css";

// Signal-Android's exact six (ConversationReactionOverlay). Kept in sync with
// the mobile chatUtils EMOJIS quick-reaction row.
const QUICK_EMOJIS = ["👍", "❤️", "😂", "😮", "😢", "🙏"];

interface ToolbarMsg {
    id: number | string;
    file_url?: string | null;
    format_type?: string;
    [key: string]: unknown;
}

interface MessageToolbarProps {
    msg: ToolbarMsg;
    isMine: boolean;
    onReply?: (msg: ToolbarMsg) => void;
    onEdit?: (msg: ToolbarMsg) => void;
    onReact?: (msgId: number | string, emoji: string) => void;
    onOpenReactions?: () => void;
    onOpenContextMenu: (e: { preventDefault: () => void; clientX: number; clientY: number }) => void;
    onCloseToolbar?: () => void;
}

export default function MessageToolbar({ msg, isMine, onReply, onEdit, onReact, onOpenReactions, onOpenContextMenu, onCloseToolbar }: MessageToolbarProps) {
    const moreRef = useRef<HTMLButtonElement | null>(null);
    const canEdit = isMine && !msg.file_url && msg.format_type !== "poll";

    // Open context menu positioned from the "..." button (works on both touch and mouse)
    const handleMoreOptions = useCallback((e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        const rect = moreRef.current?.getBoundingClientRect();
        if (rect) {
            onOpenContextMenu({ preventDefault() {}, clientX: rect.left, clientY: rect.bottom + 4 });
        }
        onCloseToolbar?.();
    }, [onOpenContextMenu, onCloseToolbar]);

    // Stop touch events from bubbling to the parent's swipe/tap handler
    const stopTouch = useCallback((e: React.TouchEvent) => e.stopPropagation(), []);

    return (
        <div className={s.hoverActions} data-toolbar onTouchStart={stopTouch} onTouchEnd={stopTouch} onTouchMove={stopTouch}>
            <div className={s.quickReactions}>
                {QUICK_EMOJIS.map(emoji => (
                    <button key={emoji} className={s.quickEmoji} onClick={() => { onReact?.(msg.id, emoji); onCloseToolbar?.(); }} title={emoji}>
                        {emoji}
                    </button>
                ))}
                <button className={s.moreEmoji} onClick={onOpenReactions} title="More reactions">
                    <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="7" stroke="currentColor" strokeWidth="1.3" /><circle cx="5.2" cy="6.5" r="0.9" fill="currentColor" /><circle cx="10.8" cy="6.5" r="0.9" fill="currentColor" /><path d="M5 10a3.5 3.5 0 006 0" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" /></svg>
                </button>
            </div>
            <div className={s.toolbarDivider} />
            <button className={s.toolbarBtn} onClick={() => { onReply?.(msg); onCloseToolbar?.(); }} title="Reply">
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M6 3L2 7l4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /><path d="M2 7h7a5 5 0 010 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
            </button>
            {canEdit && (
                <button className={s.toolbarBtn} onClick={() => { onEdit?.(msg); onCloseToolbar?.(); }} title="Edit">
                    <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M11.5 2.5l2 2L6 12l-2.5.5L4 10l7.5-7.5z" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
                </button>
            )}
            <button ref={moreRef} className={s.toolbarBtn} onClick={handleMoreOptions} title="More options">
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="4" cy="8" r="1.2" fill="currentColor" /><circle cx="8" cy="8" r="1.2" fill="currentColor" /><circle cx="12" cy="8" r="1.2" fill="currentColor" /></svg>
            </button>
        </div>
    );
}
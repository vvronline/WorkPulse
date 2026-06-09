import { useState, useRef } from "react";
import { createPortal } from "react-dom";
import ReactionPicker from "./ReactionPicker";
import EmojiGifPicker from "./EmojiGifPicker";
import s from "./MessageBubble.module.css";

interface Reaction {
    emoji: string;
    userId: number | string;
    fullName?: string;
    [key: string]: unknown;
}

interface ReactionMsg {
    id: number | string;
    reactions?: Reaction[];
    [key: string]: unknown;
}

interface ReactionBarProps {
    msg: ReactionMsg;
    userId: number | string;
    onReact?: (msgId: number | string, emoji: string) => void;
}

export default function ReactionBar({ msg, userId, onReact }: ReactionBarProps) {
    const [showReactions, setShowReactions] = useState(false);
    const [showFullPicker, setShowFullPicker] = useState(false);
    const addBtnRef = useRef<HTMLButtonElement | null>(null);

    // Group reactions by emoji
    const reactionGroups: Record<string, Reaction[]> = {};
    for (const r of msg.reactions || []) {
        if (!reactionGroups[r.emoji]) reactionGroups[r.emoji] = [];
        reactionGroups[r.emoji].push(r);
    }

    if (Object.keys(reactionGroups).length === 0 && !showReactions && !showFullPicker) return null;

    return (
        <>
            {Object.keys(reactionGroups).length > 0 && (
                <div className={s.reactions} data-reaction>
                    {Object.entries(reactionGroups).map(([emoji, users]) => (
                        <button
                            key={emoji}
                            className={`${s.reactionChip} ${users.some(u => u.userId === userId) ? s.myReaction : ""}`}
                            onClick={() => onReact?.(msg.id, emoji)}
                            title={users.map(u => u.fullName).join(", ")}
                        >
                            <span className={s.reactionEmoji}>{emoji}</span>
                            <span className={s.reactionCount}>{users.length}</span>
                        </button>
                    ))}
                    <button
                        ref={addBtnRef}
                        className={s.addReactionBtn}
                        onClick={() => setShowFullPicker(p => !p)}
                        title="Add reaction"
                    >
                        <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
                    </button>
                </div>
            )}

            {showReactions && createPortal(
                <ReactionPicker
                    onSelect={(emoji: string) => { onReact?.(msg.id, emoji); setShowReactions(false); }}
                    onClose={() => setShowReactions(false)}
                    onOpenFull={() => { setShowReactions(false); setShowFullPicker(true); }}
                    style={(() => {
                        const isMobile = window.innerWidth <= 480;
                        const rect = addBtnRef.current?.getBoundingClientRect();
                        if (!rect) return { position: "fixed", top: "50%", left: "50%", transform: "translate(-50%,-50%)", zIndex: 10000 };
                        if (isMobile) {
                            return { position: "fixed", left: "50%", transform: "translateX(-50%)", top: `${Math.max(8, rect.top - 54)}px`, zIndex: 10000 };
                        }
                        const pickerWidth = 370;
                        let left = rect.left + rect.width / 2 - pickerWidth / 2;
                        left = Math.max(8, Math.min(left, window.innerWidth - pickerWidth - 8));
                        let top = rect.top - 54;
                        if (top < 8) top = rect.bottom + 4;
                        return { position: "fixed", top: `${top}px`, left: `${left}px`, zIndex: 10000 };
                    })() as React.CSSProperties}
                />,
                document.body
            )}

            {showFullPicker && createPortal(
                <EmojiGifPicker
                    onSelectEmoji={(emoji: string) => onReact?.(msg.id, emoji)}
                    onClose={() => setShowFullPicker(false)}
                    style={(() => {
                        const isMobile = window.innerWidth <= 480;
                        if (isMobile) {
                            return { position: "fixed", top: "50%", left: "50%", transform: "translate(-50%,-50%)", zIndex: 10000 };
                        }
                        const rect = addBtnRef.current?.getBoundingClientRect();
                        if (!rect) return { position: "fixed", top: "50%", left: "50%", transform: "translate(-50%,-50%)", zIndex: 10000 };
                        const pickerWidth = 340;
                        const pickerHeight = 400;
                        let left = rect.left + rect.width / 2 - pickerWidth / 2;
                        left = Math.max(8, Math.min(left, window.innerWidth - pickerWidth - 8));
                        let top = rect.top - pickerHeight - 8;
                        if (top < 8) top = rect.bottom + 4;
                        if (top + pickerHeight > window.innerHeight - 8) top = window.innerHeight - pickerHeight - 8;
                        return {
                            position: "fixed",
                            top: `${top}px`,
                            left: `${left}px`,
                            bottom: "auto",
                            right: "auto",
                            marginBottom: 0,
                            zIndex: 10000,
                        };
                    })() as React.CSSProperties}
                />,
                document.body
            )}
        </>
    );
}
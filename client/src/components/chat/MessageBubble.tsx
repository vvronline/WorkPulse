/* eslint-disable @typescript-eslint/no-explicit-any */
import { useState, useCallback, useRef, useEffect } from "react";
import { createPortal } from "react-dom";
import { Pin, Star, Pencil, Trash2 } from "lucide-react";
import s from "./MessageBubble.module.css";
import ChatAvatar from "./ChatAvatar";
import FilePreview from "./FilePreview";
import ReplyPreview from "./ReplyPreview";
import ContextMenu, { type ContextMenuItem } from "./ContextMenu";
import PollDisplay from "./PollDisplay";
import MessageContent from "./MessageContent";
import DeliveryStatus from "./DeliveryStatus";
import MessageToolbar from "./MessageToolbar";
import ReactionBar from "./ReactionBar";
import EmojiGifPicker from "./EmojiGifPicker";

interface MessageBubbleProps {
    msg: any;
    isMine: boolean;
    userId?: number | string;
    showAvatar?: boolean;
    showName?: boolean;
    onReply?: (msg: any) => void;
    onEdit?: (msg: any) => void;
    onDelete?: (msg: any) => void;
    onPin?: (msg: any) => void;
    onForward?: (msg: any) => void;
    onReact?: (msgId: number | string, emoji: string) => void;
    onStar?: (msg: any) => void;
    onJumpTo?: (id: number | string) => void;
    participantCount?: number;
    readReceipts?: any;
}

export default function MessageBubble({
    msg, isMine, userId, showAvatar, showName,
    onReply, onEdit, onDelete, onPin, onForward, onReact, onStar, onJumpTo,
    participantCount, readReceipts
}: MessageBubbleProps) {
    const [showReactions, setShowReactions] = useState(false);
    const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);
    const [toolbarOpen, setToolbarOpen] = useState(false);
    const bubbleRef = useRef<HTMLDivElement | null>(null);
    const rowRef = useRef<HTMLDivElement | null>(null);
    const wrapRef = useRef<HTMLDivElement | null>(null);

    const handleContext = useCallback((e: React.MouseEvent) => {
        e.preventDefault();
        setCtxMenu({ x: e.clientX, y: e.clientY });
    }, []);

    /* ─── Touch: tap-to-toggle toolbar + swipe-to-reply ─── */
    const touchStartRef = useRef<{ x: number; y: number; time: number } | null>(null);
    const swipeState = useRef({ locked: false, swiping: false });

    const handleTouchStart = useCallback((e: React.TouchEvent) => {
        touchStartRef.current = { x: e.touches[0].clientX, y: e.touches[0].clientY, time: Date.now() };
        swipeState.current = { locked: false, swiping: false };
    }, []);

    const handleTouchMove = useCallback((e: React.TouchEvent) => {
        if (!touchStartRef.current || !wrapRef.current) return;
        const dx = e.touches[0].clientX - touchStartRef.current.x;
        const dy = e.touches[0].clientY - touchStartRef.current.y;

        // Lock direction after 8px movement
        if (!swipeState.current.locked) {
            if (Math.abs(dx) > 8 || Math.abs(dy) > 8) {
                swipeState.current.locked = true;
                swipeState.current.swiping = dx > 0 && Math.abs(dx) > Math.abs(dy);
            }
        }
        if (!swipeState.current.swiping) return;

        const clamped = Math.max(0, Math.min(dx * 0.55, 80));
        wrapRef.current.style.transition = "none";
        wrapRef.current.style.transform = `translateX(${clamped}px)`;

        // Animate swipe reply indicator
        const indicator = rowRef.current?.querySelector("[data-swipe-reply]") as HTMLElement | null;
        if (indicator) {
            const progress = Math.min(clamped / 50, 1);
            indicator.style.opacity = String(progress);
            indicator.style.transform = `translateY(-50%) scale(${0.5 + progress * 0.5})`;
        }
    }, []);

    const handleTouchEnd = useCallback((e: React.TouchEvent) => {
        // Handle swipe release
        if (swipeState.current.swiping && wrapRef.current) {
            const dx = e.changedTouches[0].clientX - (touchStartRef.current?.x || 0);
            wrapRef.current.style.transition = "transform 0.25s cubic-bezier(.2,.9,.3,1)";
            wrapRef.current.style.transform = "";

            const indicator = rowRef.current?.querySelector("[data-swipe-reply]") as HTMLElement | null;
            if (indicator) {
                indicator.style.transition = "opacity 0.2s, transform 0.2s";
                indicator.style.opacity = "0";
                indicator.style.transform = "translateY(-50%) scale(0.5)";
                // Reset transition after animation
                setTimeout(() => { if (indicator) indicator.style.transition = ""; }, 220);
            }

            if (dx * 0.55 >= 50) {
                onReply?.(msg);
            }
            touchStartRef.current = null;
            swipeState.current = { locked: false, swiping: false };
            return;
        }

        swipeState.current = { locked: false, swiping: false };

        // Existing: tap to toggle toolbar
        if (!touchStartRef.current) return;
        const dx = Math.abs(e.changedTouches[0].clientX - touchStartRef.current.x);
        const dy = Math.abs(e.changedTouches[0].clientY - touchStartRef.current.y);
        const dt = Date.now() - touchStartRef.current.time;
        touchStartRef.current = null;
        if (dx > 10 || dy > 10 || dt > 500) return;
        const target = e.target as HTMLElement;
        if (target.closest && (
            target.closest("[data-toolbar]") ||
            target.closest("[data-picker]") ||
            target.closest("[data-reaction]") ||
            target.closest("a")
        )) return;
        e.preventDefault();
        setToolbarOpen(t => !t);
    }, [onReply, msg]);

    useEffect(() => {
        if (!toolbarOpen) return;
        const handler = (e: PointerEvent) => {
            if (rowRef.current && !rowRef.current.contains(e.target as Node)) {
                setToolbarOpen(false);
            }
        };
        document.addEventListener("pointerdown", handler);
        return () => document.removeEventListener("pointerdown", handler);
    }, [toolbarOpen]);

    if (msg.deleted_at) {
        return (
            <div className={`${s.row} ${isMine ? s.mine : s.theirs} ${!showAvatar ? s.grouped : s.groupStart}`}>
                <div className={s.avatarCol}>
                    {showAvatar && <ChatAvatar name={msg.sender_name} avatar={msg.sender_avatar} size="sm" />}
                </div>
                <div className={s.bubbleWrap}>
                    <div className={`${s.bubble} ${isMine ? s.myBubble : s.theirBubble} ${s.deleted}`}>
                        <em>This message was deleted</em>
                    </div>
                </div>
            </div>
        );
    }

    const isPoll = msg.format_type === "poll" && msg.metadata?.pollId;
    const isPending = String(msg.id).startsWith("pending_");

    const menuItems: ContextMenuItem[] = isPending ? [] : [
        isMine && !msg.file_url && !isPoll && { icon: <Pencil size={14} />, label: "Edit", onClick: () => onEdit?.(msg) },
        { icon: <Pin size={14} />, label: msg.pinned_at ? "Unpin" : "Pin", onClick: () => onPin?.(msg) },
        { icon: <Star size={14} />, label: msg.starred ? "Unsave" : "Save", onClick: () => onStar?.(msg) },
        { icon: <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M10 3l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/><path d="M14 7H7a5 5 0 000 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>, label: "Forward", onClick: () => onForward?.(msg) },
        isMine && { icon: <Trash2 size={14} />, label: "Delete", onClick: () => onDelete?.(msg), danger: true },
    ].filter(Boolean) as ContextMenuItem[];

    return (
        <div ref={rowRef} className={`${s.row} ${isMine ? s.mine : s.theirs} ${!showAvatar ? s.grouped : s.groupStart}`}>
            {/* Swipe-to-reply indicator */}
            <div className={s.swipeReply} data-swipe-reply>
                <svg width="18" height="18" viewBox="0 0 16 16" fill="none"><path d="M6 3L2 7l4 4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/><path d="M2 7h7a5 5 0 010 5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/></svg>
            </div>

            <div className={s.avatarCol}>
                {showAvatar && <ChatAvatar name={msg.sender_name} avatar={msg.sender_avatar} size="sm" />}
            </div>

            <div
                ref={wrapRef}
                className={s.bubbleWrap}
                onTouchStart={handleTouchStart}
                onTouchMove={handleTouchMove}
                onTouchEnd={handleTouchEnd}
            >
                {showName && !isMine && msg.sender_name && (
                    <div className={s.senderName}>{msg.sender_name}</div>
                )}
                {showName && isMine && (
                    <div className={`${s.senderName} ${s.mineName}`}>You</div>
                )}

                <div
                    ref={bubbleRef}
                    className={`${s.bubble} ${isMine ? s.myBubble : s.theirBubble} ${msg.pinned_at ? s.pinned : ""} ${msg.starred ? s.starredBubble : ""} ${toolbarOpen ? s.toolbarActive : ""} ${isPending ? s.pendingBubble : ""}`}
                    onContextMenu={isPending ? undefined : handleContext}
                >
                    {msg.pinned_at && <div className={s.pinnedBadge}><Pin size={11} style={{ marginRight: 4 }} />Pinned</div>}
                    {msg.starred && <div className={s.starBadge}><Star size={11} /></div>}

                    {msg.forwarded_from_id && (
                        <div className={s.forwarded}>↗ Forwarded</div>
                    )}

                    {msg.reply_to_id && (
                        <ReplyPreview
                            senderName={msg.reply_sender_name || "User"}
                            content={msg.reply_content}
                            onClick={() => onJumpTo && onJumpTo(msg.reply_to_id)}
                        />
                    )}

                    {msg.file_url && (
                        <FilePreview
                            fileUrl={msg.file_url}
                            fileName={msg.file_name}
                            fileType={msg.file_type}
                            fileSize={msg.file_size}
                            isMessage
                        />
                    )}

                    {isPoll && <PollDisplay pollId={msg.metadata.pollId} userId={userId as number | string} isMine={isMine} />}

                    {msg.content && !isPoll && (
                        <MessageContent text={msg.content} isMine={isMine} />
                    )}

                    <div className={s.meta}>
                        <span className={s.time}>
                            {new Date(msg.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                        </span>
                        {msg.edited_at && <span className={s.edited}>(edited)</span>}
                        <DeliveryStatus
                            isMine={isMine}
                            msg={msg}
                            participantCount={participantCount}
                            readReceipts={readReceipts}
                            userId={userId as number | string}
                        />
                    </div>

                    {!isPending && (
                        <MessageToolbar
                            msg={msg}
                            isMine={isMine}
                            onReply={onReply}
                            onEdit={onEdit}
                            onReact={onReact}
                            onOpenReactions={() => { setShowReactions(true); setToolbarOpen(false); }}
                            onOpenContextMenu={handleContext as any}
                            onCloseToolbar={() => setToolbarOpen(false)}
                        />
                    )}
                </div>

                <ReactionBar
                    msg={msg}
                    userId={userId as number | string}
                    onReact={onReact}
                />
            </div>

            {showReactions && createPortal(
                <EmojiGifPicker
                    onSelectEmoji={(emoji: string) => { onReact?.(msg.id, emoji); setShowReactions(false); }}
                    onClose={() => setShowReactions(false)}
                    style={(() => {
                        const isMobile = window.innerWidth <= 480;
                        const rect = bubbleRef.current?.getBoundingClientRect();
                        if (!rect || isMobile) {
                            return { position: "fixed", top: "50%", left: "50%", transform: "translate(-50%,-50%)", zIndex: 10000 };
                        }
                        const pickerWidth = Math.min(340, window.innerWidth - 16);
                        const pickerHeight = Math.min(400, window.innerHeight - 16);
                        let left = isMine ? rect.right - pickerWidth : rect.left;
                        left = Math.max(8, Math.min(left, window.innerWidth - pickerWidth - 8));
                        let top = rect.top - pickerHeight - 8;
                        if (top < 8) top = rect.bottom + 4;
                        if (top + pickerHeight > window.innerHeight - 8) top = window.innerHeight - pickerHeight - 8;
                        return { position: "fixed", top: `${top}px`, left: `${left}px`, bottom: "auto", right: "auto", marginBottom: 0, zIndex: 10000 };
                    })() as React.CSSProperties}
                />,
                document.body
            )}

            {ctxMenu && (
                <ContextMenu
                    x={ctxMenu.x}
                    y={ctxMenu.y}
                    items={menuItems}
                    onClose={() => setCtxMenu(null)}
                />
            )}
        </div>
    );
}
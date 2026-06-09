/* eslint-disable @typescript-eslint/no-explicit-any */
/* ─────────────────────────────────────────────────────────
   ReactionsBar — simple like button with user names.
   Stores `page.reactions = { '👍': [userId, ...] }`.
   ───────────────────────────────────────────────────────── */
import React, { useState, useRef } from "react";
import { Heart } from "lucide-react";
import { useClickOutside } from "../../../hooks/useClickOutside";
import s from "./ReactionsBar.module.css";

interface ReactionsBarProps {
    reactions?: Record<string, any[]>;
    currentUserId?: any;
    onToggle?: (emoji: string) => void;
    mentionableUsers?: any[];
}

export default function ReactionsBar({ reactions, currentUserId, onToggle, mentionableUsers = [] }: ReactionsBarProps) {
    const [showUsers, setShowUsers] = useState(false);
    const ref = useRef<HTMLDivElement | null>(null);
    useClickOutside(ref, () => setShowUsers(false), showUsers);

    const likedIds = reactions?.["👍"] || [];
    const liked = likedIds.includes(currentUserId);
    const count = likedIds.length;

    const getUserName = (id: any) => {
        const u = mentionableUsers.find(m => m.id === id);
        return u?.name || u?.full_name || "Unknown";
    };

    return (
        <div className={s.bar}>
            <button
                type="button"
                className={`${s.likeBtn} ${liked ? s.likeBtnActive : ""}`}
                onClick={() => onToggle?.("👍")}
                title={liked ? "Unlike this page" : "Like this page"}
            >
                <Heart size={14} className={liked ? s.heartFilled : s.heartEmpty} />
                {count > 0 && <span className={s.likeCount}>{count}</span>}
            </button>
            {count > 0 && (
                <div ref={ref} className={s.namesWrap}>
                    <button
                        type="button"
                        className={s.namesBtn}
                        onClick={() => setShowUsers(o => !o)}
                    >
                        {count === 1
                            ? `${liked ? "You" : getUserName(likedIds[0])} liked this`
                            : liked
                                ? count === 2
                                    ? `You and ${getUserName(likedIds.find(id => id !== currentUserId))} liked this`
                                    : `You and ${count - 1} other${count - 1 > 1 ? "s" : ""} liked this`
                                : `${count} people liked this`
                        }
                    </button>
                    {showUsers && (
                        <div className={s.usersList}>
                            {likedIds.map(id => (
                                <div key={id} className={s.userItem}>
                                    <span className={s.userDot} />
                                    <span>{id === currentUserId ? "You" : getUserName(id)}</span>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}
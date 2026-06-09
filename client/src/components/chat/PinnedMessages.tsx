import { useState, useEffect } from "react";
import { Pin, X, Search } from "lucide-react";
import { getPinnedMessages } from "../../api";
import ChatAvatar from "./ChatAvatar";
import s from "./PinnedMessages.module.css";

interface PinnedMessage {
    id: number | string;
    content?: string;
    file_name?: string;
    sender_name?: string;
    sender_avatar?: string;
    pinned_at?: string;
    [key: string]: unknown;
}

interface PinnedMessagesProps {
    convId: number | string;
    currentUserId?: number | string;
    onClose: () => void;
    onJumpTo?: (id: number | string) => void;
    onUnpin?: (id: number | string) => void;
}

export default function PinnedMessages({ convId, currentUserId, onClose, onJumpTo, onUnpin }: PinnedMessagesProps) {
    const [pins, setPins] = useState<PinnedMessage[]>([]);
    const [loading, setLoading] = useState(true);
    const [query, setQuery] = useState("");

    useEffect(() => {
        let cancelled = false;
        getPinnedMessages(convId).then(r => {
            if (!cancelled) setPins(r.data as PinnedMessage[]);
        }).catch(() => {}).finally(() => { if (!cancelled) setLoading(false); });
        return () => { cancelled = true; };
    }, [convId]);

    const filtered = query.trim()
        ? pins.filter(p => (p.content || p.file_name || "").toLowerCase().includes(query.toLowerCase()))
        : pins;

    return (
        <div className={s.panel}>
            <div className={s.header}>
                <span className={s.title}><Pin size={15} /> Pinned Messages</span>
                <button className={s.closeBtn} onClick={onClose}><X size={16} /></button>
            </div>

            {pins.length > 3 && (
                <div className={s.searchWrap}>
                    <Search size={14} className={s.searchIcon} />
                    <input
                        className={s.searchInput}
                        placeholder="Search pinned..."
                        value={query}
                        onChange={e => setQuery(e.target.value)}
                    />
                </div>
            )}

            <div className={s.list}>
                {loading && <div className={s.empty}>Loading…</div>}
                {!loading && pins.length === 0 && (
                    <div className={s.emptyState}>
                        <div className={s.emptyIcon}><Pin size={32} strokeWidth={1.2} /></div>
                        <p className={s.emptyTitle}>No pinned messages</p>
                        <p className={s.emptyDesc}>Pin important messages to find them quickly</p>
                    </div>
                )}
                {!loading && pins.length > 0 && filtered.length === 0 && (
                    <div className={s.empty}>No results for "{query}"</div>
                )}
                {filtered.map(p => (
                    <div key={p.id} className={s.item} onClick={() => onJumpTo?.(p.id)}>
                        <ChatAvatar name={p.sender_name} avatar={p.sender_avatar} size="sm" />
                        <div className={s.body}>
                            <div className={s.itemTop}>
                                <span className={s.sender}>{p.sender_name}</span>
                                <span className={s.date}>{new Date(p.pinned_at as string).toLocaleDateString([], { month: "short", day: "numeric" })}</span>
                            </div>
                            <span className={s.text}>{p.content || (p.file_name ? `📎 ${p.file_name}` : "🎤 Voice message")}</span>
                        </div>
                        {onUnpin && (
                            <button className={s.unpinBtn} onClick={e => { e.stopPropagation(); onUnpin(p.id); }} title="Unpin">
                                <X size={14} />
                            </button>
                        )}
                    </div>
                ))}
            </div>
        </div>
    );
}
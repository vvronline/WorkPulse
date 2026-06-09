import { useState, useEffect } from "react";
import { Bookmark, X, Search, ArrowUpRight } from "lucide-react";
import s from "./StarredMessages.module.css";
import { getStarredMessages, toggleStar } from "../../api";

interface StarredMessage {
    id: number | string;
    content?: string;
    file_name?: string;
    sender_name?: string;
    created_at?: string;
    conversation_name?: string;
    conversation_id?: number | string;
    [key: string]: unknown;
}

interface StarredMessagesProps {
    onJumpTo?: (conversationId: number | string | undefined, msgId: number | string) => void;
    onClose: () => void;
}

export default function StarredMessages({ onJumpTo, onClose }: StarredMessagesProps) {
    const [msgs, setMsgs] = useState<StarredMessage[]>([]);
    const [loading, setLoading] = useState(true);
    const [query, setQuery] = useState("");

    useEffect(() => {
        setLoading(true);
        getStarredMessages()
            .then(({ data }) => setMsgs(data as StarredMessage[]))
            .catch(() => setMsgs([]))
            .finally(() => setLoading(false));
    }, []);

    const handleUnstar = async (msgId: number | string) => {
        try {
            await toggleStar(msgId);
            setMsgs(prev => prev.filter(m => m.id !== msgId));
        } catch { /* ignore */ }
    };

    const filtered = query.trim()
        ? msgs.filter(m => (m.content || m.file_name || "").toLowerCase().includes(query.toLowerCase()))
        : msgs;

    return (
        <div className={s.panel}>
            <div className={s.header}>
                <span className={s.title}><Bookmark size={15} /> Saved Messages</span>
                <button className={s.closeBtn} onClick={onClose}><X size={16} /></button>
            </div>

            {msgs.length > 3 && (
                <div className={s.searchWrap}>
                    <Search size={14} className={s.searchIcon} />
                    <input
                        className={s.searchInput}
                        placeholder="Search saved..."
                        value={query}
                        onChange={e => setQuery(e.target.value)}
                    />
                </div>
            )}

            <div className={s.list}>
                {loading && <div className={s.empty}>Loading...</div>}
                {!loading && msgs.length === 0 && (
                    <div className={s.emptyState}>
                        <div className={s.emptyIcon}><Bookmark size={32} strokeWidth={1.2} /></div>
                        <p className={s.emptyTitle}>No saved messages</p>
                        <p className={s.emptyDesc}>Star messages to save them here for later</p>
                    </div>
                )}
                {!loading && msgs.length > 0 && filtered.length === 0 && (
                    <div className={s.empty}>No results for "{query}"</div>
                )}
                {filtered.map(m => (
                    <div key={m.id} className={s.item}>
                        <div className={s.itemHeader}>
                            <span className={s.sender}>{m.sender_name}</span>
                            <span className={s.date}>
                                {new Date(m.created_at as string).toLocaleDateString([], { month: "short", day: "numeric" })}
                            </span>
                        </div>
                        {m.conversation_name && (
                            <span className={s.convName}>in {m.conversation_name}</span>
                        )}
                        <div className={s.content}>
                            {m.content || (m.file_name ? `📎 ${m.file_name}` : "Attachment")}
                        </div>
                        <div className={s.actions}>
                            <button
                                className={s.actionBtn}
                                onClick={() => onJumpTo?.(m.conversation_id, m.id)}
                            >
                                <ArrowUpRight size={12} /> Go to message
                            </button>
                            <button
                                className={`${s.actionBtn} ${s.danger}`}
                                onClick={() => handleUnstar(m.id)}
                            >Remove</button>
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
}
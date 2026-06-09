import { useState, useRef } from "react";
import { searchChatUsers } from "../../../api";
import s from "../CallOverlay.module.css";

interface AddParticipantPopupProps {
    callId: string;
    conversationId: string;
    wsSend: (type: string, payload: Record<string, unknown>) => void;
    onClose: () => void;
}

export function AddParticipantPopup({ callId, conversationId, wsSend, onClose }: AddParticipantPopupProps) {
    const [query, setQuery] = useState("");
    const [results, setResults] = useState<any[]>([]);
    const [searching, setSearching] = useState(false);
    const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const handleSearch = (val: string) => {
        setQuery(val);
        if (timerRef.current) clearTimeout(timerRef.current);
        if (val.trim().length < 2) {
            setResults([]);
            return;
        }
        timerRef.current = setTimeout(async () => {
            setSearching(true);
            try {
                const r = await searchChatUsers(val.trim());
                setResults((r.data as any) || []);
            } catch {
                setResults([]);
            } finally {
                setSearching(false);
            }
        }, 300);
    };

    const handleInvite = (targetUserId: string) => {
        wsSend("call_add_participant", { callId, conversationId, targetUserId });
        onClose();
    };

    return (
        <div className={s.addPartPopup}>
            <div className={s.addPartHeader}>
                <span>Add to call</span>
                <button className={s.addPartClose} onClick={onClose}>
                    ×
                </button>
            </div>
            <input
                className={s.addPartInput}
                value={query}
                onChange={(e) => handleSearch(e.target.value)}
                placeholder="Search people…"
                autoFocus
            />
            {searching && <div className={s.addPartLoading}>Searching…</div>}
            {results.length > 0 && (
                <ul className={s.addPartResults}>
                    {results.map((u: any) => (
                        <li key={u.id} className={s.addPartResult} onClick={() => handleInvite(u.id)}>
                            {u.name || u.full_name || u.username}
                            {u.email && <span className={s.addPartEmail}>{u.email}</span>}
                        </li>
                    ))}
                </ul>
            )}
            {query.trim().length >= 2 && !searching && results.length === 0 && (
                <div className={s.addPartLoading}>No results found</div>
            )}
        </div>
    );
}
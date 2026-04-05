import { useState, useRef } from 'react';
import { searchChatUsers } from '../../../api';
import s from '../CallOverlay.module.css';

export function AddParticipantPopup({ callId, conversationId, wsSend, onClose }) {
    const [query, setQuery] = useState('');
    const [results, setResults] = useState([]);
    const [searching, setSearching] = useState(false);
    const timerRef = useRef(null);

    const handleSearch = (val) => {
        setQuery(val);
        clearTimeout(timerRef.current);
        if (val.trim().length < 2) { setResults([]); return; }
        timerRef.current = setTimeout(async () => {
            setSearching(true);
            try {
                const r = await searchChatUsers(val.trim());
                setResults(r.data || []);
            } catch { setResults([]); }
            finally { setSearching(false); }
        }, 300);
    };

    const handleInvite = (targetUserId) => {
        wsSend('call_add_participant', { callId, conversationId, targetUserId });
        onClose();
    };

    return (
        <div className={s.addPartPopup}>
            <div className={s.addPartHeader}>
                <span>Add to call</span>
                <button className={s.addPartClose} onClick={onClose}>×</button>
            </div>
            <input
                className={s.addPartInput}
                value={query}
                onChange={e => handleSearch(e.target.value)}
                placeholder="Search people…"
                autoFocus
            />
            {searching && <div className={s.addPartLoading}>Searching…</div>}
            {results.length > 0 && (
                <ul className={s.addPartResults}>
                    {results.map(u => (
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

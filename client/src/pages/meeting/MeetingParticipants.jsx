import React, { useState, useRef } from 'react';
import { searchChatUsers } from '../../api';
import './MeetingRoom.css';

/**
 * Participants panel (sidebar) — lists active participants,
 * allows organizer to mute/remove, and add new participants.
 */
export default function MeetingParticipants({ participants, localUserId, isOrganizer, onMute, onAdd }) {
    const [showAdd, setShowAdd] = useState(false);
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
                const participantIds = new Set([...participants.keys()]);
                setResults((r.data || []).filter(u => !participantIds.has(u.id)));
            } catch { setResults([]); }
            finally { setSearching(false); }
        }, 300);
    };

    const participantList = [...participants.values()];

    return (
        <div className="mp-panel">
            <div className="mp-header">
                <span>Participants ({participantList.length})</span>
                {isOrganizer && (
                    <button className="mp-add-btn" onClick={() => setShowAdd(v => !v)}>＋ Add</button>
                )}
            </div>

            {showAdd && (
                <div className="mp-add-wrap">
                    <input
                        className="mp-search"
                        value={query}
                        onChange={e => handleSearch(e.target.value)}
                        placeholder="Search to add…"
                    />
                    {searching && <div className="mp-searching">…</div>}
                    {results.length > 0 && (
                        <ul className="mp-results">
                            {results.map(u => (
                                <li key={u.id} className="mp-result-item">
                                    <span>{u.name || u.full_name || u.username}</span>
                                    <button
                                        className="mp-invite-btn"
                                        onClick={() => { onAdd(u.id); setResults([]); setQuery(''); setShowAdd(false); }}
                                    >
                                        Invite
                                    </button>
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
            )}

            <div className="mp-list">
                {participantList.map(p => (
                    <div key={p.userId} className="mp-item">
                        <span className="mp-avatar">{(p.name || 'U')[0].toUpperCase()}</span>
                        <span className="mp-name">
                            {p.name || 'Participant'}
                            {p.userId === localUserId && <span className="mp-you"> (you)</span>}
                        </span>
                        {p.raisedHand && <span className="mp-hand">✋</span>}
                        {p.muted && <span className="mp-muted">🔇</span>}
                        {isOrganizer && p.userId !== localUserId && (
                            <button className="mp-mute-btn" onClick={() => onMute(p.userId)} title="Mute participant">
                                🔇
                            </button>
                        )}
                    </div>
                ))}
            </div>
        </div>
    );
}

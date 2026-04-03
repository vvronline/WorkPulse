import React, { useState, useEffect } from 'react';
import { getCallHistory } from '../../api';
import s from './CallHistory.module.css';

function formatDuration(secs) {
    if (!secs) return '—';
    const m = Math.floor(secs / 60);
    const sec = secs % 60;
    if (m === 0) return `${sec}s`;
    return `${m}m ${sec > 0 ? sec + 's' : ''}`.trim();
}

function formatTime(iso) {
    const d = new Date(iso);
    const now = new Date();
    const isToday = d.toDateString() === now.toDateString();
    if (isToday) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

const STATUS_LABEL = {
    completed: { label: 'Completed', icon: '✓', cls: s.completed },
    missed: { label: 'Missed', icon: '↘', cls: s.missed },
    declined: { label: 'Declined', icon: '✕', cls: s.declined },
    cancelled: { label: 'Cancelled', icon: '—', cls: s.cancelled },
};

/**
 * Slide-in call history panel for a conversation.
 */
export default function CallHistory({ convId, currentUserId, onClose }) {
    const [calls, setCalls] = useState([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        if (!convId) return;
        setLoading(true);
        getCallHistory(convId)
            .then(r => setCalls(r.data || []))
            .catch(() => setCalls([]))
            .finally(() => setLoading(false));
    }, [convId]);

    return (
        <div className={s.panel}>
            <div className={s.header}>
                <span>Call History</span>
                <button className={s.closeBtn} onClick={onClose}>✕</button>
            </div>
            <div className={s.list}>
                {loading && <div className={s.empty}>Loading…</div>}
                {!loading && calls.length === 0 && (
                    <div className={s.empty}>No calls yet in this conversation.</div>
                )}
                {calls.map(call => {
                    const isOutgoing = call.caller_id === currentUserId;
                    const st = STATUS_LABEL[call.status] || { label: call.status, icon: '?', cls: '' };
                    return (
                        <div key={call.id} className={`${s.item} ${call.status === 'missed' && !isOutgoing ? s.itemMissed : ''}`}>
                            <span className={s.typeIcon}>
                                {call.call_type === 'video' ? '🎥' : '📞'}
                            </span>
                            <div className={s.itemBody}>
                                <div className={s.itemTop}>
                                    <span className={s.direction}>{isOutgoing ? 'Outgoing' : 'Incoming'}</span>
                                    <span className={`${s.status} ${st.cls}`}>{st.icon} {st.label}</span>
                                </div>
                                <div className={s.itemBottom}>
                                    <span className={s.duration}>{formatDuration(call.duration)}</span>
                                    <span className={s.time}>{formatTime(call.created_at || call.started_at)}</span>
                                </div>
                            </div>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}

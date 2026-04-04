import React, { useState, useEffect } from 'react';
import { Video, Phone, PhoneIncoming, PhoneOutgoing, PhoneMissed, X, Clock } from 'lucide-react';
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
    const diff = now - d;
    const isToday = d.toDateString() === now.toDateString();
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    const isYesterday = d.toDateString() === yesterday.toDateString();

    const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    if (isToday) return time;
    if (isYesterday) return `Yesterday, ${time}`;
    if (diff < 7 * 86400000) return `${d.toLocaleDateString([], { weekday: 'short' })}, ${time}`;
    return d.toLocaleDateString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function getDirectionIcon(call, isOutgoing) {
    if (call.status === 'missed' && !isOutgoing) return <PhoneMissed size={16} className={s.iconMissed} />;
    if (isOutgoing) return <PhoneOutgoing size={16} className={s.iconOutgoing} />;
    return <PhoneIncoming size={16} className={s.iconIncoming} />;
}

/**
 * Teams-style call history panel for a conversation.
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
                <div className={s.headerTitle}>
                    <Clock size={16} />
                    <span>Call history</span>
                </div>
                <button className={s.closeBtn} onClick={onClose} aria-label="Close"><X size={16} /></button>
            </div>
            <div className={s.list}>
                {loading && <div className={s.empty}><div className={s.spinner} />Loading…</div>}
                {!loading && calls.length === 0 && (
                    <div className={s.empty}>
                        <Phone size={32} strokeWidth={1.2} />
                        <p>No calls yet</p>
                    </div>
                )}
                {calls.map(call => {
                    const isOutgoing = call.caller_id === currentUserId;
                    const isMissed = call.status === 'missed' && !isOutgoing;
                    return (
                        <div key={call.id} className={`${s.item} ${isMissed ? s.itemMissed : ''}`}>
                            <div className={s.directionIcon}>
                                {getDirectionIcon(call, isOutgoing)}
                            </div>
                            <div className={s.itemBody}>
                                <div className={s.itemTop}>
                                    <span className={`${s.direction} ${isMissed ? s.dirMissed : ''}`}>
                                        {isOutgoing ? 'Outgoing' : 'Incoming'} {call.call_type === 'video' ? 'video' : ''} call
                                    </span>
                                </div>
                                <div className={s.itemMeta}>
                                    <span className={s.time}>{formatTime(call.created_at || call.started_at)}</span>
                                    {call.duration > 0 && (
                                        <>
                                            <span className={s.dot}>·</span>
                                            <span className={s.duration}>{formatDuration(call.duration)}</span>
                                        </>
                                    )}
                                    {isMissed && <span className={s.missedBadge}>Missed</span>}
                                    {call.status === 'declined' && <span className={s.declinedBadge}>Declined</span>}
                                </div>
                            </div>
                            <div className={s.callType}>
                                {call.call_type === 'video' ? <Video size={14} /> : <Phone size={14} />}
                            </div>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}

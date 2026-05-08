/* TimeTrackingBlock — live time-tracking summary embedded in a note.
   Inserted via slash menu /time. Shows today's tracked hours, break time,
   clock-in/out times, and work mode. Auto-refreshes. */
import React, { useState, useEffect, useCallback } from 'react';
import { getTimeSummary } from '../../../api';
import { Clock, Coffee, MapPin, RefreshCw, Play, Square, Trash2, X } from 'lucide-react';
import s from './TimeTrackingBlock.module.css';

function formatTime(iso) {
    if (!iso) return '—';
    return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

export default function TimeTrackingBlock({ onRemove }) {
    const [data, setData] = useState(null);
    const [loading, setLoading] = useState(true);
    const [ctxMenu, setCtxMenu] = useState(null);

    const handleContextMenu = (e) => {
        e.preventDefault();
        setCtxMenu({ x: e.clientX, y: e.clientY });
    };

    useEffect(() => {
        if (!ctxMenu) return;
        const close = () => setCtxMenu(null);
        document.addEventListener('click', close);
        document.addEventListener('scroll', close, true);
        return () => {
            document.removeEventListener('click', close);
            document.removeEventListener('scroll', close, true);
        };
    }, [ctxMenu]);

    const fetchData = useCallback(async () => {
        setLoading(true);
        try {
            const res = await getTimeSummary();
            setData(res.data);
        } catch { /* ignore */ }
        setLoading(false);
    }, []);

    useEffect(() => { fetchData(); }, [fetchData]);

    if (loading) {
        return <div className={s.card}><div className={s.loading}>Loading time data…</div></div>;
    }
    if (!data) {
        return <div className={s.card}><div className={s.empty}><Clock size={14} /> No time data for today</div></div>;
    }

    const modeLabels = { office: '🏢 Office', remote: '🏠 Remote', hybrid: '🔄 Hybrid' };

    return (
        <div className={s.card} contentEditable={false} onContextMenu={handleContextMenu}>
            <div className={s.header}>
                <Clock size={14} />
                <span className={s.title}>Today's Time</span>
                {data.isActive && <span className={s.activeBadge}><Play size={9} /> Active</span>}
                {!data.isActive && data.lastClockOut && <span className={s.doneBadge}><Square size={9} /> Done</span>}
                <button className={s.refreshBtn} onClick={fetchData} title="Refresh"><RefreshCw size={12} /></button>
                {onRemove && <button className={s.removeBtn} onClick={onRemove} title="Remove"><X size={12} /></button>}
            </div>
            {ctxMenu && (
                <div className={s.ctxMenu} style={{ position: 'fixed', left: ctxMenu.x, top: ctxMenu.y, zIndex: 10000 }}>
                    <button className={s.ctxItem} onClick={() => { fetchData(); setCtxMenu(null); }}>
                        <RefreshCw size={12} /> Refresh
                    </button>
                    {onRemove && (
                        <button className={`${s.ctxItem} ${s.ctxDanger}`} onClick={() => { setCtxMenu(null); onRemove(); }}>
                            <Trash2 size={12} /> Remove block
                        </button>
                    )}
                </div>
            )}

            <div className={s.grid}>
                <div className={s.metric}>
                    <span className={s.metricValue}>{data.hoursWorked}h</span>
                    <span className={s.metricLabel}>Worked</span>
                </div>
                <div className={s.metric}>
                    <span className={s.metricValue}>{data.breakHours}h</span>
                    <span className={s.metricLabel}><Coffee size={10} /> Break</span>
                </div>
                <div className={s.metric}>
                    <span className={s.metricValue}>{formatTime(data.firstClockIn)}</span>
                    <span className={s.metricLabel}>Clock In</span>
                </div>
                <div className={s.metric}>
                    <span className={s.metricValue}>{formatTime(data.lastClockOut)}</span>
                    <span className={s.metricLabel}>Clock Out</span>
                </div>
            </div>

            {data.workMode && (
                <div className={s.mode}>
                    <MapPin size={11} /> {modeLabels[data.workMode] || data.workMode}
                </div>
            )}
        </div>
    );
}

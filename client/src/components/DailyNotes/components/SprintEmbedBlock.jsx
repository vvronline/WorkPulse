/* SprintEmbedBlock — live sprint board/burndown embedded inside a note.
   Inserted via slash menu /sprint. Renders as a self-contained card that
   auto-refreshes sprint data from the server. */
import React, { useState, useEffect, useCallback } from 'react';
import { getSprintEmbed } from '../../../api';
import { Rocket, CheckSquare, Clock, AlertCircle, CheckCircle2, RefreshCw, Trash2, X } from 'lucide-react';
import s from './SprintEmbedBlock.module.css';

const STATUS_LABELS = {
    pending: 'To Do',
    in_progress: 'In Progress',
    in_review: 'In Review',
    done: 'Done',
};
const STATUS_COLORS = {
    pending: '#94a3b8',
    in_progress: '#3b82f6',
    in_review: '#f59e0b',
    done: '#10b981',
};

function ProgressBar({ stats }) {
    const total = stats.total || 1;
    const segments = [
        { key: 'done', pct: (stats.done / total) * 100, color: STATUS_COLORS.done },
        { key: 'in_review', pct: (stats.inReview / total) * 100, color: STATUS_COLORS.in_review },
        { key: 'in_progress', pct: (stats.inProgress / total) * 100, color: STATUS_COLORS.in_progress },
        { key: 'pending', pct: (stats.pending / total) * 100, color: STATUS_COLORS.pending },
    ];
    return (
        <div className={s.progressBar}>
            {segments.map(seg => seg.pct > 0 && (
                <div key={seg.key} className={s.progressSeg}
                    style={{ width: `${seg.pct}%`, background: seg.color }}
                    title={`${STATUS_LABELS[seg.key]}: ${Math.round(seg.pct)}%`}
                />
            ))}
        </div>
    );
}

export default function SprintEmbedBlock({ onRemove }) {
    const [data, setData] = useState(null);
    const [loading, setLoading] = useState(true);
    const [collapsed, setCollapsed] = useState(false);
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
            const res = await getSprintEmbed();
            setData(res.data);
        } catch { /* ignore */ }
        setLoading(false);
    }, []);

    useEffect(() => { fetchData(); }, [fetchData]);

    if (loading) {
        return <div className={s.card}><div className={s.loading}>Loading sprint data…</div></div>;
    }
    if (!data?.sprint) {
        return <div className={s.card}><div className={s.empty}><Rocket size={16} /> No active sprint</div></div>;
    }

    const { sprint, tasks, stats } = data;
    const pctDone = stats.total > 0 ? Math.round((stats.done / stats.total) * 100) : 0;

    return (
        <div className={s.card} contentEditable={false} onContextMenu={handleContextMenu}>
            <div className={s.header}>
                <Rocket size={14} />
                <span className={s.sprintName}>{sprint.name}</span>
                <span className={s.dates}>
                    {sprint.start_date} → {sprint.end_date}
                </span>
                <button className={s.refreshBtn} onClick={fetchData} title="Refresh"><RefreshCw size={12} /></button>
                {onRemove && <button className={s.removeBtn} onClick={onRemove} title="Remove"><X size={12} /></button>}
            </div>
            {ctxMenu && (
                <div className={s.ctxMenu} style={{ position: 'fixed', left: ctxMenu.x, top: ctxMenu.y, zIndex: 10000 }}>
                    <button className={s.ctxItem} onClick={() => { fetchData(); setCtxMenu(null); }}>
                        <RefreshCw size={12} /> Refresh
                    </button>
                    <button className={s.ctxItem} onClick={() => { setCollapsed(c => !c); setCtxMenu(null); }}>
                        {collapsed ? '▸ Expand tasks' : '▾ Collapse tasks'}
                    </button>
                    {onRemove && (
                        <button className={`${s.ctxItem} ${s.ctxDanger}`} onClick={() => { setCtxMenu(null); onRemove(); }}>
                            <Trash2 size={12} /> Remove block
                        </button>
                    )}
                </div>
            )}

            {sprint.goal && <div className={s.goal}>🎯 {sprint.goal}</div>}

            <ProgressBar stats={stats} />

            <div className={s.statRow}>
                <span className={s.stat}><CheckCircle2 size={11} /> {stats.done}/{stats.total} done ({pctDone}%)</span>
                <span className={s.stat} style={{ color: STATUS_COLORS.in_progress }}>
                    <Clock size={11} /> {stats.inProgress} in progress
                </span>
                <span className={s.stat} style={{ color: STATUS_COLORS.in_review }}>
                    <AlertCircle size={11} /> {stats.inReview} in review
                </span>
            </div>

            <button className={s.toggleBtn} onClick={() => setCollapsed(c => !c)}>
                {collapsed ? 'Show tasks ▸' : 'Hide tasks ▾'}
            </button>

            {!collapsed && (
                <div className={s.taskList}>
                    {['pending', 'in_progress', 'in_review', 'done'].map(status => {
                        const group = tasks.filter(t => t.status === status);
                        if (group.length === 0) return null;
                        return (
                            <div key={status} className={s.taskGroup}>
                                <div className={s.groupLabel} style={{ color: STATUS_COLORS[status] }}>
                                    {STATUS_LABELS[status]} ({group.length})
                                </div>
                                {group.map(t => (
                                    <div key={t.id} className={s.taskRow}>
                                        <span className={s.taskDot} style={{ background: STATUS_COLORS[status] }} />
                                        <span className={s.taskTitle}>{t.title}</span>
                                        {t.assignee_name && <span className={s.assignee}>{t.assignee_name}</span>}
                                    </div>
                                ))}
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
}

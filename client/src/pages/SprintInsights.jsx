/**
 * SprintInsights — Phase 3 Agile reporting view.
 *
 * One screen, one selected sprint, four widgets:
 *   1. Sprint summary (re-uses /sprints/:id/stats)
 *   2. Burndown chart  (line, ideal vs actual)
 *   3. Velocity chart  (bar, last N sprints)
 *   4. Cumulative flow (stacked area by category)
 *   5. Cycle / Lead time (per-task scatter + summary stats)
 *   6. Retrospective editor (Went well / To improve / Action items / Mood)
 *
 * Visible to any authenticated team member; the underlying endpoints enforce
 * tenant + team boundaries.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
    BarChart3, LineChart, Layers, ListChecks, RefreshCw, ArrowLeft, MessageSquare,
} from 'lucide-react';
import {
    getSprints, getSprintStats, getSprintTasks,
    getSprintCumulativeFlow, getSprintCycleTime,
    getSprintRetrospective, updateSprintRetrospective,
} from '../api';
import { useAgileConfig } from '../AgileConfigContext';
import { BurndownChart, VelocityChart } from '../components/agile/AgileWorkflowPanels.jsx';
import s from './SprintInsights.module.css';

export default function SprintInsights() {
    const { unitLabel } = useAgileConfig();
    const [searchParams, setSearchParams] = useSearchParams();
    const [sprints, setSprints] = useState([]);
    const [selectedId, setSelectedId] = useState(null);
    const [stats, setStats] = useState(null);
    const [sprintTasks, setSprintTasks] = useState([]);
    const [cfd, setCfd] = useState(null);
    const [cycle, setCycle] = useState(null);
    const [retro, setRetro] = useState(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        getSprints().then(r => {
            const list = r.data?.sprints || [];
            setSprints(list);
            // Honour deep-link ?sprint_id=… when present and valid; otherwise
            // fall back to the active sprint or the first one in the list.
            const requested = Number(searchParams.get('sprint_id'));
            const requestedExists = requested && list.some(sp => sp.id === requested);
            if (requestedExists) {
                setSelectedId(requested);
            } else {
                const active = list.find(s => s.status === 'active');
                setSelectedId(active?.id || list[0]?.id || null);
            }
            // Strip the query param after consuming so subsequent sprint-select
            // changes feel like normal navigation (no stale URL state).
            if (searchParams.get('sprint_id')) {
                setSearchParams({}, { replace: true });
            }
        });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const reload = () => {
        if (!selectedId) return;
        setLoading(true);
        Promise.all([
            getSprintStats(selectedId).then(r => r.data).catch(() => null),
            getSprintCumulativeFlow(selectedId).then(r => r.data).catch(() => null),
            getSprintCycleTime(selectedId).then(r => r.data).catch(() => null),
            getSprintRetrospective(selectedId).then(r => r.data?.retrospective).catch(() => null),
            getSprintTasks(selectedId).then(r => r.data?.tasks || []).catch(() => []),
        ]).then(([st, cf, cy, re, tk]) => {
            setStats(st); setCfd(cf); setCycle(cy); setRetro(re); setSprintTasks(tk);
        }).finally(() => setLoading(false));
    };
    useEffect(reload, [selectedId]);

    const selectedSprint = sprints.find(sp => sp.id === selectedId);

    return (
        <div className={s.page}>
            <header className={s.header}>
                <div>
                    <Link to="/tasks" className={s.backLink}><ArrowLeft size={14} /> Back to Tasks</Link>
                    <h1 className={s.title}>Sprint Insights</h1>
                    <p className={s.subtitle}>Burndown, velocity, cumulative flow, cycle time and retrospectives.</p>
                </div>
                <div className={s.headerActions}>
                    <select
                        className={s.sprintSelect}
                        value={selectedId || ''}
                        onChange={e => setSelectedId(Number(e.target.value))}
                    >
                        {['active', 'planned', 'completed'].map(status => {
                            const group = sprints.filter(sp => sp.status === status);
                            if (!group.length) return null;
                            return (
                                <optgroup key={status} label={status.charAt(0).toUpperCase() + status.slice(1)}>
                                    {group.map(sp => (
                                        <option key={sp.id} value={sp.id}>{sp.name}</option>
                                    ))}
                                </optgroup>
                            );
                        })}
                    </select>
                    <button className="btn btn-secondary btn-sm" onClick={reload} title="Refresh data">
                        <RefreshCw size={13} />
                    </button>
                </div>
            </header>

            {!selectedId && <div className={s.empty}>Select a sprint to see insights.</div>}

            {selectedId && (
                <>
                    {/* Sprint summary card */}
                    {stats && (
                        <section className={s.card}>
                            <div className={s.summaryGrid}>
                                <Stat label="Tickets" value={`${stats.totals.doneTasks}/${stats.totals.tasks}`} sub={`${stats.totals.percentByTasks}% complete`} />
                                <Stat label={`Points (${unitLabel})`} value={`${stats.totals.donePoints}/${stats.totals.points}`} sub={`${stats.totals.percentByPoints}% complete`} />
                                <Stat label="Unestimated" value={stats.totals.unestimatedTasks} kind={stats.totals.unestimatedTasks > 0 ? 'warning' : 'ok'} />
                                <Stat label="Blocked" value={stats.totals.blockedTasks} kind={stats.totals.blockedTasks > 0 ? 'danger' : 'ok'} />
                                {selectedSprint && (
                                    <Stat label="Status" value={selectedSprint.status} sub={`${selectedSprint.start_date} → ${selectedSprint.end_date}`} />
                                )}
                            </div>
                        </section>
                    )}

                    {/* Sprint Tickets */}
                    <section className={s.card}>
                        <h2 className={s.sectionTitle}><ListChecks size={16} /> Sprint Tickets</h2>
                        <SprintTicketsPanel tasks={sprintTasks} />
                    </section>

                    {/* Burndown + Velocity side-by-side on desktop */}
                    <section className={s.row2}>
                        <div className={s.card}>
                            <h2 className={s.sectionTitle}><LineChart size={16} /> Burndown</h2>
                            <BurndownChart sprintId={selectedId} />
                        </div>
                        <div className={s.card}>
                            <h2 className={s.sectionTitle}><BarChart3 size={16} /> Velocity</h2>
                            <VelocityChart limit={6} />
                        </div>
                    </section>

                    {/* Cumulative Flow */}
                    <section className={s.card}>
                        <h2 className={s.sectionTitle}><Layers size={16} /> Cumulative Flow</h2>
                        <CumulativeFlowChart data={cfd} />
                    </section>

                    {/* Cycle / Lead time */}
                    <section className={s.card}>
                        <h2 className={s.sectionTitle}><LineChart size={16} /> Cycle &amp; Lead Time</h2>
                        <CycleTimePanel data={cycle} />
                    </section>

                    {/* Retrospective */}
                    <section className={s.card}>
                        <h2 className={s.sectionTitle}><MessageSquare size={16} /> Retrospective</h2>
                        <RetrospectivePanel
                            sprintId={selectedId}
                            initial={retro}
                            onSaved={(row) => setRetro(row)}
                        />
                    </section>

                    {loading && <div className={s.loading}>Loading…</div>}
                </>
            )}
        </div>
    );
}

// ─── Subcomponents ────────────────────────────────────────────────────────────

function Stat({ label, value, sub, kind = 'default' }) {
    return (
        <div className={`${s.stat} ${s['stat-' + kind]}`}>
            <div className={s.statLabel}>{label}</div>
            <div className={s.statValue}>{value}</div>
            {sub && <div className={s.statSub}>{sub}</div>}
        </div>
    );
}

/**
 * CumulativeFlowChart — stacked-area SVG. The Y axis is task count, X axis is
 * the sprint days. Each band represents one workflow-state category. The
 * bands are ordered so "done" is at the top — tracking the Done band growing
 * is the easiest visual signal of healthy flow.
 */
function CumulativeFlowChart({ data }) {
    if (!data) return <div className={s.chartEmpty}>Loading…</div>;
    if (!data.series?.length) return <div className={s.chartEmpty}>No data yet for this sprint.</div>;

    const padL = 32, padR = 12, padT = 12, padB = 36;
    const w = 800, h = 240;
    const innerW = w - padL - padR;
    const innerH = h - padT - padB;

    const order = ['open', 'in_progress', 'in_review', 'done'];
    const colors = {
        open: '#9ca3af',
        in_progress: '#f59e0b',
        in_review: '#3b82f6',
        done: '#10b981',
    };
    const labels = {
        open: 'Open', in_progress: 'In Progress', in_review: 'In Review', done: 'Done',
    };

    const maxY = Math.max(1, ...data.series.map(d => order.reduce((a, k) => a + (d[k] || 0), 0)));
    const xStep = innerW / Math.max(1, data.series.length - 1);

    // Build a cumulative-stacked area path per category.
    const areas = order.map((cat) => {
        const idx = order.indexOf(cat);
        // Bottom = sum of all categories with index < idx (i.e. drawn below).
        const bottoms = data.series.map((d) => order.slice(0, idx).reduce((a, k) => a + (d[k] || 0), 0));
        const tops = data.series.map((d, i) => bottoms[i] + (d[cat] || 0));
        const yScale = (v) => padT + innerH - (innerH * v / maxY);
        const xAt = (i) => padL + i * xStep;
        const top = tops.map((v, i) => `${xAt(i).toFixed(1)},${yScale(v).toFixed(1)}`).join(' L ');
        const bottom = bottoms.map((v, i) => `${xAt(i).toFixed(1)},${yScale(v).toFixed(1)}`).reverse().join(' L ');
        return { cat, d: `M ${top} L ${bottom} Z`, color: colors[cat] };
    });

    // X-axis tick labels: first, middle, last.
    const tickIdx = [0, Math.floor(data.series.length / 2), data.series.length - 1];

    return (
        <div className={s.chartWrap}>
            <div className={s.legend}>
                {order.map(k => (
                    <span key={k} className={s.legendItem}>
                        <span className={s.legendSwatch} style={{ background: colors[k] }} />
                        {labels[k]}
                    </span>
                ))}
            </div>
            <svg viewBox={`0 0 ${w} ${h}`} className={s.chartSvg} role="img" aria-label="Cumulative flow chart">
                {/* y-axis grid */}
                {[0, 0.25, 0.5, 0.75, 1].map(p => {
                    const y = padT + innerH * p;
                    const v = Math.round(maxY * (1 - p));
                    return (
                        <g key={p}>
                            <line x1={padL} y1={y} x2={w - padR} y2={y} className={s.gridLine} />
                            <text x={padL - 4} y={y + 3} textAnchor="end" className={s.axisLabel}>{v}</text>
                        </g>
                    );
                })}
                {areas.map(a => (
                    <path key={a.cat} d={a.d} fill={a.color} fillOpacity={0.85} />
                ))}
                {/* x-axis labels */}
                {tickIdx.filter(i => i >= 0 && i < data.series.length).map(i => (
                    <text
                        key={i}
                        x={padL + i * xStep}
                        y={h - 12}
                        textAnchor={i === 0 ? 'start' : i === data.series.length - 1 ? 'end' : 'middle'}
                        className={s.axisLabel}
                    >
                        {data.series[i].date}
                    </text>
                ))}
            </svg>
        </div>
    );
}

function CycleTimePanel({ data }) {
    if (!data) return <div className={s.chartEmpty}>Loading…</div>;
    if (!data.tasks?.length) return <div className={s.chartEmpty}>No completed tickets yet.</div>;
    return (
        <>
            <div className={s.statRow}>
                <Stat label="Cycle (avg)" value={data.cycle.avg != null ? `${data.cycle.avg} d` : '—'} sub={`median ${data.cycle.median ?? '—'} · p90 ${data.cycle.p90 ?? '—'}`} />
                <Stat label="Lead (avg)" value={data.lead.avg != null ? `${data.lead.avg} d` : '—'} sub={`median ${data.lead.median ?? '—'} · p90 ${data.lead.p90 ?? '—'}`} />
                <Stat label="Tickets sampled" value={data.cycle.n} />
            </div>
            <table className={s.table}>
                <thead>
                    <tr>
                        <th>Ticket</th>
                        <th>Type</th>
                        <th>Story Points</th>
                        <th>Cycle (d)</th>
                        <th>Lead (d)</th>
                        <th>Completed</th>
                    </tr>
                </thead>
                <tbody>
                    {data.tasks.map(t => (
                        <tr key={t.id}>
                            <td>#{t.id} <a href={`/tasks?task=${t.id}`} className={s.taskLink}>{t.title}</a></td>
                            <td>
                                {t.type_name && (
                                    <span className={s.typeBadge} style={{ color: t.type_color, borderColor: t.type_color }}>
                                        {t.type_name}
                                    </span>
                                )}
                            </td>
                            <td>{t.story_points != null ? t.story_points : '—'}</td>
                            <td>{t.cycle_days != null ? t.cycle_days : '—'}</td>
                            <td>{t.lead_days != null ? t.lead_days : '—'}</td>
                            <td>{new Date(t.completed_at).toLocaleString()}</td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </>
    );
}

const PRIORITY_COLORS = { high: '#ef4444', medium: '#f59e0b', low: '#6b7280' };
const STATUS_LABELS = { pending: 'To Do', in_progress: 'In Progress', in_review: 'In Review', done: 'Done' };

function SprintTicketsPanel({ tasks }) {
    if (!tasks.length) return <div className={s.chartEmpty}>No tickets in this sprint.</div>;
    return (
        <div style={{ maxHeight: 360, overflowY: 'auto' }}>
            <table className={s.table}>
                <thead>
                    <tr>
                        <th>Ticket</th>
                        <th>Status</th>
                        <th>Priority</th>
                        <th>Points</th>
                    </tr>
                </thead>
                <tbody>
                    {tasks.map(t => (
                        <tr key={t.id}>
                            <td>#{t.id} <a href={`/tasks?task=${t.id}`} className={s.taskLink}>{t.title}</a></td>
                            <td>{STATUS_LABELS[t.status] || t.status}</td>
                            <td>
                                <span style={{ color: PRIORITY_COLORS[t.priority] || '#6b7280', fontWeight: 500, textTransform: 'capitalize' }}>
                                    {t.priority}
                                </span>
                            </td>
                            <td>{t.story_points != null ? t.story_points : '—'}</td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}

function RetrospectivePanel({ sprintId, initial, onSaved }) {
    const [wentWell, setWentWell] = useState('');
    const [toImprove, setToImprove] = useState('');
    const [summary, setSummary] = useState('');
    const [teamMood, setTeamMood] = useState(null);
    const [actionItems, setActionItems] = useState([]);
    const [newActionText, setNewActionText] = useState('');
    const [saving, setSaving] = useState(false);
    const [saved, setSaved] = useState(false);

    useEffect(() => {
        setWentWell(initial?.went_well || '');
        setToImprove(initial?.to_improve || '');
        setSummary(initial?.summary || '');
        setTeamMood(initial?.team_mood || null);
        setActionItems(Array.isArray(initial?.action_items) ? initial.action_items : []);
    }, [initial?.id, initial?.went_well, initial?.to_improve, initial?.summary, initial?.team_mood]);

    const save = async () => {
        setSaving(true); setSaved(false);
        try {
            const r = await updateSprintRetrospective(sprintId, {
                went_well: wentWell,
                to_improve: toImprove,
                summary,
                team_mood: teamMood,
                action_items: actionItems,
            });
            setSaved(true);
            onSaved && onSaved(r.data?.retrospective);
            setTimeout(() => setSaved(false), 1500);
        } catch { /* surface in UI later */ }
        finally { setSaving(false); }
    };

    const addAction = () => {
        if (!newActionText.trim()) return;
        setActionItems([
            ...actionItems,
            { id: Date.now(), text: newActionText.trim(), done: false, owner: null, due_date: null },
        ]);
        setNewActionText('');
    };

    const toggleAction = (id) => {
        setActionItems(actionItems.map(a => a.id === id ? { ...a, done: !a.done } : a));
    };

    const removeAction = (id) => {
        setActionItems(actionItems.filter(a => a.id !== id));
    };

    return (
        <div className={s.retro}>
            <div className={s.retroGrid}>
                <RetroColumn
                    label="What went well"
                    value={wentWell}
                    onChange={setWentWell}
                    placeholder="• Wins, smooth processes, kudos…"
                    accent="#10b981"
                />
                <RetroColumn
                    label="What to improve"
                    value={toImprove}
                    onChange={setToImprove}
                    placeholder="• Pain points, blockers, things to change…"
                    accent="#f59e0b"
                />
            </div>

            <div className={s.retroActions}>
                <h3 className={s.retroSubtitle}><ListChecks size={14} /> Action items</h3>
                <div className={s.actionList}>
                    {actionItems.length === 0 && <div className={s.empty}>No action items yet.</div>}
                    {actionItems.map(a => (
                        <label key={a.id} className={`${s.actionItem} ${a.done ? s.actionDone : ''}`}>
                            <input type="checkbox" checked={a.done} onChange={() => toggleAction(a.id)} />
                            <span>{a.text}</span>
                            <button
                                className={s.actionDelete}
                                onClick={(e) => { e.preventDefault(); removeAction(a.id); }}
                                title="Remove"
                            >
                                ×
                            </button>
                        </label>
                    ))}
                </div>
                <div className={s.actionAddRow}>
                    <input
                        type="text"
                        value={newActionText}
                        onChange={e => setNewActionText(e.target.value)}
                        onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addAction(); } }}
                        placeholder="New action item — press Enter to add"
                    />
                    <button className="btn btn-secondary btn-sm" onClick={addAction}>Add</button>
                </div>
            </div>

            <div className={s.retroFooter}>
                <div className={s.moodWrap}>
                    <span className={s.retroSubtitle}>Team mood</span>
                    {[1, 2, 3, 4, 5].map(n => (
                        <button
                            key={n}
                            className={`${s.moodBtn} ${teamMood === n ? s.moodActive : ''}`}
                            onClick={() => setTeamMood(teamMood === n ? null : n)}
                            type="button"
                            title={['Very low', 'Low', 'OK', 'Good', 'Great'][n - 1]}
                        >
                            {['😡', '😟', '😐', '🙂', '😄'][n - 1]}
                        </button>
                    ))}
                </div>
                <div style={{ flex: 1 }}>
                    <textarea
                        className={s.summaryInput}
                        value={summary}
                        onChange={e => setSummary(e.target.value)}
                        placeholder="Summary (optional)"
                        rows={2}
                    />
                </div>
                <button className="btn btn-primary" onClick={save} disabled={saving}>
                    {saving ? 'Saving…' : saved ? 'Saved ✓' : 'Save retrospective'}
                </button>
            </div>
        </div>
    );
}

function RetroColumn({ label, value, onChange, placeholder, accent }) {
    return (
        <div className={s.retroCol} style={{ '--accent': accent }}>
            <div className={s.retroColLabel}>{label}</div>
            <textarea
                className={s.retroColInput}
                value={value || ''}
                onChange={e => onChange(e.target.value)}
                placeholder={placeholder}
                rows={6}
            />
        </div>
    );
}
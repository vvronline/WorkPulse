import DOMPurify from 'dompurify';
import { Search, X, ClipboardList, FileText, Calendar, Palmtree, Rocket, User, ScrollText, ArrowRight } from 'lucide-react';
import { useGlobalSearch } from '../../hooks/useGlobalSearch';
import s from './GlobalSearch.module.css';

const LEAVE_STATUS_COLOR = { approved: '#16a34a', pending: '#d97706', rejected: '#dc2626', withdraw_pending: '#0284c7' };
const SPRINT_STATUS_COLOR = { active: '#16a34a', planned: '#2563eb', completed: '#6b7280' };
const ROLE_LABELS = {
    employee: 'Employee', team_lead: 'Team Lead', manager: 'Manager',
    hr_admin: 'HR Admin', super_admin: 'Super Admin',
};

export default function GlobalSearch({ onClose }) {
    const {
        query, results, loading, error,
        activeIdx, setActiveIdx,
        inputRef,
        navResults,
        sectionOffsets,
        handleChange, handleKeyDown,
        navigateToItem,
        hasResults,
    } = useGlobalSearch({ onClose });

    return (
        <div className={s.overlay} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
            <div className={s.modal} role="dialog" aria-label="Global search">
                <div className={s.inputRow}>
                    <span className={s.icon}><Search size={17} /></span>
                    <input
                        ref={inputRef}
                        className={s.input}
                        type="text"
                        value={query}
                        onChange={handleChange}
                        onKeyDown={handleKeyDown}
                        placeholder="Search or jump to any page, task, leave, event…"
                        autoComplete="off"
                        spellCheck={false}
                    />
                    {loading && <span className={s.spinner} aria-label="Searching" />}
                    <button className={s.closeBtn} onClick={onClose} aria-label="Close search"><X size={16} /></button>
                </div>

                {error && <p className={s.error}>{error}</p>}

                {!hasResults && !loading && query.trim().length >= 2 && (
                    <p className={s.hint}>No results for "{query}"</p>
                )}

                {hasResults && (
                    <div className={s.results}>

                        {/* ── Navigation / Pages ── */}
                        {navResults.length > 0 && (
                            <section>
                                <h4 className={s.sectionTitle}>Pages &amp; Features</h4>
                                {navResults.map((n, i) => {
                                    const idx = sectionOffsets.nav + i;
                                    return (
                                        <button
                                            key={`nav-${n.path}`}
                                            className={`${s.item} ${activeIdx === idx ? s.active : ''}`}
                                            onClick={() => navigateToItem({ type: 'nav', data: n })}
                                            onMouseEnter={() => setActiveIdx(idx)}
                                        >
                                            <span className={s.itemIcon}>{n.icon && <n.icon size={16} />}</span>
                                            <div className={s.itemBody}>
                                                <span className={s.itemTitle}>{n.title}</span>
                                                <span className={s.snippet}>{n.sub}</span>
                                            </div>
                                            <span className={s.badgeDefault} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.2rem' }}>Go <ArrowRight size={12} /></span>
                                        </button>
                                    );
                                })}
                            </section>
                        )}

                        {/* ── Tasks ── */}
                        {results?.tasks?.length > 0 && (
                            <section>
                                <h4 className={s.sectionTitle}>Tasks</h4>
                                {results.tasks.map((t, i) => {
                                    const idx = sectionOffsets.task + i;
                                    return (
                                        <button
                                            key={`task-${t.id}`}
                                            className={`${s.item} ${activeIdx === idx ? s.active : ''}`}
                                            onClick={() => navigateToItem({ type: 'task', data: t })}
                                            onMouseEnter={() => setActiveIdx(idx)}
                                        >
                                            <span className={s.itemIcon}><ClipboardList size={16} /></span>
                                            <div className={s.itemBody}>
                                                <span className={s.itemTitle}>{t.title}</span>
                                                {t.snippet && (
                                                    <span className={s.snippet} dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(t.snippet) }} />
                                                )}
                                            </div>
                                            <span className={`${s.badge} ${s[`status-${t.status}`] || s.badgeDefault}`}>
                                                {t.status?.replace(/_/g, ' ')}
                                            </span>
                                        </button>
                                    );
                                })}
                            </section>
                        )}

                        {/* ── Notes ── */}
                        {results?.notes?.length > 0 && (
                            <section>
                                <h4 className={s.sectionTitle}>Notes</h4>
                                {results.notes.map((n, i) => {
                                    const idx = sectionOffsets.note + i;
                                    return (
                                        <button
                                            key={`note-${n.id}`}
                                            className={`${s.item} ${activeIdx === idx ? s.active : ''}`}
                                            onClick={() => navigateToItem({ type: 'note', data: n })}
                                            onMouseEnter={() => setActiveIdx(idx)}
                                        >
                                            <span className={s.itemIcon}><FileText size={16} /></span>
                                            <div className={s.itemBody}>
                                                <span className={s.itemTitle}>{n.title}</span>
                                                {n.snippet && <span className={s.snippet}>{n.snippet}</span>}
                                            </div>
                                        </button>
                                    );
                                })}
                            </section>
                        )}

                        {/* ── Calendar Events ── */}
                        {results?.events?.length > 0 && (
                            <section>
                                <h4 className={s.sectionTitle}>Calendar Events</h4>
                                {results.events.map((e, i) => {
                                    const idx = sectionOffsets.event + i;
                                    const dateStr = e.all_day
                                        ? new Date(e.start_time).toLocaleDateString()
                                        : `${new Date(e.start_time).toLocaleDateString()} ${new Date(e.start_time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
                                    return (
                                        <button
                                            key={`event-${e.id}`}
                                            className={`${s.item} ${activeIdx === idx ? s.active : ''}`}
                                            onClick={() => navigateToItem({ type: 'event', data: e })}
                                            onMouseEnter={() => setActiveIdx(idx)}
                                        >
                                            <span className={s.itemIcon}><Calendar size={16} /></span>
                                            <div className={s.itemBody}>
                                                <span className={s.itemTitle}>{e.title}</span>
                                                <span className={s.snippet}>{dateStr}{e.description ? ` · ${e.description.slice(0, 60)}` : ''}</span>
                                            </div>
                                        </button>
                                    );
                                })}
                            </section>
                        )}

                        {/* ── Leaves ── */}
                        {results?.leaves?.length > 0 && (
                            <section>
                                <h4 className={s.sectionTitle}>Leave Requests</h4>
                                {results.leaves.map((l, i) => {
                                    const idx = sectionOffsets.leave + i;
                                    return (
                                        <button
                                            key={`leave-${l.id}`}
                                            className={`${s.item} ${activeIdx === idx ? s.active : ''}`}
                                            onClick={() => navigateToItem({ type: 'leave', data: l })}
                                            onMouseEnter={() => setActiveIdx(idx)}
                                        >
                                            <span className={s.itemIcon}><Palmtree size={16} /></span>
                                            <div className={s.itemBody}>
                                                <span className={s.itemTitle}>{l.leave_type.charAt(0).toUpperCase() + l.leave_type.slice(1)} leave — {l.date}</span>
                                                <span className={s.snippet}>{l.duration} day{l.reason ? ` · ${l.reason.slice(0, 60)}` : ''}</span>
                                            </div>
                                            <span className={s.badgeDefault} style={{ color: LEAVE_STATUS_COLOR[l.status] }}>{l.status}</span>
                                        </button>
                                    );
                                })}
                            </section>
                        )}

                        {/* ── Sprints ── */}
                        {results?.sprints?.length > 0 && (
                            <section>
                                <h4 className={s.sectionTitle}>Sprints</h4>
                                {results.sprints.map((sp, i) => {
                                    const idx = sectionOffsets.sprint + i;
                                    return (
                                        <button
                                            key={`sprint-${sp.id}`}
                                            className={`${s.item} ${activeIdx === idx ? s.active : ''}`}
                                            onClick={() => navigateToItem({ type: 'sprint', data: sp })}
                                            onMouseEnter={() => setActiveIdx(idx)}
                                        >
                                            <span className={s.itemIcon}><Rocket size={16} /></span>
                                            <div className={s.itemBody}>
                                                <span className={s.itemTitle}>{sp.name}</span>
                                                <span className={s.snippet}>{sp.start_date} → {sp.end_date}{sp.goal ? ` · ${sp.goal.slice(0, 60)}` : ''}</span>
                                            </div>
                                            <span className={s.badgeDefault} style={{ color: SPRINT_STATUS_COLOR[sp.status] }}>{sp.status}</span>
                                        </button>
                                    );
                                })}
                            </section>
                        )}

                        {/* ── People ── */}
                        {results?.users?.length > 0 && (
                            <section>
                                <h4 className={s.sectionTitle}>People</h4>
                                {results.users.map((u, i) => {
                                    const idx = sectionOffsets.user + i;
                                    return (
                                        <button
                                            key={`user-${u.id}`}
                                            className={`${s.item} ${activeIdx === idx ? s.active : ''}`}
                                            onClick={() => navigateToItem({ type: 'user', data: u })}
                                            onMouseEnter={() => setActiveIdx(idx)}
                                        >
                                            {u.avatar
                                                ? <img src={`/uploads/avatars/${u.avatar}`} alt="" className={s.avatar} />
                                                : <span className={s.itemIcon}><User size={16} /></span>
                                            }
                                            <div className={s.itemBody}>
                                                <span className={s.itemTitle}>{u.full_name}</span>
                                                <span className={s.snippet}>{u.email}</span>
                                            </div>
                                            <span className={s.badgeDefault}>{ROLE_LABELS[u.role] || u.role}</span>
                                        </button>
                                    );
                                })}
                            </section>
                        )}

                        {/* ── Audit Logs ── */}
                        {results?.logs?.length > 0 && (
                            <section>
                                <h4 className={s.sectionTitle}>Audit Logs</h4>
                                {results.logs.map((l, i) => {
                                    const idx = sectionOffsets.log + i;
                                    return (
                                        <button
                                            key={`log-${l.id}`}
                                            className={`${s.item} ${activeIdx === idx ? s.active : ''}`}
                                            onClick={() => navigateToItem({ type: 'log', data: l })}
                                            onMouseEnter={() => setActiveIdx(idx)}
                                        >
                                            <span className={s.itemIcon}><ScrollText size={16} /></span>
                                            <div className={s.itemBody}>
                                                <span className={s.itemTitle}>{l.action} — {l.entity_type}</span>
                                                <span className={s.snippet}>
                                                    {l.actor_name && `by ${l.actor_name} · `}
                                                    {new Date(l.created_at).toLocaleDateString()}
                                                </span>
                                            </div>
                                        </button>
                                    );
                                })}
                            </section>
                        )}
                    </div>
                )}

                <div className={s.footer}>
                    <span>↑↓ navigate</span>
                    <span>Enter select</span>
                    <span>Esc close</span>
                </div>
            </div>
        </div>
    );
}

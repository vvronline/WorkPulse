/* LinkedEntitiesPanel — side-rail showing tasks, meetings, and calendar
   events linked to the active note page. Supports search + link/unlink. */
import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
    getNoteLinks, addNoteLink, removeNoteLink,
    searchNoteTasks, searchNoteMeetings, searchNoteEvents,
} from '../../../api';
import {
    CheckSquare, Calendar, Video, Plus, X, Search, Link2, Unlink,
    ChevronDown, ChevronRight, ExternalLink,
} from 'lucide-react';
import s from './LinkedEntitiesPanel.module.css';

const STATUS_COLORS = {
    pending: '#94a3b8', in_progress: '#3b82f6', in_review: '#f59e0b', done: '#10b981',
};
const PRIORITY_ICONS = { low: '↓', medium: '—', high: '↑' };

function TaskChip({ task }) {
    return (
        <div className={s.entityChip}>
            <CheckSquare size={12} />
            <span className={s.entityTitle}>{task.title}</span>
            <span className={s.statusDot} style={{ background: STATUS_COLORS[task.status] || '#94a3b8' }}
                title={task.status} />
            <span className={s.priorityTag}>{PRIORITY_ICONS[task.priority] || ''}</span>
        </div>
    );
}

function EventChip({ event }) {
    const time = event.start_time
        ? new Date(event.start_time).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
        : '';
    return (
        <div className={s.entityChip}>
            <Calendar size={12} />
            <span className={s.entityTitle}>{event.title}</span>
            {time && <span className={s.entityMeta}>{time}</span>}
        </div>
    );
}

function MeetingChip({ meeting }) {
    const time = meeting.scheduled_start
        ? new Date(meeting.scheduled_start).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
        : '';
    return (
        <div className={s.entityChip}>
            <Video size={12} />
            <span className={s.entityTitle}>{meeting.title}</span>
            {time && <span className={s.entityMeta}>{time}</span>}
        </div>
    );
}

export default function LinkedEntitiesPanel({ pageId, onNavigateTask }) {
    const [links, setLinks] = useState([]);
    const [loading, setLoading] = useState(false);
    const [adding, setAdding] = useState(null); // 'task' | 'calendar_event' | 'meeting' | null
    const [searchQ, setSearchQ] = useState('');
    const [searchResults, setSearchResults] = useState([]);
    const [searching, setSearching] = useState(false);
    const [expanded, setExpanded] = useState(true);
    const [ctxMenu, setCtxMenu] = useState(null); // { x, y, entityType, entityId }
    const debounceRef = useRef(null);
    const panelRef = useRef(null);

    // Close context menu on outside click or scroll
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

    const fetchLinks = useCallback(async () => {
        if (!pageId) return;
        setLoading(true);
        try {
            const res = await getNoteLinks(pageId);
            setLinks(res.data?.links || []);
        } catch { /* ignore */ }
        setLoading(false);
    }, [pageId]);

    useEffect(() => { fetchLinks(); }, [fetchLinks]);

    const handleAdd = async (entityType, entityId) => {
        try {
            await addNoteLink(pageId, entityType, entityId);
            setAdding(null);
            setSearchQ('');
            setSearchResults([]);
            fetchLinks();
        } catch { /* ignore */ }
    };

    const handleRemove = async (entityType, entityId) => {
        try {
            await removeNoteLink(pageId, entityType, entityId);
            setLinks(prev => prev.filter(l => !(l.entity_type === entityType && l.entity_id === entityId)));
        } catch { /* ignore */ }
    };

    // Search when adding — also load recent items on empty query
    useEffect(() => {
        if (!adding) { setSearchResults([]); return; }
        clearTimeout(debounceRef.current);
        debounceRef.current = setTimeout(async () => {
            setSearching(true);
            try {
                let res;
                const q = searchQ.trim() || '';
                if (adding === 'task') res = await searchNoteTasks(q);
                else if (adding === 'meeting') res = await searchNoteMeetings(q);
                else res = await searchNoteEvents(q);
                const key = adding === 'task' ? 'tasks' : adding === 'meeting' ? 'meetings' : 'events';
                setSearchResults(res.data?.[key] || []);
            } catch { setSearchResults([]); }
            setSearching(false);
        }, searchQ ? 300 : 0);
        return () => clearTimeout(debounceRef.current);
    }, [adding, searchQ]);

    const taskLinks = links.filter(l => l.entity_type === 'task' && l.detail);
    const eventLinks = links.filter(l => l.entity_type === 'calendar_event' && l.detail);
    const meetingLinks = links.filter(l => l.entity_type === 'meeting' && l.detail);
    const hasLinks = taskLinks.length > 0 || eventLinks.length > 0 || meetingLinks.length > 0;

    const handleContextMenu = (e, entityType, entityId) => {
        e.preventDefault();
        const rect = panelRef.current?.getBoundingClientRect() || { left: 0, top: 0 };
        setCtxMenu({ x: e.clientX - rect.left, y: e.clientY - rect.top, entityType, entityId });
    };

    if (!pageId) return null;

    return (
        <div className={s.panel} ref={panelRef}>
            <button className={s.header} onClick={() => setExpanded(e => !e)}>
                {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                <Link2 size={12} />
                <span>Linked items</span>
                {hasLinks && <span className={s.badge}>{links.filter(l => l.detail).length}</span>}
            </button>

            {expanded && (
                <div className={s.body}>
                    {loading && <div className={s.loading}>Loading…</div>}

                    {/* Linked tasks */}
                    {taskLinks.length > 0 && (
                        <div className={s.section}>
                            <div className={s.sectionLabel}><CheckSquare size={11} /> Tasks</div>
                            {taskLinks.map(l => (
                                <div key={l.id} className={s.linkRow}
                                    onContextMenu={e => handleContextMenu(e, 'task', l.entity_id)}>
                                    <TaskChip task={l.detail} />
                                    <button className={s.unlinkBtn} onClick={() => handleRemove('task', l.entity_id)}
                                        title="Unlink"><X size={10} /></button>
                                </div>
                            ))}
                        </div>
                    )}

                    {/* Linked events */}
                    {eventLinks.length > 0 && (
                        <div className={s.section}>
                            <div className={s.sectionLabel}><Calendar size={11} /> Events</div>
                            {eventLinks.map(l => (
                                <div key={l.id} className={s.linkRow}
                                    onContextMenu={e => handleContextMenu(e, 'calendar_event', l.entity_id)}>
                                    <EventChip event={l.detail} />
                                    <button className={s.unlinkBtn} onClick={() => handleRemove('calendar_event', l.entity_id)}
                                        title="Unlink"><X size={10} /></button>
                                </div>
                            ))}
                        </div>
                    )}

                    {/* Linked meetings */}
                    {meetingLinks.length > 0 && (
                        <div className={s.section}>
                            <div className={s.sectionLabel}><Video size={11} /> Meetings</div>
                            {meetingLinks.map(l => (
                                <div key={l.id} className={s.linkRow}
                                    onContextMenu={e => handleContextMenu(e, 'meeting', l.entity_id)}>
                                    <MeetingChip meeting={l.detail} />
                                    <button className={s.unlinkBtn} onClick={() => handleRemove('meeting', l.entity_id)}
                                        title="Unlink"><X size={10} /></button>
                                </div>
                            ))}
                        </div>
                    )}

                    {/* Right-click context menu */}
                    {ctxMenu && (
                        <div className={s.ctxMenu} style={{ top: ctxMenu.y, left: ctxMenu.x }}>
                            <button className={s.ctxMenuItem} onClick={() => {
                                handleRemove(ctxMenu.entityType, ctxMenu.entityId);
                                setCtxMenu(null);
                            }}>
                                <Unlink size={12} /> Remove link
                            </button>
                        </div>
                    )}

                    {!loading && !hasLinks && !adding && (
                        <div className={s.empty}>No linked items yet</div>
                    )}

                    {/* Add entity UI */}
                    {adding ? (
                        <div className={s.addPanel}>
                            <div className={s.addHeader}>
                                <span>Link {adding === 'calendar_event' ? 'event' : adding}</span>
                                <button className={s.closeBtn} onClick={() => { setAdding(null); setSearchQ(''); setSearchResults([]); }}>
                                    <X size={12} /></button>
                            </div>
                            <div className={s.searchWrap}>
                                <Search size={12} />
                                <input
                                    className={s.searchInput}
                                    value={searchQ}
                                    onChange={e => setSearchQ(e.target.value)}
                                    placeholder={`Search ${adding === 'calendar_event' ? 'events' : adding + 's'}…`}
                                    autoFocus
                                />
                            </div>
                            <div className={s.results}>
                                {searching && <div className={s.loading}>Searching…</div>}
                                {searchResults.map(r => {
                                    const alreadyLinked = links.some(l => l.entity_type === adding && l.entity_id === r.id);
                                    return (
                                        <button key={r.id} className={s.resultItem}
                                            onClick={() => !alreadyLinked && handleAdd(adding, r.id)}
                                            disabled={alreadyLinked}
                                        >
                                            {adding === 'task' ? <TaskChip task={r} /> :
                                             adding === 'meeting' ? <MeetingChip meeting={r} /> :
                                             <EventChip event={r} />}
                                            {alreadyLinked && <span className={s.linked}>Linked</span>}
                                        </button>
                                    );
                                })}
                                {!searching && searchResults.length === 0 && (
                                    <div className={s.empty}>No results</div>
                                )}
                            </div>
                        </div>
                    ) : (
                        <div className={s.addButtons}>
                            <button className={s.addBtn} onClick={() => setAdding('task')}>
                                <Plus size={10} /> <CheckSquare size={10} /> Task
                            </button>
                            <button className={s.addBtn} onClick={() => setAdding('calendar_event')}>
                                <Plus size={10} /> <Calendar size={10} /> Event
                            </button>
                            <button className={s.addBtn} onClick={() => setAdding('meeting')}>
                                <Plus size={10} /> <Video size={10} /> Meeting
                            </button>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}

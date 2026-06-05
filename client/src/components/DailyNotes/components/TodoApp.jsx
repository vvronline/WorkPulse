/* ─────────────────────────────────────────────────────────
   TodoApp — a modern, standalone to-do list rendered inside
   the Notes home canvas (sidebar → Todo, under Archive).
   Todos are persisted per-user inside the notebook blob via
   the store handlers. Pure presentation + interaction here.
   ───────────────────────────────────────────────────────── */
import React, { useMemo, useRef, useState, useEffect } from 'react';
import {
    Plus,
    Check,
    X,
    Trash2,
    Calendar,
    Circle,
    CheckCircle2,
    Pencil,
    ChevronLeft,
    ChevronRight,
} from '../../../constants/icons';
import s from './TodoApp.module.css';

const FILTERS = [
    { id: 'all', label: 'All' },
    { id: 'active', label: 'Active' },
    { id: 'completed', label: 'Completed' },
];

const PRIORITIES = [
    { id: 'high', label: 'High' },
    { id: 'medium', label: 'Medium' },
    { id: 'low', label: 'Low' },
];

function formatDue(iso) {
    if (!iso) return '';
    const d = new Date(iso + 'T00:00:00');
    if (Number.isNaN(d.getTime())) return '';
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const diffDays = Math.round((d - today) / 86400000);
    if (diffDays === 0) return 'Today';
    if (diffDays === 1) return 'Tomorrow';
    if (diffDays === -1) return 'Yesterday';
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function isOverdue(iso) {
    if (!iso) return false;
    const d = new Date(iso + 'T00:00:00');
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return d < today;
}

/** Local calendar-day key (YYYY-MM-DD) for a timestamp. */
function dayKey(iso) {
    const d = iso ? new Date(iso) : new Date();
    if (Number.isNaN(d.getTime())) return todayKey();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

function todayKey() {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

/** Human label for a day key relative to today. */
function dayLabel(key) {
    const tk = todayKey();
    if (key === tk) return 'Today';
    const d = new Date(key + 'T00:00:00');
    const today = new Date(tk + 'T00:00:00');
    const diff = Math.round((today - d) / 86400000);
    if (diff === 1) return 'Yesterday';
    return d.toLocaleDateString(undefined, {
        weekday: 'short', month: 'short', day: 'numeric',
        year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric',
    });
}

function GripDots() {
    return (
        <span className={s.grip} aria-hidden="true">
            <span /><span /><span />
            <span /><span /><span />
        </span>
    );
}

function TodoRow({
    todo, onToggle, onEdit, onDelete, onPriority, onDue,
    isDragging, onDragStart, onDragEnter, onDragEnd, onDrop,
}) {
    const [editing, setEditing] = useState(false);
    const [draft, setDraft] = useState(todo.text);

    const commit = () => {
        setEditing(false);
        if (draft.trim() !== todo.text) onEdit(todo.id, draft);
    };

    return (
        <li
            className={`${s.row} ${todo.done ? s.rowDone : ''} ${isDragging ? s.rowDragging : ''}`}
            draggable={!editing}
            onDragStart={() => onDragStart(todo.id)}
            onDragEnter={() => onDragEnter(todo.id)}
            onDragOver={(e) => e.preventDefault()}
            onDrop={() => onDrop(todo.id)}
            onDragEnd={onDragEnd}
            data-priority={todo.priority || 'none'}
        >
            <GripDots />

            <button
                type="button"
                className={s.check}
                onClick={() => onToggle(todo.id)}
                aria-label={todo.done ? 'Mark as not done' : 'Mark as done'}
            >
                {todo.done ? <CheckCircle2 size={20} /> : <Circle size={20} />}
            </button>

            <div className={s.rowBody}>
                {editing ? (
                    <input
                        className={s.editInput}
                        value={draft}
                        autoFocus
                        onChange={(e) => setDraft(e.target.value)}
                        onBlur={commit}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter') commit();
                            if (e.key === 'Escape') { setDraft(todo.text); setEditing(false); }
                        }}
                    />
                ) : (
                    <span
                        className={s.text}
                        onDoubleClick={() => { setDraft(todo.text); setEditing(true); }}
                        title="Double-click to edit"
                    >
                        {todo.text}
                    </span>
                )}

                <div className={s.meta}>
                    {todo.dueDate && (
                        <span className={`${s.due} ${!todo.done && isOverdue(todo.dueDate) ? s.dueOverdue : ''}`}>
                            <Calendar size={12} />
                            {formatDue(todo.dueDate)}
                        </span>
                    )}
                </div>
            </div>

            <div className={s.rowActions}>
                <div className={s.priorityGroup} role="group" aria-label="Priority">
                    {PRIORITIES.map(p => (
                        <button
                            key={p.id}
                            type="button"
                            className={`${s.prioDot} ${s['prio_' + p.id]} ${todo.priority === p.id ? s.prioActive : ''}`}
                            onClick={() => onPriority(todo.id, p.id)}
                            title={`${p.label} priority`}
                            aria-label={`${p.label} priority`}
                        />
                    ))}
                </div>

                <label className={s.dueBtn} title="Set due date">
                    <Calendar size={15} />
                    <input
                        type="date"
                        className={s.dateInput}
                        value={todo.dueDate || ''}
                        onChange={(e) => onDue(todo.id, e.target.value)}
                    />
                </label>

                <button
                    type="button"
                    className={s.iconBtn}
                    onClick={() => { setDraft(todo.text); setEditing(true); }}
                    title="Edit"
                    aria-label="Edit task"
                >
                    <Pencil size={15} />
                </button>

                <button
                    type="button"
                    className={`${s.iconBtn} ${s.iconBtnDanger}`}
                    onClick={() => onDelete(todo.id)}
                    title="Delete"
                    aria-label="Delete task"
                >
                    <Trash2 size={15} />
                </button>
            </div>
        </li>
    );
}

export default function TodoApp({ store }) {
    const {
        todos = [],
        handleAddTodo, handleToggleTodo, handleEditTodo, handleDeleteTodo,
        handleSetTodoPriority, handleSetTodoDue, handleReorderTodos, handleClearCompletedTodos,
    } = store;

    const [input, setInput] = useState('');
    const [filter, setFilter] = useState('all');
    const [pageIdx, setPageIdx] = useState(0);
    const dragId = useRef(null);
    const overId = useRef(null);
    const [draggingId, setDraggingId] = useState(null);

    const ordered = useMemo(
        () => [...todos].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0)),
        [todos]
    );

    // Build one "page" per calendar day (newest first). Today is always
    // page 1, even when it has no todos yet.
    const days = useMemo(() => {
        const groups = new Map();
        ordered.forEach(t => {
            const key = dayKey(t.createdAt);
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(t);
        });
        const tk = todayKey();
        if (!groups.has(tk)) groups.set(tk, []);
        return [...groups.keys()]
            .sort((a, b) => (a < b ? 1 : a > b ? -1 : 0))
            .map(key => ({ key, label: dayLabel(key), items: groups.get(key) }));
    }, [ordered]);

    // Clamp the active page when the number of days changes.
    useEffect(() => {
        if (pageIdx > days.length - 1) setPageIdx(Math.max(0, days.length - 1));
    }, [days.length, pageIdx]);

    const currentDay = days[Math.min(pageIdx, days.length - 1)] || { key: todayKey(), label: 'Today', items: [] };
    const dayItems = currentDay.items;

    const counts = useMemo(() => {
        const total = dayItems.length;
        const done = dayItems.filter(t => t.done).length;
        return { total, done, active: total - done };
    }, [dayItems]);

    const visible = useMemo(() => {
        if (filter === 'active') return dayItems.filter(t => !t.done);
        if (filter === 'completed') return dayItems.filter(t => t.done);
        return dayItems;
    }, [dayItems, filter]);

    const progress = counts.total ? Math.round((counts.done / counts.total) * 100) : 0;
    const isToday = currentDay.key === todayKey();

    const submit = (e) => {
        e.preventDefault();
        const v = input.trim();
        if (!v) return;
        handleAddTodo(v);
        setInput('');
        setPageIdx(0); // new todos land on today's page
    };

    const onDrop = (targetId) => {
        const from = dragId.current;
        if (from && targetId && from !== targetId) {
            handleReorderTodos(from, targetId);
        }
        dragId.current = null;
        overId.current = null;
        setDraggingId(null);
    };

    return (
        <div className={s.wrap}>
            <header className={s.header}>
                <div className={s.headerTop}>
                    <div>
                        <h1 className={s.title}>To-do</h1>
                        <p className={s.subtitle}>
                            {counts.total === 0
                                ? (isToday ? 'Capture what needs doing' : 'No tasks on this day')
                                : `${counts.active} active · ${counts.done} done`}
                        </p>
                    </div>
                    <div className={s.progressRing} style={{ '--p': progress }}>
                        <span>{progress}%</span>
                    </div>
                </div>

                {days.length > 1 && (
                    <div className={s.pager}>
                        <button
                            type="button"
                            className={s.pagerBtn}
                            onClick={() => setPageIdx(i => Math.min(days.length - 1, i + 1))}
                            disabled={pageIdx >= days.length - 1}
                            aria-label="Older day"
                            title="Older"
                        >
                            <ChevronLeft size={16} />
                        </button>
                        <span className={s.pagerLabel}>
                            <Calendar size={13} />
                            {currentDay.label}
                            <span className={s.pagerCount}>{pageIdx + 1}/{days.length}</span>
                        </span>
                        <button
                            type="button"
                            className={s.pagerBtn}
                            onClick={() => setPageIdx(i => Math.max(0, i - 1))}
                            disabled={pageIdx <= 0}
                            aria-label="Newer day"
                            title="Newer"
                        >
                            <ChevronRight size={16} />
                        </button>
                    </div>
                )}

                {isToday && (
                    <form className={s.addForm} onSubmit={submit}>
                        <Plus size={18} className={s.addIcon} />
                        <input
                            className={s.addInput}
                            placeholder="Add a task and press Enter…"
                            value={input}
                            onChange={(e) => setInput(e.target.value)}
                        />
                        {input.trim() && (
                            <button type="submit" className={s.addBtn}>
                                <Check size={16} /> Add
                            </button>
                        )}
                    </form>
                )}

                <div className={s.toolbar}>
                    <div className={s.filters} role="tablist">
                        {FILTERS.map(f => (
                            <button
                                key={f.id}
                                type="button"
                                role="tab"
                                aria-selected={filter === f.id}
                                className={`${s.filterTab} ${filter === f.id ? s.filterActive : ''}`}
                                onClick={() => setFilter(f.id)}
                            >
                                {f.label}
                                {f.id === 'active' && counts.active > 0 && (
                                    <span className={s.tabCount}>{counts.active}</span>
                                )}
                                {f.id === 'completed' && counts.done > 0 && (
                                    <span className={s.tabCount}>{counts.done}</span>
                                )}
                            </button>
                        ))}
                    </div>
                    {counts.done > 0 && (
                        <button
                            type="button"
                            className={s.clearBtn}
                            onClick={handleClearCompletedTodos}
                        >
                            <X size={14} /> Clear completed
                        </button>
                    )}
                </div>
            </header>

            <div className={s.listArea}>
                {visible.length === 0 ? (
                    <div className={s.empty}>
                        <div className={s.emptyIcon}><CheckCircle2 size={34} /></div>
                        <p className={s.emptyTitle}>
                            {filter === 'completed'
                                ? 'Nothing completed yet'
                                : filter === 'active'
                                    ? 'No active tasks — you’re all caught up!'
                                    : 'Your list is empty'}
                        </p>
                        <p className={s.emptyHint}>
                            {filter === 'all' && isToday && 'Add your first task above to get started.'}
                        </p>
                    </div>
                ) : (
                    <ul className={s.list}>
                        {visible.map(todo => (
                            <TodoRow
                                key={todo.id}
                                todo={todo}
                                onToggle={handleToggleTodo}
                                onEdit={handleEditTodo}
                                onDelete={handleDeleteTodo}
                                onPriority={handleSetTodoPriority}
                                onDue={handleSetTodoDue}
                                isDragging={draggingId === todo.id}
                                onDragStart={(id) => { dragId.current = id; setDraggingId(id); }}
                                onDragEnter={(id) => { overId.current = id; }}
                                onDragEnd={() => { dragId.current = null; setDraggingId(null); }}
                                onDrop={onDrop}
                            />
                        ))}
                    </ul>
                )}
            </div>
        </div>
    );
}

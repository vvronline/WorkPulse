import { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { globalSearch } from '../api';
import s from './GlobalSearch.module.css';

const ROLE_LABELS = {
    employee: 'Employee', team_lead: 'Team Lead', manager: 'Manager',
    hr_admin: 'HR Admin', super_admin: 'Super Admin',
};

export default function GlobalSearch({ onClose }) {
    const [query, setQuery] = useState('');
    const [results, setResults] = useState(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');
    const [activeIdx, setActiveIdx] = useState(-1);
    const inputRef = useRef(null);
    const navigate = useNavigate();
    const debounceRef = useRef(null);

    // Focus the input when the modal opens
    useEffect(() => {
        inputRef.current?.focus();
    }, []);

    // Close on Escape
    useEffect(() => {
        const handle = (e) => { if (e.key === 'Escape') onClose(); };
        window.addEventListener('keydown', handle);
        return () => window.removeEventListener('keydown', handle);
    }, [onClose]);

    const doSearch = useCallback(async (q) => {
        if (q.trim().length < 2) { setResults(null); setError(''); return; }
        setLoading(true);
        setError('');
        try {
            const res = await globalSearch(q.trim());
            setResults(res.data);
            setActiveIdx(-1);
        } catch {
            setError('Search failed. Please try again.');
            setResults(null);
        } finally {
            setLoading(false);
        }
    }, []);

    const handleChange = (e) => {
        const val = e.target.value;
        setQuery(val);
        clearTimeout(debounceRef.current);
        debounceRef.current = setTimeout(() => doSearch(val), 350);
    };

    // Flatten results for keyboard navigation
    const flatItems = results ? [
        ...(results.tasks || []).map(t => ({ type: 'task', data: t })),
        ...(results.notes || []).map(n => ({ type: 'note', data: n })),
        ...(results.users || []).map(u => ({ type: 'user', data: u })),
        ...(results.logs || []).map(l => ({ type: 'log', data: l })),
    ] : [];

    const handleKeyDown = (e) => {
        if (!flatItems.length) return;
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            setActiveIdx(i => Math.min(i + 1, flatItems.length - 1));
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActiveIdx(i => Math.max(i - 1, 0));
        } else if (e.key === 'Enter' && activeIdx >= 0) {
            e.preventDefault();
            navigateToItem(flatItems[activeIdx]);
        }
    };

    const navigateToItem = ({ type, data }) => {
        onClose();
        if (type === 'task') {
            navigate(`/tasks?taskId=${data.id}`);
        } else if (type === 'note') {
            navigate(`/notes?pageId=${data.id}`);
        } else if (type === 'user') {
            navigate(`/admin?tab=users&userId=${data.id}`);
        } else if (type === 'log') {
            navigate(`/admin?tab=audit`);
        }
    };

    const hasResults = results && (
        results.tasks?.length || results.notes?.length ||
        results.users?.length || results.logs?.length
    );

    let flatIdx = 0;

    return (
        <div className={s.overlay} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
            <div className={s.modal} role="dialog" aria-label="Global search">
                <div className={s.inputRow}>
                    <span className={s.icon}>🔍</span>
                    <input
                        ref={inputRef}
                        className={s.input}
                        type="text"
                        value={query}
                        onChange={handleChange}
                        onKeyDown={handleKeyDown}
                        placeholder="Search tasks, notes, people…"
                        autoComplete="off"
                        spellCheck={false}
                    />
                    {loading && <span className={s.spinner} aria-label="Searching" />}
                    <button className={s.closeBtn} onClick={onClose} aria-label="Close search">✕</button>
                </div>

                {error && <p className={s.error}>{error}</p>}

                {!results && !loading && query.trim().length < 2 && (
                    <p className={s.hint}>Type at least 2 characters to search</p>
                )}

                {results && !hasResults && (
                    <p className={s.hint}>No results for "{query}"</p>
                )}

                {hasResults && (
                    <div className={s.results}>
                        {results.tasks?.length > 0 && (
                            <section>
                                <h4 className={s.sectionTitle}>Tasks</h4>
                                {results.tasks.map((t) => {
                                    const idx = flatIdx++;
                                    return (
                                        <button
                                            key={`task-${t.id}`}
                                            className={`${s.item} ${activeIdx === idx ? s.active : ''}`}
                                            onClick={() => navigateToItem({ type: 'task', data: t })}
                                            onMouseEnter={() => setActiveIdx(idx)}
                                        >
                                            <span className={s.itemIcon}>📋</span>
                                            <div className={s.itemBody}>
                                                <span className={s.itemTitle}>{t.title}</span>
                                                {t.snippet && (
                                                    <span
                                                        className={s.snippet}
                                                        dangerouslySetInnerHTML={{ __html: t.snippet }}
                                                    />
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

                        {results.notes?.length > 0 && (
                            <section>
                                <h4 className={s.sectionTitle}>Notes</h4>
                                {results.notes.map((n) => {
                                    const idx = flatIdx++;
                                    return (
                                        <button
                                            key={`note-${n.id}`}
                                            className={`${s.item} ${activeIdx === idx ? s.active : ''}`}
                                            onClick={() => navigateToItem({ type: 'note', data: n })}
                                            onMouseEnter={() => setActiveIdx(idx)}
                                        >
                                            <span className={s.itemIcon}>📝</span>
                                            <div className={s.itemBody}>
                                                <span className={s.itemTitle}>{n.title}</span>
                                                {n.snippet && <span className={s.snippet}>{n.snippet}</span>}
                                            </div>
                                        </button>
                                    );
                                })}
                            </section>
                        )}

                        {results.users?.length > 0 && (
                            <section>
                                <h4 className={s.sectionTitle}>People</h4>
                                {results.users.map((u) => {
                                    const idx = flatIdx++;
                                    return (
                                        <button
                                            key={`user-${u.id}`}
                                            className={`${s.item} ${activeIdx === idx ? s.active : ''}`}
                                            onClick={() => navigateToItem({ type: 'user', data: u })}
                                            onMouseEnter={() => setActiveIdx(idx)}
                                        >
                                            {u.avatar
                                                ? <img src={`/uploads/avatars/${u.avatar}`} alt="" className={s.avatar} />
                                                : <span className={s.itemIcon}>👤</span>
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

                        {results.logs?.length > 0 && (
                            <section>
                                <h4 className={s.sectionTitle}>Audit Logs</h4>
                                {results.logs.map((l) => {
                                    const idx = flatIdx++;
                                    return (
                                        <button
                                            key={`log-${l.id}`}
                                            className={`${s.item} ${activeIdx === idx ? s.active : ''}`}
                                            onClick={() => navigateToItem({ type: 'log', data: l })}
                                            onMouseEnter={() => setActiveIdx(idx)}
                                        >
                                            <span className={s.itemIcon}>📜</span>
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

/**
 * AcceptanceCriteria — small inline checklist editor for a task's
 * `acceptance_criteria` JSONB field.
 *
 * Behaviours:
 *   - Loads on demand (only when the task detail panel is open).
 *   - Optimistic toggle: clicking a checkbox updates locally first then
 *     PUTs the whole list. The whole-list PUT keeps the server logic simple.
 *   - Add / remove / inline-edit text.
 *
 * Props:
 *   - taskId          : number
 *   - canEdit         : bool — disables interactions if false
 *   - onProgress?     : ({ done, total }) => void   optional rollup hook
 */
import React, { useEffect, useState, useCallback } from 'react';
import { Plus, X, CheckSquare, Square } from 'lucide-react';
import { getAcceptanceCriteria, updateAcceptanceCriteria } from '../../api';
import { useAgileConfig } from '../../AgileConfigContext';
import s from './AcceptanceCriteria.module.css';

export default function AcceptanceCriteria({ taskId, canEdit = true, onProgress }) {
    const { features } = useAgileConfig();
    const [items, setItems] = useState([]);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [adding, setAdding] = useState('');
    const [error, setError] = useState('');

    useEffect(() => {
        if (!taskId) return;
        let cancelled = false;
        setLoading(true);
        getAcceptanceCriteria(taskId)
            .then(r => { if (!cancelled) setItems(r.data.criteria || []); })
            .catch(() => { if (!cancelled) setItems([]); })
            .finally(() => { if (!cancelled) setLoading(false); });
        return () => { cancelled = true; };
    }, [taskId]);

    // Notify parent of progress whenever items change
    useEffect(() => {
        if (onProgress) {
            const done = items.filter(i => i.done).length;
            onProgress({ done, total: items.length });
        }
    }, [items, onProgress]);

    const persist = useCallback(async (next) => {
        setSaving(true); setError('');
        try {
            const r = await updateAcceptanceCriteria(taskId, next);
            setItems(r.data.criteria || []);
        } catch (e) {
            setError(e?.response?.data?.error || 'Failed to save');
        } finally { setSaving(false); }
    }, [taskId]);

    const toggle = (idx) => {
        if (!canEdit) return;
        const next = items.map((it, i) => i === idx ? { ...it, done: !it.done } : it);
        setItems(next);
        persist(next);
    };

    const remove = (idx) => {
        if (!canEdit) return;
        const next = items.filter((_, i) => i !== idx);
        setItems(next);
        persist(next);
    };

    const editText = (idx, text) => {
        const next = items.map((it, i) => i === idx ? { ...it, text } : it);
        setItems(next);
    };

    const blurSave = (idx) => {
        if (!canEdit) return;
        if (!items[idx]?.text?.trim()) {
            remove(idx);
        } else {
            persist(items);
        }
    };

    const submitAdd = (e) => {
        e.preventDefault();
        if (!canEdit) return;
        const text = adding.trim();
        if (!text) return;
        const next = [...items, { text, done: false }];
        setItems(next);
        setAdding('');
        persist(next);
    };

    if (!features.acceptanceCriteria) return null;

    const done = items.filter(i => i.done).length;
    const pct = items.length ? Math.round((done / items.length) * 100) : 0;

    return (
        <div className={s.wrap}>
            <div className={s.header}>
                <div className={s.title}>
                    Acceptance Criteria
                    {items.length > 0 && (
                        <span className={s.progress}>
                            {done}/{items.length} ({pct}%)
                        </span>
                    )}
                    {saving && <span className={s.saving}>Saving…</span>}
                </div>
            </div>
            {items.length > 0 && (
                <div className={s.bar}>
                    <div className={s.barFill} style={{ width: `${pct}%` }} />
                </div>
            )}
            {loading ? (
                <div className={s.loading}>Loading…</div>
            ) : (
                <ul className={s.list}>
                    {items.map((it, idx) => (
                        <li key={it.id || idx} className={`${s.item} ${it.done ? s.done : ''}`}>
                            <button
                                type="button"
                                className={s.checkBtn}
                                onClick={() => toggle(idx)}
                                disabled={!canEdit || saving}
                                aria-label={it.done ? 'Mark incomplete' : 'Mark complete'}
                            >
                                {it.done ? <CheckSquare size={15} /> : <Square size={15} />}
                            </button>
                            <input
                                className={s.text}
                                value={it.text}
                                onChange={e => editText(idx, e.target.value)}
                                onBlur={() => blurSave(idx)}
                                disabled={!canEdit}
                            />
                            {canEdit && (
                                <button
                                    type="button"
                                    className={s.removeBtn}
                                    onClick={() => remove(idx)}
                                    aria-label="Remove criterion"
                                >
                                    <X size={13} />
                                </button>
                            )}
                        </li>
                    ))}
                </ul>
            )}
            {canEdit && (
                <form className={s.addRow} onSubmit={submitAdd}>
                    <Plus size={13} className={s.addIcon} />
                    <input
                        className={s.addInput}
                        placeholder="Add a criterion and press Enter…"
                        value={adding}
                        onChange={e => setAdding(e.target.value)}
                        maxLength={500}
                    />
                </form>
            )}
            {error && <div className={s.error}>{error}</div>}
        </div>
    );
}
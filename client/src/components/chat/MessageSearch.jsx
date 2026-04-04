import { useState, useCallback, useRef } from 'react';
import { X } from 'lucide-react';
import { searchMessages as apiSearch } from '../../api';
import s from './MessageSearch.module.css';

export default function MessageSearch({ convId, onJumpTo, onClose }) {
    const [query, setQuery] = useState('');
    const [results, setResults] = useState([]);
    const [loading, setLoading] = useState(false);
    const timer = useRef(null);

    const doSearch = useCallback(async (q) => {
        if (!q || q.trim().length < 2) { setResults([]); return; }
        setLoading(true);
        try {
            const { data } = await apiSearch(q, convId);
            setResults(data);
        } catch { setResults([]); }
        setLoading(false);
    }, [convId]);

    const onChange = (e) => {
        const v = e.target.value;
        setQuery(v);
        clearTimeout(timer.current);
        timer.current = setTimeout(() => doSearch(v), 400);
    };

    return (
        <div className={s.overlay} onClick={(e) => e.target === e.currentTarget && onClose()}>
            <div className={s.modal}>
                <div className={s.header}>
                    <h3>Search Messages</h3>
                    <button className={s.closeBtn} onClick={onClose}><X size={16} /></button>
                </div>
                <input
                    className={s.input}
                    placeholder="Search..."
                    value={query}
                    onChange={onChange}
                    autoFocus
                />
                <div className={s.results}>
                    {loading && <div className={s.loading}>Searching...</div>}
                    {!loading && results.length === 0 && query.length >= 2 && (
                        <div className={s.empty}>No results found</div>
                    )}
                    {results.map(r => (
                        <button
                            key={r.id}
                            className={s.result}
                            onClick={() => { onJumpTo(r); onClose(); }}
                        >
                            <span className={s.sender}>{r.sender_name}</span>
                            <span className={s.content}>{r.content}</span>
                            <span className={s.date}>
                                {new Date(r.created_at).toLocaleDateString()}
                            </span>
                        </button>
                    ))}
                </div>
            </div>
        </div>
    );
}

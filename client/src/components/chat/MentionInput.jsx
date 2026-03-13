import { useState, useRef, useEffect, useCallback, useImperativeHandle } from 'react';
import s from './MentionInput.module.css';
import { searchChatUsers } from '../../api';

export default function MentionInput({
    ref, value, onChange, onSubmit, onKeyDown, placeholder,
    members, className, autoFocus, maxLength
}) {
    const [mentionQuery, setMentionQuery] = useState('');
    const [suggestions, setSuggestions] = useState([]);
    const [showSuggestions, setShowSuggestions] = useState(false);
    const [selIdx, setSelIdx] = useState(0);
    const [mentionStart, setMentionStart] = useState(-1);
    const inputRef = useRef(null);
    const mentionedIds = useRef([]);

    const handleChange = useCallback((e) => {
        const val = e.target.value;
        onChange(val);

        // Detect @ trigger
        const pos = e.target.selectionStart;
        const textBefore = val.slice(0, pos);
        const atMatch = textBefore.match(/@(\w*)$/);

        if (atMatch) {
            setMentionStart(pos - atMatch[0].length);
            setMentionQuery(atMatch[1]);
            setShowSuggestions(true);
            setSelIdx(0);
        } else {
            setShowSuggestions(false);
            setMentionQuery('');
        }
    }, [onChange]);

    // Filter members or search users
    useEffect(() => {
        if (!showSuggestions) return;
        if (members && members.length > 0) {
            const q = mentionQuery.toLowerCase();
            const filtered = members.filter(m =>
                m.full_name?.toLowerCase().includes(q) || m.username?.toLowerCase().includes(q)
            ).slice(0, 6);
            setSuggestions(filtered);
        } else if (mentionQuery.length >= 1) {
            const timer = setTimeout(async () => {
                try {
                    const { data } = await searchChatUsers(mentionQuery);
                    setSuggestions(data.slice(0, 6));
                } catch { setSuggestions([]); }
            }, 200);
            return () => clearTimeout(timer);
        }
    }, [mentionQuery, showSuggestions, members]);

    const insertMention = useCallback((user) => {
        const before = value.slice(0, mentionStart);
        const after = value.slice(inputRef.current?.selectionStart || mentionStart + mentionQuery.length + 1);
        const newVal = `${before}@${user.full_name || user.username} ${after}`;
        onChange(newVal);
        mentionedIds.current = [...new Set([...mentionedIds.current, user.id])];
        setShowSuggestions(false);
        setMentionQuery('');
        inputRef.current?.focus();
    }, [value, mentionStart, mentionQuery, onChange]);

    // Auto-resize textarea to fit content
    const autoResize = useCallback(() => {
        const el = inputRef.current;
        if (!el) return;
        el.style.height = 'auto';
        el.style.height = Math.min(el.scrollHeight, 150) + 'px';
    }, []);

    useEffect(() => { autoResize(); }, [value, autoResize]);

    const handleKeyDown = useCallback((e) => {
        if (showSuggestions && suggestions.length > 0) {
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                setSelIdx(i => (i + 1) % suggestions.length);
                return;
            }
            if (e.key === 'ArrowUp') {
                e.preventDefault();
                setSelIdx(i => (i - 1 + suggestions.length) % suggestions.length);
                return;
            }
            if (e.key === 'Enter' || e.key === 'Tab') {
                e.preventDefault();
                insertMention(suggestions[selIdx]);
                return;
            }
            if (e.key === 'Escape') {
                setShowSuggestions(false);
                return;
            }
        }
        // Enter sends, Shift+Enter inserts newline
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            onSubmit?.(e);
            return;
        }
        onKeyDown?.(e);
    }, [showSuggestions, suggestions, selIdx, insertMention, onKeyDown, onSubmit]);

    const getMentionedIds = () => mentionedIds.current;
    const resetMentionedIds = () => { mentionedIds.current = []; };

    useImperativeHandle(ref, () => ({
        getMentionedIds,
        resetMentionedIds,
        focus: () => inputRef.current?.focus()
    }));

    return (
        <div className={s.wrap}>
            <textarea
                ref={inputRef}
                value={value}
                onChange={handleChange}
                onKeyDown={handleKeyDown}
                placeholder={placeholder}
                className={className}
                autoFocus={autoFocus}
                maxLength={maxLength}
                rows={1}
            />
            {showSuggestions && suggestions.length > 0 && (
                <div className={s.suggestions}>
                    {suggestions.map((u, i) => (
                        <button
                            key={u.id}
                            className={`${s.suggestion} ${i === selIdx ? s.selected : ''}`}
                            onMouseDown={(e) => { e.preventDefault(); insertMention(u); }}
                        >
                            <span className={s.sugName}>{u.full_name}</span>
                            <span className={s.sugUser}>@{u.username}</span>
                        </button>
                    ))}
                </div>
            )}
        </div>
    );
}

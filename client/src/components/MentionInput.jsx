import React, { useRef, useState, useEffect, useCallback } from 'react';

/**
 * Contenteditable comment input with @mention support.
 * Props:
 *   value       - initial HTML string (set once on mount)
 *   onChange    - called with HTML string on every change
 *   users       - array of { id, username, full_name, avatar }
 *   placeholder - placeholder text
 *   onSubmit    - optional: called on Ctrl/Cmd+Enter
 */
export default function MentionInput({ value, onChange, users = [], placeholder, onSubmit }) {
  const editorRef = useRef(null);
  const [mentionQuery, setMentionQuery] = useState(null); // null = closed
  const [dropPos, setDropPos] = useState({ top: 0, left: 0 });
  const [activeIdx, setActiveIdx] = useState(0);
  const initialized = useRef(false);

  // Seed initial HTML (only once)
  useEffect(() => {
    if (!initialized.current && editorRef.current) {
      editorRef.current.innerHTML = value || '';
      initialized.current = true;
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Clear editor imperatively (called from parent after submit)
  useEffect(() => {
    if (value === '' && initialized.current && editorRef.current) {
      editorRef.current.innerHTML = '';
    }
  }, [value]);

  const filtered = mentionQuery !== null
    ? users.filter(u => {
        const q = mentionQuery.toLowerCase();
        return (u.full_name || '').toLowerCase().includes(q) ||
               (u.username || '').toLowerCase().includes(q);
      }).slice(0, 8)
    : [];

  const emitChange = useCallback(() => {
    if (editorRef.current) onChange(editorRef.current.innerHTML);
  }, [onChange]);

  const detectMention = useCallback(() => {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) { setMentionQuery(null); return; }
    const range = sel.getRangeAt(0);
    if (!range.collapsed) { setMentionQuery(null); return; }

    const node = range.startContainer;
    if (node.nodeType !== Node.TEXT_NODE) { setMentionQuery(null); return; }

    const text = node.textContent.slice(0, range.startOffset);
    const atIdx = text.lastIndexOf('@');
    if (atIdx === -1) { setMentionQuery(null); return; }

    // @ must be at word start (preceded by nothing, space/newline, or open paren/bracket)
    const charBefore = text[atIdx - 1];
    if (charBefore && !/[\s([]/.test(charBefore)) { setMentionQuery(null); return; }

    const query = text.slice(atIdx + 1);
    // If query contains a space + is longer than a realistic name fragment, close
    if (/\s/.test(query) && query.length > 20) { setMentionQuery(null); return; }

    // Position the dropdown near the caret
    const rect = range.getBoundingClientRect();
    const editorRect = editorRef.current.getBoundingClientRect();
    setDropPos({
      top: rect.bottom - editorRect.top + 4,
      left: Math.max(0, rect.left - editorRect.left),
    });
    setMentionQuery(query);
    setActiveIdx(0);
  }, []);

  const insertMention = useCallback((user) => {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    const node = range.startContainer;
    if (node.nodeType !== Node.TEXT_NODE) return;

    const text = node.textContent;
    const offset = range.startOffset;
    const atIdx = text.lastIndexOf('@', offset - 1);
    if (atIdx === -1) return;

    const beforeAt = text.slice(0, atIdx);
    const afterCaret = text.slice(offset);

    // Build mention span
    const span = document.createElement('span');
    span.className = 'mention-chip';
    span.setAttribute('data-user-id', String(user.id));
    span.setAttribute('contenteditable', 'false');
    span.textContent = `@${user.full_name || user.username}`;

    const space = document.createTextNode('\u00A0'); // nbsp after mention

    // Rewrite surrounding text
    node.textContent = beforeAt;
    node.parentNode.insertBefore(span, node.nextSibling);
    node.parentNode.insertBefore(space, span.nextSibling);
    if (afterCaret) {
      node.parentNode.insertBefore(document.createTextNode(afterCaret), space.nextSibling);
    }

    // Move caret after the space
    const newRange = document.createRange();
    newRange.setStart(space, space.length);
    newRange.collapse(true);
    sel.removeAllRanges();
    sel.addRange(newRange);

    setMentionQuery(null);
    // Emit after a microtask so DOM settles
    setTimeout(() => { if (editorRef.current) onChange(editorRef.current.innerHTML); }, 0);
  }, [onChange]);

  const handleKeyDown = useCallback((e) => {
    if (mentionQuery !== null && filtered.length > 0) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setActiveIdx(i => Math.min(i + 1, filtered.length - 1)); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setActiveIdx(i => Math.max(i - 1, 0)); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); insertMention(filtered[activeIdx]); return; }
      if (e.key === 'Escape') { setMentionQuery(null); return; }
    }
    // Ctrl/Cmd+Enter to submit
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && onSubmit) {
      e.preventDefault();
      onSubmit();
    }
  }, [mentionQuery, filtered, activeIdx, insertMention, onSubmit]);

  const handleInput = useCallback(() => {
    detectMention();
    emitChange();
  }, [detectMention, emitChange]);

  const handlePaste = useCallback((e) => {
    e.preventDefault();
    const text = e.clipboardData.getData('text/plain');
    document.execCommand('insertText', false, text);
  }, []);

  const handleBlur = useCallback(() => {
    // Delay close so mousedown on dropdown option fires first
    setTimeout(() => setMentionQuery(null), 150);
  }, []);

  return (
    <div className="mention-input-wrapper">
      <div
        ref={editorRef}
        className="mention-input-editor"
        contentEditable
        suppressContentEditableWarning
        onInput={handleInput}
        onKeyDown={handleKeyDown}
        onPaste={handlePaste}
        onBlur={handleBlur}
        data-placeholder={placeholder || 'Write a comment… (type @ to mention someone)'}
        role="textbox"
        aria-multiline="true"
        aria-label={placeholder || 'Comment input'}
      />
      {mentionQuery !== null && filtered.length > 0 && (
        <div className="mention-dropdown" style={{ top: dropPos.top, left: dropPos.left }}>
          {filtered.map((u, i) => (
            <div
              key={u.id}
              className={`mention-option${i === activeIdx ? ' mention-option-active' : ''}`}
              onMouseDown={(e) => { e.preventDefault(); insertMention(u); }}
              onMouseEnter={() => setActiveIdx(i)}
            >
              <span className="mention-option-name">{u.full_name || u.username}</span>
              {u.full_name && <span className="mention-option-handle">@{u.username}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

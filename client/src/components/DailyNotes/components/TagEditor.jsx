/* TagEditor — pill list + add-tag input shown in the modal editor meta row */
import React from 'react';
import { tagColor } from '../notesUtils';
import s from './TagEditor.module.css';

export default function TagEditor({
  tags = [],
  tagInput,
  setTagInput,
  showTagInput,
  setShowTagInput,
  tagInputRef,
  onAddTag,
  onRemoveTag,
  pageId,
}) {
  return (
    <div className={s.tagRow}>
      {tags.map(tag => (
        <span key={tag} className={s.tagPill} style={{ '--tag-color': tagColor(tag) }}>
          {tag}
          <button className={s.tagRemove} onClick={() => onRemoveTag(pageId, tag)}>×</button>
        </span>
      ))}

      {showTagInput ? (
        <input
          ref={tagInputRef}
          className={s.tagAddInput}
          value={tagInput}
          onChange={e => setTagInput(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && tagInput.trim()) {
              onAddTag(pageId, tagInput);
              setTagInput('');
            }
            if (e.key === 'Escape') { setShowTagInput(false); setTagInput(''); }
          }}
          onBlur={() => {
            if (tagInput.trim()) onAddTag(pageId, tagInput);
            setShowTagInput(false);
            setTagInput('');
          }}
          placeholder="Tag name…"
          autoFocus
        />
      ) : (
        <button
          className={s.tagAddBtn}
          onClick={() => { setShowTagInput(true); setTagInput(''); }}
        >
          + tag
        </button>
      )}
    </div>
  );
}

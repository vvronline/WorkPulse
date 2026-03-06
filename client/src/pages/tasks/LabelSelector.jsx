import React, { useRef, useEffect } from 'react';
import s from './LabelSelector.module.css';

export default function LabelSelector({ labels, selected, onToggle, open, setOpen }) {
  const ref = useRef(null);

  useEffect(() => {
    const handler = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [setOpen]);

  return (
    <div className={s['label-selector']} ref={ref}>
      <button
        type="button"
        className={s['label-selector-btn']}
        onClick={() => setOpen((o) => !o)}
      >
        🏷️ Labels{' '}
        {selected.length > 0 && (
          <span className={s['label-count']}>{selected.length}</span>
        )}
      </button>
      {open && (
        <div className={s['label-dropdown']}>
          {labels.length === 0 && (
            <div className={s['label-dropdown-empty']}>No labels configured</div>
          )}
          {labels.map((l) => (
            <label key={l.id} className={s['label-option']}>
              <input
                type="checkbox"
                checked={selected.includes(l.id)}
                onChange={() => onToggle(l.id)}
              />
              <span
                className={s['label-pill']}
                style={{ '--label-color': l.color }}
              >
                {l.name}
              </span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

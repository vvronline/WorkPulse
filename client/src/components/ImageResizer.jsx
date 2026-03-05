import React, { useEffect, useRef, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import ReactQuill from 'react-quill-new';
import s from './ImageResizer.module.css';

const QuillLib = ReactQuill.Quill;

/* ─────────────────────────────────────────────────────────────────
   ImageResizer
   ─────────────────────────────────────────────────────────────────
   Renders drag handles (via portal to document.body) around any
   <img> the user clicks inside the Quill editor.  On drag end it
   persists the new width back into the Quill delta.

   Props:
     quillRef – ref to a <ReactQuill> component
───────────────────────────────────────────────────────────────────*/
export default function ImageResizer({ quillRef }) {
  const [sel, setSel]     = useState(null);   // { img, rect }
  const drag              = useRef(null);      // active drag state
  const boxRef            = useRef(null);      // overlay div

  /* ── Recompute overlay rect from current image position ── */
  const syncRect = useCallback((img) => {
    if (!img) return;
    const r = img.getBoundingClientRect();
    setSel({ img, rect: { top: r.top, left: r.left, width: r.width, height: r.height } });
  }, []);

  /* ── Click inside Quill → select image ── */
  useEffect(() => {
    const q = quillRef?.current?.getEditor?.();
    if (!q) return;
    const root = q.root;

    const onClick = (e) => {
      if (e.target.tagName === 'IMG') {
        e.preventDefault();
        syncRect(e.target);
      }
    };
    root.addEventListener('click', onClick);
    return () => root.removeEventListener('click', onClick);
  }, [quillRef, syncRect]);

  /* ── Click outside overlay/image → deselect ── */
  useEffect(() => {
    if (!sel) return;
    const down = (e) => {
      if (boxRef.current?.contains(e.target)) return;
      if (e.target === sel.img) return;
      setSel(null);
    };
    document.addEventListener('mousedown', down);
    return () => document.removeEventListener('mousedown', down);
  }, [sel]);

  /* ── Keep overlay aligned on scroll / resize ── */
  useEffect(() => {
    if (!sel) return;
    const fn = () => syncRect(sel.img);
    window.addEventListener('scroll', fn, true);
    window.addEventListener('resize', fn);
    return () => {
      window.removeEventListener('scroll', fn, true);
      window.removeEventListener('resize', fn);
    };
  }, [sel, syncRect]);

  /* ── Drag a handle ── */
  const onHandleMouseDown = useCallback((e, dir) => {
    e.preventDefault();
    e.stopPropagation();
    if (!sel) return;

    const { img } = sel;
    drag.current = {
      dir,
      startX:     e.clientX,
      startY:     e.clientY,
      startW:     img.getBoundingClientRect().width,
      startH:     img.getBoundingClientRect().height,
      aspect:     img.getBoundingClientRect().width / img.getBoundingClientRect().height,
      img,
    };

    const onMove = (me) => {
      if (!drag.current) return;
      const { dir, startX, startY, startW, startH, aspect, img } = drag.current;
      const dx = me.clientX - startX;
      const dy = me.clientY - startY;

      let newW = startW;

      if (dir === 'e' || dir === 'se')          newW = startW + dx;
      else if (dir === 'w' || dir === 'sw')     newW = startW - dx;
      else if (dir === 'ne')                    newW = startW + dx;
      else if (dir === 'nw')                    newW = startW - dx;
      else if (dir === 's')                     newW = startW + dy * aspect;
      else if (dir === 'n')                     newW = startW - dy * aspect;

      newW = Math.max(40, Math.round(newW));
      img.style.width  = newW + 'px';
      img.style.height = 'auto';
      syncRect(img);
    };

    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      if (!drag.current) return;
      const { img } = drag.current;
      drag.current = null;

      // Commit back into Quill
      commitToQuill(quillRef, img);
      syncRect(img);
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [sel, quillRef, syncRect]);

  if (!sel) return null;

  const { rect } = sel;
  const HANDLES = ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'];

  return createPortal(
    <div
      ref={boxRef}
      className={s.overlay}
      style={{ top: rect.top, left: rect.left, width: rect.width, height: rect.height }}
    >
      <div className={s.border} />
      <div className={s.sizeBadge}>
        {Math.round(rect.width)} × {Math.round(rect.height)} px
      </div>
      {HANDLES.map(h => (
        <div
          key={h}
          className={`${s.handle} ${s[h]}`}
          onMouseDown={(e) => onHandleMouseDown(e, h)}
        />
      ))}
    </div>,
    document.body
  );
}

/* ── Write the resized width back into the Quill delta ── */
function commitToQuill(quillRef, img) {
  try {
    const q = quillRef?.current?.getEditor?.();
    if (!q) return;
    const finalW = Math.round(img.getBoundingClientRect().width);
    const blot = QuillLib?.find?.(img);
    if (!blot) return;
    const idx = q.getIndex(blot);
    const src = img.getAttribute('src') || img.src;
    // Delete existing embed and re-insert with width attribute
    q.deleteText(idx, 1, 'silent');
    q.insertEmbed(idx, 'image', src, 'silent');
    q.formatText(idx, 1, { width: finalW + 'px', height: false }, 'silent');
    q.setSelection(idx + 1, 0, 'silent');
  } catch (_) {
    // Non-fatal — image already resized in the DOM; only the delta is stale
  }
}

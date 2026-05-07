/* QuillEditor — thin wrapper around ReactQuill with consistent styling.
   Wires in:
     • SlashMenu  — Notion-style "/" command popover.
     • Image paste — drop or paste images get embedded as data URLs
       (works immediately with no backend; can be swapped for an
       upload pipeline later by replacing the FileReader with an
       upload call). */
import React, { useEffect } from 'react';
import ReactQuill from 'react-quill-new';
import 'react-quill-new/dist/quill.snow.css';
import ImageResizer from '../../common/ImageResizer';
import SlashMenu from './SlashMenu';
import CodeBlockLanguagePicker from './CodeBlockLanguagePicker';
import { QUILL_MODULES } from '../quillConfig';
import s from './QuillEditor.module.css';

function getEditor(ref) {
  const node = ref?.current;
  if (!node) return null;
  return typeof node.getEditor === 'function' ? node.getEditor() : node;
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

/* Insert a single image File at the current selection (or the end). */
async function insertImageFromFile(quill, file) {
  if (!quill || !file || !file.type?.startsWith('image/')) return;
  try {
    const url = await fileToDataUrl(file);
    const sel = quill.getSelection(true) || { index: quill.getLength() };
    quill.insertEmbed(sel.index, 'image', url, 'user');
    quill.setSelection(sel.index + 1, 'silent');
  } catch {
    /* swallow — pasting failed silently is better than crashing the editor */
  }
}

export default function QuillEditor({
  pageId,
  defaultContent,
  quillRef,
  onChange,
  variant = 'inline', // 'inline' | 'modal'
  resetKey = 0,        // increment to force re-init (e.g. after snapshot restore)
}) {
  const wrapClass = variant === 'modal' ? s.modalWrap : s.inlineWrap;

  /* ── Paste / drop image → embed as data URL ─────────────── */
  useEffect(() => {
    const quill = getEditor(quillRef);
    if (!quill) return;
    const root = quill.root;
    if (!root) return;

    const onPaste = (e) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const item of items) {
        if (item.kind === 'file' && item.type.startsWith('image/')) {
          e.preventDefault();
          const file = item.getAsFile();
          if (file) insertImageFromFile(quill, file);
          return;
        }
      }
    };

    const onDrop = (e) => {
      const files = e.dataTransfer?.files;
      if (!files || files.length === 0) return;
      const imgs = Array.from(files).filter(f => f.type.startsWith('image/'));
      if (imgs.length === 0) return;
      e.preventDefault();
      // Move caret to drop position when possible
      try {
        const range = quill.getSelection();
        if (!range) {
          quill.focus();
          quill.setSelection(quill.getLength(), 'silent');
        }
      } catch { /* ignore */ }
      imgs.forEach(file => insertImageFromFile(quill, file));
    };

    const onDragOver = (e) => {
      // Allow drop
      if (e.dataTransfer && Array.from(e.dataTransfer.items || []).some(i => i.kind === 'file')) {
        e.preventDefault();
      }
    };

    root.addEventListener('paste', onPaste);
    root.addEventListener('drop', onDrop);
    root.addEventListener('dragover', onDragOver);
    return () => {
      root.removeEventListener('paste', onPaste);
      root.removeEventListener('drop', onDrop);
      root.removeEventListener('dragover', onDragOver);
    };
    // Re-bind whenever Quill is re-created (pageId / resetKey)
  }, [quillRef, pageId, resetKey]);

  return (
    <div className={wrapClass}>
      <ReactQuill
        key={`${pageId}-${resetKey}`}
        ref={quillRef}
        theme="snow"
        defaultValue={defaultContent}
        onChange={onChange}
        modules={QUILL_MODULES}
        placeholder="Start writing… or press / for commands"
      />
      <ImageResizer quillRef={quillRef} />
      <SlashMenu quillRef={quillRef} />
      <CodeBlockLanguagePicker
        quillRef={quillRef}
        pageId={pageId}
        resetKey={resetKey}
      />
    </div>
  );
}

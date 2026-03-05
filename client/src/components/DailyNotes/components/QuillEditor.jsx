/* QuillEditor — thin wrapper around ReactQuill with consistent styling */
import React from 'react';
import ReactQuill from 'react-quill-new';
import 'react-quill-new/dist/quill.snow.css';
import ImageResizer from '../../ImageResizer';
import { QUILL_MODULES } from '../quillConfig';
import s from './QuillEditor.module.css';

export default function QuillEditor({
  pageId,
  defaultContent,
  quillRef,
  onChange,
  variant = 'inline', // 'inline' | 'modal'
  resetKey = 0,        // increment to force re-init (e.g. after snapshot restore)
}) {
  const wrapClass = variant === 'modal' ? s.modalWrap : s.inlineWrap;

  return (
    <div className={wrapClass}>
      <ReactQuill
        key={`${pageId}-${resetKey}`}
        ref={quillRef}
        theme="snow"
        defaultValue={defaultContent}
        onChange={onChange}
        modules={QUILL_MODULES}
        placeholder="Start writing…"
      />
      <ImageResizer quillRef={quillRef} />
    </div>
  );
}

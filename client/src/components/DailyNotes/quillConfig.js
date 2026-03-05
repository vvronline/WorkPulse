/* ─────────────────────────────────────────────────────────
   Quill editor configuration.
   Registers custom blots and exports the shared modules
   object (defined once at module level – never re-created).
   ───────────────────────────────────────────────────────── */
import ReactQuill from 'react-quill-new';

const Quill = ReactQuill.Quill;
const BlockEmbed = Quill.import('blots/block/embed');

// ── Custom blot: horizontal rule ─────────────────────────
class DividerBlot extends BlockEmbed {
  static create() {
    return super.create();
  }
}
DividerBlot.blotName = 'divider';
DividerBlot.tagName = 'hr';
Quill.register(DividerBlot, true);

// ── Toolbar + module config ───────────────────────────────
export const QUILL_MODULES = {
  toolbar: {
    container: [
      [{ header: [1, 2, 3, false] }],
      ['bold', 'italic', 'underline'],
      [{ color: [] }, { background: [] }],
      [{ list: 'ordered' }, { list: 'bullet' }, { list: 'check' }],
      ['blockquote', 'link', 'image'],
      ['divider', 'timestamp'],
      ['clean'],
    ],
    handlers: {
      divider() {
        const q = this.quill;
        const range = q.getSelection(true);
        q.insertText(range.index, '\n', Quill.sources.USER);
        q.insertEmbed(range.index + 1, 'divider', true, Quill.sources.USER);
        q.setSelection(range.index + 2, Quill.sources.SILENT);
      },
      timestamp() {
        const q = this.quill;
        const range = q.getSelection(true);
        const str = new Date().toLocaleString(undefined, {
          year: 'numeric', month: 'short', day: 'numeric',
          hour: '2-digit', minute: '2-digit',
        });
        q.insertText(range.index, str, Quill.sources.USER);
        q.setSelection(range.index + str.length, Quill.sources.SILENT);
      },
    },
  },
  history: { delay: 1000, maxStack: 100, userOnly: false },
};

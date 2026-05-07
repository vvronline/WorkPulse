/* ─────────────────────────────────────────────────────────
   Quill editor configuration.
   Registers custom blots and exports the shared modules
   object (defined once at module level – never re-created).
   ───────────────────────────────────────────────────────── */
import ReactQuill from 'react-quill-new';

const Quill = ReactQuill.Quill;
const BlockEmbed = Quill.import('blots/block/embed');
const Block = Quill.import('blots/block');

// ── Custom blot: horizontal rule ─────────────────────────
class DividerBlot extends BlockEmbed {
  static create() {
    return super.create();
  }
}
DividerBlot.blotName = 'divider';
DividerBlot.tagName = 'hr';
Quill.register(DividerBlot, true);

/* ── Custom blot: callout (Notion-style info card) ──────────
   Renders as <div data-callout="info|warn|success|tip">…</div>
   Variant is read from the data attribute and styled in
   QuillEditor.module.css.
   ─────────────────────────────────────────────────────────── */
class CalloutBlot extends Block {
  static create(value) {
    const node = super.create();
    const variant = (typeof value === 'string' && value) || 'info';
    node.setAttribute('data-callout', variant);
    return node;
  }
  static formats(node) {
    return node.getAttribute('data-callout') || 'info';
  }
  format(name, value) {
    if (name === CalloutBlot.blotName && value) {
      this.domNode.setAttribute('data-callout', value);
    } else {
      super.format(name, value);
    }
  }
}
CalloutBlot.blotName = 'callout';
CalloutBlot.tagName = 'div';
CalloutBlot.className = 'ql-callout';
Quill.register(CalloutBlot, true);

/* ── Code-block languages we expose in the slash menu ─────── */
export const CODE_LANGUAGES = [
  { id: 'plaintext', label: 'Plain text' },
  { id: 'javascript', label: 'JavaScript' },
  { id: 'typescript', label: 'TypeScript' },
  { id: 'python', label: 'Python' },
  { id: 'java', label: 'Java' },
  { id: 'csharp', label: 'C#' },
  { id: 'go', label: 'Go' },
  { id: 'json', label: 'JSON' },
  { id: 'sql', label: 'SQL' },
  { id: 'bash', label: 'Bash' },
  { id: 'html', label: 'HTML' },
  { id: 'css', label: 'CSS' },
];

/* ── Toolbar + module config ──────────────────────────────── */
const baseModules = {
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

/* Enable the syntax module if hljs is available on window. The
   `hljs-setup.js` module sets `window.hljs` synchronously on app
   boot, so this branch is taken in the browser. We guard the
   check so SSR / unit-test environments without window don't blow
   up. */
if (typeof window !== 'undefined' && window.hljs) {
  baseModules.syntax = { hljs: window.hljs, interval: 250 };
}

export const QUILL_MODULES = baseModules;

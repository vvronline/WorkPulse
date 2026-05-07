/* ─────────────────────────────────────────────────────────
   Quill editor configuration.
   Registers custom blots and exports the shared modules
   object (defined once at module level – never re-created).
   ───────────────────────────────────────────────────────── */
import ReactQuill from 'react-quill-new';

const Quill = ReactQuill.Quill;
const BlockEmbed = Quill.import('blots/block/embed');
const InlineEmbed = Quill.import('blots/embed');
const Inline = Quill.import('blots/inline');
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

/* ── Custom blot: internal page link ───────────────────────
   Renders as <a class="ql-pagelink" data-page-id="…" href="#">…</a>
   The editor consumer (ModalEditor / hooks) listens for clicks
   on `.ql-pagelink` and calls openEditor(pageId).
   ───────────────────────────────────────────────────────── */
class PageLinkBlot extends Inline {
  static create(value) {
    const node = super.create();
    const v = (typeof value === 'object') ? value : { id: value, title: '' };
    node.setAttribute('data-page-id', v.id || '');
    node.setAttribute('data-page-title', v.title || '');
    node.setAttribute('href', '#');
    node.setAttribute('contenteditable', 'false');
    node.classList.add('ql-pagelink');
    return node;
  }
  static formats(node) {
    return {
      id: node.getAttribute('data-page-id') || '',
      title: node.getAttribute('data-page-title') || '',
    };
  }
  format(name, value) {
    if (name === PageLinkBlot.blotName && value) {
      const v = (typeof value === 'object') ? value : { id: value, title: '' };
      this.domNode.setAttribute('data-page-id', v.id || '');
      this.domNode.setAttribute('data-page-title', v.title || '');
    } else {
      super.format(name, value);
    }
  }
}
PageLinkBlot.blotName = 'pagelink';
PageLinkBlot.tagName = 'a';
PageLinkBlot.className = 'ql-pagelink';
Quill.register(PageLinkBlot, true);

/* ── Custom blot: date chip ───────────────────────────────
   Renders an inline <span data-date="YYYY-MM-DD"> chip used by
   the @date mention. Click handler in ModalEditor scrolls the
   calendar (if integrated) or just stays visual.
   ───────────────────────────────────────────────────────── */
class DateChipBlot extends Inline {
  static create(value) {
    const node = super.create();
    node.setAttribute('data-date', value || '');
    node.setAttribute('contenteditable', 'false');
    node.classList.add('ql-datechip');
    return node;
  }
  static formats(node) { return node.getAttribute('data-date') || ''; }
}
DateChipBlot.blotName = 'datechip';
DateChipBlot.tagName = 'span';
DateChipBlot.className = 'ql-datechip';
Quill.register(DateChipBlot, true);

/* ── Custom blot: @mention chip ───────────────────────────
   Renders as <span class="ql-mention" data-user-id="…" data-user-name="…">@Name</span>
   Uses inline Embed so it is atomic — Quill treats it as a
   single unit and won't duplicate inner text on reload.
   ───────────────────────────────────────────────────────── */
class MentionBlot extends InlineEmbed {
  static create(value) {
    const node = super.create();
    const v = (typeof value === 'object') ? value : { id: value, name: '' };
    node.setAttribute('data-user-id', v.id || '');
    node.setAttribute('data-user-name', v.name || '');
    if (v.avatar) node.setAttribute('data-user-avatar', v.avatar);
    node.setAttribute('contenteditable', 'false');
    node.innerText = `@${v.name || 'user'}`;
    return node;
  }
  static value(node) {
    return {
      id: node.getAttribute('data-user-id') || '',
      name: node.getAttribute('data-user-name') || '',
      avatar: node.getAttribute('data-user-avatar') || '',
    };
  }
}
MentionBlot.blotName = 'mention';
MentionBlot.tagName = 'span';
MentionBlot.className = 'ql-mention';
Quill.register(MentionBlot, true);

/* ── Custom blot: collapsible toggle block ────────────────
   Renders as
     <div class="ql-toggle" data-open="true|false">
       <p class="ql-toggle-summary">Heading</p>
       … child paragraphs …
     </div>
   The summary line is always the first child <p>.
   Clicking the chevron toggles `data-open`; CSS handles hide/show.
   ───────────────────────────────────────────────────────── */
class ToggleBlot extends Block {
  static create(value) {
    const node = super.create();
    node.setAttribute('data-open', value === false ? 'false' : 'true');
    return node;
  }
  static formats(node) {
    return node.getAttribute('data-open') !== 'false';
  }
  format(name, value) {
    if (name === ToggleBlot.blotName) {
      this.domNode.setAttribute('data-open', value === false ? 'false' : 'true');
    } else {
      super.format(name, value);
    }
  }
}
ToggleBlot.blotName = 'toggle';
ToggleBlot.tagName = 'div';
ToggleBlot.className = 'ql-toggle';
Quill.register(ToggleBlot, true);

/* ── Custom blot: math (KaTeX-rendered LaTeX) ─────────────
   Renders as <div class="ql-math" data-tex="…">  …rendered HTML… </div>
   Renderer is plugged in lazily — if window.katex is available we
   render to HTML, otherwise we display the raw $$ latex $$.
   ───────────────────────────────────────────────────────── */
class MathBlot extends BlockEmbed {
  static create(value) {
    const node = super.create();
    const tex = (value || '').toString();
    node.setAttribute('data-tex', tex);
    node.setAttribute('contenteditable', 'false');
    node.classList.add('ql-math');
    MathBlot.render(node, tex);
    node.addEventListener('click', () => MathBlot.editPrompt(node));
    return node;
  }
  static value(node) { return node.getAttribute('data-tex') || ''; }
  static render(node, tex) {
    const k = typeof window !== 'undefined' ? window.katex : null;
    try {
      if (k && tex) {
        node.innerHTML = k.renderToString(tex, { displayMode: true, throwOnError: false });
      } else {
        node.textContent = tex ? `$$ ${tex} $$` : '$$ … $$';
      }
    } catch {
      node.textContent = tex ? `$$ ${tex} $$` : '$$ … $$';
    }
  }
  static editPrompt(node) {
    if (typeof window === 'undefined') return;
    const cur = node.getAttribute('data-tex') || '';
    const next = window.prompt('LaTeX expression:', cur);
    if (next === null) return;
    node.setAttribute('data-tex', next);
    MathBlot.render(node, next);
  }
}
MathBlot.blotName = 'math';
MathBlot.tagName = 'div';
MathBlot.className = 'ql-math';
Quill.register(MathBlot, true);

/* ── Custom blot: draw.io diagram ─────────────────────────
   Renders as
     <div class="ql-drawio"
          data-xml="…raw mxGraph XML (URI-encoded)…">
       <svg>…snapshot rendered by draw.io…</svg>
       <div class="ql-drawio-overlay">…hover hint…</div>
     </div>

   The XML is the source of truth. The SVG is a self-contained
   snapshot returned by the draw.io embed (so the diagram is
   visible even when the embed isn't loaded).

   Clicking the block dispatches a 'notes:drawio-edit' custom
   event on the node; the host (DrawioEditor + useNotesStore)
   listens for it, opens the embed in a modal, and rewrites
   `data-xml` + the inner SVG when the user saves.

   Storing XML inline keeps everything within the existing
   notebook JSON blob — no new server tables required.
   ───────────────────────────────────────────────────────── */
class DrawioBlot extends BlockEmbed {
  static create(value) {
    const node = super.create();
    const v = (typeof value === 'object' && value) || {};
    const xml = v.xml || '';
    const svg = v.svg || '';
    node.setAttribute('contenteditable', 'false');
    node.classList.add('ql-drawio');
    if (xml) node.setAttribute('data-xml', encodeURIComponent(xml));
    DrawioBlot.renderInner(node, svg);
    node.addEventListener('click', (e) => {
      // Click anywhere on the diagram opens the editor
      e.preventDefault();
      try {
        node.dispatchEvent(new CustomEvent('notes:drawio-edit', {
          bubbles: true,
          detail: { node },
        }));
      } catch { /* ignore */ }
    });
    return node;
  }
  static value(node) {
    const xmlEnc = node.getAttribute('data-xml') || '';
    let xml = '';
    try { xml = decodeURIComponent(xmlEnc); } catch { xml = xmlEnc; }
    // Prefer the SVG that's currently on the DOM (this is the snapshot
    // returned by draw.io after the user pressed save).
    const svg = node.querySelector('svg')?.outerHTML || '';
    return { xml, svg };
  }
  static renderInner(node, svg) {
    if (svg) {
      node.innerHTML = svg
        + '<div class="ql-drawio-overlay">Click to edit</div>';
    } else {
      node.innerHTML =
        '<div class="ql-drawio-empty">📐 Draw.io diagram — click to edit</div>';
    }
  }
}
DrawioBlot.blotName = 'drawio';
DrawioBlot.tagName = 'div';
DrawioBlot.className = 'ql-drawio';
Quill.register(DrawioBlot, true);

/* ── Custom blot: simple HTML table ───────────────────────
   We register a single block embed that wraps a contenteditable
   <table>. This is a pragmatic compromise — Quill's flat Delta
   model doesn't support proper structured tables, but for our
   needs (rows × cols, editable cells) a contentEditable wrapper
   inside an embed works well and round-trips through HTML.
   ───────────────────────────────────────────────────────── */
class SimpleTableBlot extends BlockEmbed {
  static create(value) {
    const node = super.create();
    const cfg = (typeof value === 'object' && value) || { rows: 3, cols: 3 };
    node.setAttribute('contenteditable', 'true');
    node.classList.add('ql-simpletable');
    if (typeof cfg === 'string' && cfg.trim().startsWith('<table')) {
      // Restore from saved HTML
      node.innerHTML = cfg;
    } else if (cfg.html && cfg.html.trim().startsWith('<table')) {
      node.innerHTML = cfg.html;
    } else {
      const rows = Math.max(1, Math.min(20, cfg.rows || 3));
      const cols = Math.max(1, Math.min(10, cfg.cols || 3));
      let html = '<table><thead><tr>';
      for (let c = 0; c < cols; c++) html += `<th>Header ${c + 1}</th>`;
      html += '</tr></thead><tbody>';
      for (let r = 0; r < rows - 1; r++) {
        html += '<tr>';
        for (let c = 0; c < cols; c++) html += '<td><br></td>';
        html += '</tr>';
      }
      html += '</tbody></table>';
      node.innerHTML = html;
    }
    return node;
  }
  static value(node) { return node.innerHTML; }
}
SimpleTableBlot.blotName = 'simpletable';
SimpleTableBlot.tagName = 'div';
SimpleTableBlot.className = 'ql-simpletable';
Quill.register(SimpleTableBlot, true);

/* ── Custom blot: audio recording ─────────────────────────
   Renders an <audio controls> element backed by a base64
   data URL. The data URL is stored on `data-src` so it round-
   trips through Quill's HTML-based persistence. The blot is
   contenteditable=false so the audio controls stay clickable.

   For larger recordings we could later swap the data URL for
   an attachments-table reference (see Tier 1 §7), but for now
   inline base64 keeps everything in the existing notebook
   blob with no schema changes.
   ───────────────────────────────────────────────────────── */
class AudioBlot extends BlockEmbed {
  static create(value) {
    const node = super.create();
    const v = (typeof value === 'object' && value) || { src: value || '' };
    node.setAttribute('contenteditable', 'false');
    node.classList.add('ql-audio');
    node.setAttribute('data-src', v.src || '');
    if (v.label) node.setAttribute('data-label', v.label);
    AudioBlot.renderInner(node);
    return node;
  }
  static value(node) {
    return {
      src: node.getAttribute('data-src') || '',
      label: node.getAttribute('data-label') || '',
    };
  }
  static renderInner(node) {
    const src = node.getAttribute('data-src') || '';
    const label = node.getAttribute('data-label') || 'Recording';
    if (!src) {
      node.innerHTML = '<div class="ql-audio-empty">🎙️ No recording</div>';
      return;
    }
    node.innerHTML =
      `<div class="ql-audio-row">
         <span class="ql-audio-icon" aria-hidden="true">🎙️</span>
         <span class="ql-audio-label">${label.replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]))}</span>
       </div>
       <audio controls preload="metadata" src="${src}"></audio>`;
  }
}
AudioBlot.blotName = 'audio';
AudioBlot.tagName = 'div';
AudioBlot.className = 'ql-audio';
Quill.register(AudioBlot, true);

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
      ['divider', 'timestamp', 'table'],
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
      table() {
        const q = this.quill;
        const range = q.getSelection(true);
        q.insertEmbed(range.index, 'simpletable', { rows: 3, cols: 3 }, Quill.sources.USER);
        q.setSelection(range.index + 1, Quill.sources.SILENT);
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

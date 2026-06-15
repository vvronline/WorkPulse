/* ─────────────────────────────────────────────────────────
   quillEditorHtml — builds the self-contained HTML document
   that hosts a Quill rich-text editor inside a WebView. It
   loads Quill from a CDN, registers the same custom blots the
   web client uses (divider, callout, checklist, etc.), applies
   a dark theme matching the app, and exposes a JS↔RN bridge:

     RN → WebView (injectJavaScript):
       window.setContents(html)        replace editor HTML
       window.setReadOnly(bool)        toggle editing
       window.execFormat(name, value)  apply a toolbar format

     WebView → RN (postMessage JSON):
       { type: 'ready' }
       { type: 'change', html }        debounced content change
       { type: 'pagelink', id }        internal page-link tapped
   ───────────────────────────────────────────────────────── */

import type { Theme } from "../theme";

export function buildQuillHtml(theme: Theme, initialHtml: string, readOnly: boolean): string {
  // Escape the initial HTML so it can be embedded safely inside a <script>
  // string literal (avoid breaking out of the JS context).
  const safeInitial = JSON.stringify(initialHtml || "");

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no" />
<link href="https://cdn.jsdelivr.net/npm/quill@2/dist/quill.snow.css" rel="stylesheet" />
<style>
  * { -webkit-tap-highlight-color: transparent; box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: ${theme.bg}; color: ${theme.text}; }
  #toolbar {
    position: sticky; top: 0; z-index: 10;
    background: ${theme.bgSecondary};
    border: none;
    border-bottom: 1px solid ${theme.border};
    padding: 6px 8px;
  }
  .ql-toolbar.ql-snow { border: none; }
  .ql-container.ql-snow { border: none; font-size: 16px; }
  .ql-editor {
    min-height: 70vh;
    padding: 16px 18px 120px;
    color: ${theme.text};
    line-height: 1.6;
    caret-color: ${theme.primary};
  }
  .ql-editor.ql-blank::before { color: ${theme.textMuted}; font-style: normal; }
  .ql-editor h1, .ql-editor h2, .ql-editor h3 { color: ${theme.text}; font-weight: 700; }
  .ql-editor a { color: ${theme.primary}; }
  .ql-editor blockquote {
    border-left: 3px solid ${theme.primary};
    padding-left: 12px; color: ${theme.textSecondary}; margin: 8px 0;
  }
  .ql-editor pre.ql-syntax, .ql-editor pre {
    background: ${theme.bgElevated}; color: ${theme.text};
    border-radius: 8px; padding: 12px; overflow-x: auto;
  }
  .ql-editor hr {
    border: none; border-top: 1px solid ${theme.border}; margin: 14px 0;
  }
  /* Toolbar icon colours (dark theme) */
  .ql-snow .ql-stroke { stroke: ${theme.textSecondary}; }
  .ql-snow .ql-fill { fill: ${theme.textSecondary}; }
  .ql-snow .ql-picker { color: ${theme.textSecondary}; }
  .ql-snow.ql-toolbar button:hover .ql-stroke,
  .ql-snow .ql-toolbar button:hover .ql-stroke { stroke: ${theme.primary}; }
  .ql-snow.ql-toolbar button.ql-active .ql-stroke { stroke: ${theme.primary}; }
  .ql-snow.ql-toolbar button.ql-active .ql-fill { fill: ${theme.primary}; }
  .ql-picker-options { background: ${theme.bgElevated}; }
  /* Custom blots */
  .ql-callout {
    border-radius: 8px; padding: 10px 12px; margin: 8px 0;
    background: ${theme.surface}; border: 1px solid ${theme.border};
    border-left: 3px solid ${theme.primary};
  }
  .ql-callout[data-callout="warn"] { border-left-color: ${theme.warning}; }
  .ql-callout[data-callout="success"] { border-left-color: ${theme.success}; }
  .ql-callout[data-callout="tip"] { border-left-color: ${theme.primary}; }
  .ql-pagelink {
    color: ${theme.primary}; text-decoration: underline; cursor: pointer;
  }
  .ql-datechip, .ql-mention {
    background: ${theme.surface}; border-radius: 4px; padding: 0 4px;
    color: ${theme.primary};
  }
  .ql-toggle { border-left: 2px solid ${theme.border}; padding-left: 10px; margin: 6px 0; }
  .ql-simpletable table { border-collapse: collapse; width: 100%; }
  .ql-simpletable th, .ql-simpletable td {
    border: 1px solid ${theme.border}; padding: 6px 8px; color: ${theme.text};
  }
  .ql-audio, .ql-drawio, .ql-math {
    background: ${theme.surface}; border: 1px dashed ${theme.border};
    border-radius: 8px; padding: 10px; margin: 8px 0; color: ${theme.textSecondary};
  }
</style>
</head>
<body>
  <div id="toolbar">
    <span class="ql-formats">
      <select class="ql-header">
        <option value="1"></option>
        <option value="2"></option>
        <option value="3"></option>
        <option selected></option>
      </select>
    </span>
    <span class="ql-formats">
      <button class="ql-bold"></button>
      <button class="ql-italic"></button>
      <button class="ql-underline"></button>
      <button class="ql-strike"></button>
    </span>
    <span class="ql-formats">
      <select class="ql-color"></select>
      <select class="ql-background"></select>
    </span>
    <span class="ql-formats">
      <button class="ql-list" value="ordered"></button>
      <button class="ql-list" value="bullet"></button>
      <button class="ql-list" value="check"></button>
    </span>
    <span class="ql-formats">
      <button class="ql-blockquote"></button>
      <button class="ql-code-block"></button>
      <button class="ql-link"></button>
    </span>
    <span class="ql-formats">
      <button class="ql-divider">―</button>
      <button class="ql-callout">❝</button>
    </span>
    <span class="ql-formats">
      <button class="ql-clean"></button>
    </span>
  </div>
  <div id="editor"></div>

  <script src="https://cdn.jsdelivr.net/npm/quill@2/dist/quill.js"></script>
  <script>
    (function () {
      function post(msg) {
        if (window.ReactNativeWebView) {
          window.ReactNativeWebView.postMessage(JSON.stringify(msg));
        }
      }

      // ── Register custom blots (mirrors web quillConfig) ──
      var BlockEmbed = Quill.import('blots/block/embed');
      var Inline = Quill.import('blots/inline');
      var Block = Quill.import('blots/block');

      function DividerBlot() {}
      var Divider = (function () {
        function D() {}
        return D;
      })();

      // Divider (<hr>)
      class DividerB extends BlockEmbed {}
      DividerB.blotName = 'divider';
      DividerB.tagName = 'hr';
      Quill.register(DividerB, true);

      // Callout (<div class="ql-callout" data-callout="...">)
      class CalloutB extends Block {
        static create(value) {
          var node = super.create();
          node.setAttribute('data-callout', (typeof value === 'string' && value) || 'info');
          return node;
        }
        static formats(node) { return node.getAttribute('data-callout') || 'info'; }
        format(name, value) {
          if (name === 'callout' && value) this.domNode.setAttribute('data-callout', value);
          else super.format(name, value);
        }
      }
      CalloutB.blotName = 'callout';
      CalloutB.tagName = 'div';
      CalloutB.className = 'ql-callout';
      Quill.register(CalloutB, true);

      // Page link (<a class="ql-pagelink" data-page-id>)
      class PageLinkB extends Inline {
        static create(value) {
          var node = super.create();
          var v = typeof value === 'object' ? value : { id: value, title: '' };
          node.setAttribute('data-page-id', v.id || '');
          node.setAttribute('data-page-title', v.title || '');
          node.setAttribute('href', '#');
          node.classList.add('ql-pagelink');
          return node;
        }
        static formats(node) {
          return { id: node.getAttribute('data-page-id') || '', title: node.getAttribute('data-page-title') || '' };
        }
      }
      PageLinkB.blotName = 'pagelink';
      PageLinkB.tagName = 'a';
      PageLinkB.className = 'ql-pagelink';
      Quill.register(PageLinkB, true);

      // ── Initialise Quill ──
      var quill = new Quill('#editor', {
        theme: 'snow',
        readOnly: ${readOnly ? "true" : "false"},
        placeholder: 'Write your note…',
        modules: {
          toolbar: {
            container: '#toolbar',
            handlers: {
              divider: function () {
                var range = this.quill.getSelection(true);
                this.quill.insertText(range.index, '\\n', 'user');
                this.quill.insertEmbed(range.index + 1, 'divider', true, 'user');
                this.quill.setSelection(range.index + 2, 'silent');
              },
              callout: function () {
                var range = this.quill.getSelection(true);
                this.quill.formatLine(range.index, 1, 'callout', 'info', 'user');
              }
            }
          }
        }
      });

      // Seed initial content.
      try {
        var initial = ${safeInitial};
        if (initial) {
          quill.clipboard.dangerouslyPasteHTML(initial, 'silent');
        }
      } catch (e) {}

      // Debounced change notifications.
      var t = null;
      quill.on('text-change', function (delta, old, source) {
        if (source !== 'user') return;
        if (t) clearTimeout(t);
        t = setTimeout(function () {
          post({ type: 'change', html: quill.root.innerHTML });
        }, 400);
      });

      // Internal page-link taps.
      quill.root.addEventListener('click', function (e) {
        var a = e.target && e.target.closest ? e.target.closest('.ql-pagelink') : null;
        if (a) {
          e.preventDefault();
          post({ type: 'pagelink', id: a.getAttribute('data-page-id') || '' });
        }
      });

      // ── RN → WebView API ──
      window.setContents = function (html) {
        try { quill.setText(''); quill.clipboard.dangerouslyPasteHTML(html || '', 'silent'); } catch (e) {}
      };
      window.setReadOnly = function (ro) { quill.enable(!ro); };
      window.execFormat = function (name, value) {
        try { quill.format(name, value, 'user'); } catch (e) {}
      };
      window.getHtml = function () { return quill.root.innerHTML; };

      post({ type: 'ready' });
    })();
  </script>
</body>
</html>`;
}
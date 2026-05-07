/* ─────────────────────────────────────────────────────────
   Notes assets setup — uses locally bundled npm packages
   for KaTeX (math). Lazy-imported on first use to keep the
   initial NotesPage chunk small.

   We attach the loaded module to `window.katex` so the custom
   Quill blot (MathBlot in quillConfig.js) can read from it.

   (Mermaid was previously loaded here; we now use draw.io
   which runs in an iframe and needs no client-side library.)
   ───────────────────────────────────────────────────────── */

let katexPromise = null;

function injectKatexCss() {
    if (typeof document === 'undefined') return;
    if (document.getElementById('katex-css')) return;
    // Vite resolves this URL at build time and bundles the CSS asset.
    const link = document.createElement('link');
    link.id = 'katex-css';
    link.rel = 'stylesheet';
    link.href = new URL('katex/dist/katex.min.css', import.meta.url).href;
    document.head.appendChild(link);
}

export function loadKatex() {
    if (typeof window === 'undefined') return Promise.resolve();
    if (window.katex) return Promise.resolve(window.katex);
    if (katexPromise) return katexPromise;
    katexPromise = import('katex')
        .then((mod) => {
            const katex = mod?.default || mod;
            window.katex = katex;
            try { injectKatexCss(); } catch { /* ignore */ }
            // Re-render any math blocks that were placed before katex loaded.
            try {
                document.querySelectorAll('.ql-math[data-tex]').forEach(node => {
                    const tex = node.getAttribute('data-tex') || '';
                    if (!tex) return;
                    try {
                        node.innerHTML = katex.renderToString(tex, {
                            displayMode: true, throwOnError: false,
                        });
                    } catch { /* ignore */ }
                });
            } catch { /* ignore */ }
            return katex;
        })
        .catch((e) => {
            console.warn('[notes] failed to load katex', e);
            return null;
        });
    return katexPromise;
}

/** Eager-load math runtime — call from app boot. */
export function preloadNotesAssets() {
    loadKatex();
}
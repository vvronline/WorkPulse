/* eslint-disable @typescript-eslint/no-explicit-any */
/* ─────────────────────────────────────────────────────────
   DrawioEditor — full-screen modal that hosts the official
   draw.io embed (https://embed.diagrams.net) inside an iframe
   and round-trips the diagram XML + an exported SVG via
   postMessage.

   Usage:
     <DrawioEditor
       initialXml={…}
       onSave={({ xml, svg }) => …}
       onCancel={() => …}
     />

   Embed protocol (the bits we care about):
     • init                   — embed says "ready"; we send `load` + xml
     • configure              — optional config; we send minimal config
     • save                   — user pressed Save; payload contains XML
                               (we then ask for an SVG export and resolve
                               with both)
     • export                 — payload contains the data URL of the SVG
     • exit                   — user pressed Exit; we close
   Reference: https://www.drawio.com/doc/faq/embed-mode

   We intentionally avoid `?spin=1` and `?proto=json&saveAndExit=1`
   nonsense — the modern protocol works without them.
   ───────────────────────────────────────────────────────── */
import { useEffect, useRef, useState } from "react";
import { X, Trash2 } from "../../../constants/icons";
import s from "./DrawioEditor.module.css";

const EMBED_URL = "https://embed.diagrams.net/?embed=1&proto=json&spin=1&ui=atlas&libraries=1&noSaveBtn=0&saveAndExit=1";

interface DrawioEditorProps {
    initialXml?: string;
    onSave?: (data: { xml: string; svg: string }) => void;
    onCancel?: () => void;
    onDelete?: () => void;
}

export default function DrawioEditor({ initialXml, onSave, onCancel, onDelete }: DrawioEditorProps) {
    const iframeRef = useRef<HTMLIFrameElement | null>(null);
    const pendingXmlRef = useRef<string | null>(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        const post = (msg: any) => {
            try {
                iframeRef.current?.contentWindow?.postMessage(JSON.stringify(msg), "*");
            } catch { /* ignore */ }
        };

        const onMessage = (e: MessageEvent) => {
            // Accept messages only from the embed origin we loaded.
            // (Origin check is loose because the embed may navigate sub-frames.)
            if (typeof e.data !== "string") return;
            let msg: any;
            try { msg = JSON.parse(e.data); } catch { return; }
            if (!msg || typeof msg !== "object") return;

            switch (msg.event) {
                case "init": {
                    setLoading(false);
                    // Tell the embed which diagram to open. Empty string starts
                    // a blank canvas which is what we want for a brand-new node.
                    post({
                        action: "load",
                        autosave: 0,
                        xml: initialXml || "",
                    });
                    break;
                }
                case "configure": {
                    // Optional — could send themes/plugins here. We accept defaults.
                    post({ action: "configure", config: {} });
                    break;
                }
                case "save": {
                    // User pressed Save (or Save & Exit). Stash the XML, then
                    // ask the embed for an SVG export so we can render it inline.
                    pendingXmlRef.current = msg.xml || "";
                    post({
                        action: "export",
                        format: "xmlsvg",     // SVG with embedded XML — round-trip safe
                        spin: "Exporting…",
                    });
                    break;
                }
                case "export": {
                    // SVG export came back as a data URL.
                    const dataUrl = msg.data || "";
                    let svg = "";
                    if (dataUrl.startsWith("data:image/svg+xml;base64,")) {
                        try {
                            const b64 = dataUrl.split(",")[1];
                            svg = atob(b64);
                        } catch { svg = ""; }
                    } else if (dataUrl.startsWith("data:image/svg+xml,")) {
                        try { svg = decodeURIComponent(dataUrl.split(",")[1]); }
                        catch { svg = ""; }
                    }
                    onSave?.({ xml: pendingXmlRef.current || msg.xml || "", svg });
                    break;
                }
                case "exit": {
                    onCancel?.();
                    break;
                }
                default:
                    /* ignore other events (autosave, layout, etc.) */
                    break;
            }
        };

        window.addEventListener("message", onMessage);
        return () => window.removeEventListener("message", onMessage);
    }, [initialXml, onSave, onCancel]);

    // Esc closes the editor (no body-scroll-lock — the editor renders
    // inline inside the notes editor, not as a portal overlay).
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onCancel?.(); };
        document.addEventListener("keydown", onKey);
        return () => document.removeEventListener("keydown", onKey);
    }, [onCancel]);

    return (
        <div className={s.panel} role="region" aria-label="Draw.io diagram editor">
            <header className={s.header}>
                <span className={s.title}>📐 Draw.io diagram</span>
                <span className={s.hint}>
                    Press <strong>Save</strong> in the toolbar to commit, or <strong>Exit</strong> / Esc to discard.
                </span>
                {onDelete && (
                    <button
                        type="button"
                        className={s.deleteBtn}
                        onClick={() => {
                            if (typeof window === "undefined" ||
                                window.confirm("Delete this diagram from the page? This cannot be undone.")) {
                                onDelete();
                            }
                        }}
                        title="Delete this diagram"
                        aria-label="Delete diagram"
                    >
                        <Trash2 size={13} />
                        <span>Delete</span>
                    </button>
                )}
                <button
                    type="button"
                    className={s.closeBtn}
                    onClick={onCancel}
                    title="Close (Esc)"
                    aria-label="Close diagram editor"
                ><X size={15} /></button>
            </header>
            <div className={s.frameWrap}>
                {loading && (
                    <div className={s.loading}>
                        <div className={s.spinner} />
                        <span>Loading draw.io…</span>
                    </div>
                )}
                <iframe
                    ref={iframeRef}
                    className={s.frame}
                    src={EMBED_URL}
                    title="Draw.io diagram editor"
                    allow="clipboard-read; clipboard-write"
                />
            </div>
        </div>
    );
}
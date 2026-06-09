/* eslint-disable @typescript-eslint/no-explicit-any */
/* VersionHistory — slide-in panel showing saved snapshots for a page.
   Now offers two preview modes:
     - Preview  → sanitised rendered HTML
     - Diff     → line-based diff against the *current* page content. */
import React, { useEffect, useMemo, useState, useCallback } from "react";
import DOMPurify from "dompurify";
import { getPageHistory, getHistorySnapshot } from "../../../api";
import { History, X, FileText, RotateCcw, GitBranch } from "../../../constants/icons";
import { lineDiff } from "../notesUtils";
import s from "./VersionHistory.module.css";

function fmtDate(str?: string): string {
    if (!str) return "";
    const d = new Date(str);
    return d.toLocaleString(undefined, {
        month: "short", day: "numeric", year: "numeric",
        hour: "2-digit", minute: "2-digit",
    });
}

interface Snapshot {
    id: any;
    page_title?: string;
    content?: string;
    saved_at?: string;
    [key: string]: unknown;
}

interface VersionHistoryProps {
    pageId: any;
    pageTitle?: string;
    currentContent?: string;
    onRestore: (content: any, title: any) => void;
    onClose: () => void;
}

export default function VersionHistory({ pageId, pageTitle, currentContent, onRestore, onClose }: VersionHistoryProps) {
    const [history, setHistory] = useState<Snapshot[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [preview, setPreview] = useState<Snapshot | null>(null); // { id, page_title, content, saved_at }
    const [previewLoading, setPL] = useState(false);
    const [restoring, setRestoring] = useState(false);
    const [mode, setMode] = useState("preview"); // 'preview' | 'diff'

    useEffect(() => {
        if (!pageId) return;
        setLoading(true);
        setError(null);
        getPageHistory(pageId)
            .then(res => setHistory((res.data as any)?.history || []))
            .catch(() => setError("Could not load history."))
            .finally(() => setLoading(false));
    }, [pageId]);

    const openPreview = useCallback(async (id: any) => {
        setPL(true);
        try {
            const res = await getHistorySnapshot(id);
            setPreview((res.data as any)?.snapshot || null);
        } catch {
            setPreview(null);
        } finally {
            setPL(false);
        }
    }, []);

    const handleRestore = () => {
        if (!preview) return;
        setRestoring(true);
        onRestore(preview.content, preview.page_title);
        onClose();
    };

    const diffRows = useMemo(
        () => preview ? lineDiff(preview.content || "", currentContent || "") : [],
        [preview, currentContent]
    );

    return (
        <div className={s.panel}>
            {/* Panel header */}
            <div className={s.header}>
                <div className={s.headerLeft}>
                    <History size={14} className={s.icon} aria-hidden="true" />
                    <span className={s.headerTitle}>Version History</span>
                </div>
                <button className={s.closeBtn} onClick={onClose} title="Close history" aria-label="Close history">
                    <X size={14} />
                </button>
            </div>

            <div className={s.body}>
                {/* Left: version list */}
                <div className={s.list}>
                    <p className={s.listLabel}>
                        Saved versions of <strong>{pageTitle || "this page"}</strong>
                    </p>

                    {loading && (
                        <div className={s.loadingWrap}><div className={s.spinner} /></div>
                    )}

                    {error && <div className={s.empty}>{error}</div>}

                    {!loading && !error && history.length === 0 && (
                        <div className={s.empty}>
                            No versions saved yet — changes are recorded automatically every time you save.
                        </div>
                    )}

                    {!loading && !error && history.map((row, i) => (
                        <button
                            key={row.id}
                            className={`${s.versionRow} ${preview?.id === row.id ? s.versionRowActive : ""}`}
                            onClick={() => openPreview(row.id)}
                        >
                            <div className={s.versionMeta}>
                                <span className={s.versionDate}>{fmtDate(row.saved_at)}</span>
                                {i === 0 && <span className={s.latestBadge}>Latest</span>}
                            </div>
                            <span className={s.versionTitle}>{row.page_title || "Untitled"}</span>
                        </button>
                    ))}
                </div>

                {/* Right: preview pane */}
                <div className={s.preview}>
                    {!preview && !previewLoading && (
                        <div className={s.previewEmpty}>
                            <FileText size={36} strokeWidth={1.5} aria-hidden="true" />
                            <p>Select a version to preview it</p>
                        </div>
                    )}

                    {previewLoading && (
                        <div className={s.loadingWrap}><div className={s.spinner} /></div>
                    )}

                    {preview && !previewLoading && (
                        <>
                            <div className={s.previewHeader}>
                                <div>
                                    <div className={s.previewTitle}>{preview.page_title || "Untitled"}</div>
                                    <div className={s.previewDate}>{fmtDate(preview.saved_at)}</div>
                                </div>
                                <div className={s.previewActions}>
                                    <div className={s.modeToggle} role="tablist" aria-label="View mode">
                                        <button
                                            type="button"
                                            className={`${s.modeBtn} ${mode === "preview" ? s.modeBtnActive : ""}`}
                                            onClick={() => setMode("preview")}
                                            role="tab"
                                            aria-selected={mode === "preview"}
                                        >
                                            <FileText size={11} /> Preview
                                        </button>
                                        <button
                                            type="button"
                                            className={`${s.modeBtn} ${mode === "diff" ? s.modeBtnActive : ""}`}
                                            onClick={() => setMode("diff")}
                                            role="tab"
                                            aria-selected={mode === "diff"}
                                        >
                                            <GitBranch size={11} /> Diff vs current
                                        </button>
                                    </div>
                                    <button
                                        className={`btn btn-primary btn-sm ${restoring ? s.restoring : ""}`}
                                        onClick={handleRestore}
                                        disabled={restoring}
                                        title="Replace current content with this version"
                                    >
                                        {restoring ? (
                                            "Restoring…"
                                        ) : (
                                            <>
                                                <RotateCcw size={12} style={{ verticalAlign: "-2px", marginRight: 4 }} />
                                                Restore
                                            </>
                                        )}
                                    </button>
                                </div>
                            </div>
                            {mode === "preview" ? (
                                <div
                                    className={s.previewContent}
                                    dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(preview.content || "") || "<em>Empty page</em>" }}
                                />
                            ) : (
                                <div className={s.diffView}>
                                    {diffRows.length === 0 || diffRows.every((r: any) => r.type === "eq") ? (
                                        <div className={s.diffEmpty}>No differences vs current content.</div>
                                    ) : (
                                        <pre className={s.diffPre}>
                                            {diffRows.map((r: any, i: number) => (
                                                <div
                                                    key={i}
                                                    className={`${s.diffLine} ${r.type === "add" ? s.diffAdd
                                                        : r.type === "del" ? s.diffDel
                                                            : s.diffEq
                                                        }`}
                                                >
                                                    <span className={s.diffMarker}>
                                                        {r.type === "add" ? "+" : r.type === "del" ? "−" : " "}
                                                    </span>
                                                    <span className={s.diffText}>{r.text || " "}</span>
                                                </div>
                                            ))}
                                        </pre>
                                    )}
                                </div>
                            )}
                        </>
                    )}
                </div>
            </div>
        </div>
    );
}
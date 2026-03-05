/* VersionHistory — slide-in panel showing saved snapshots for a page */
import React, { useEffect, useState, useCallback } from 'react';
import { getPageHistory, getHistorySnapshot } from '../../../api';
import s from './VersionHistory.module.css';

function fmtDate(str) {
  if (!str) return '';
  const d = new Date(str);
  return d.toLocaleString(undefined, {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

function stripHtml(html) {
  return html ? html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : '';
}

export default function VersionHistory({ pageId, pageTitle, onRestore, onClose }) {
  const [history, setHistory]       = useState([]);
  const [loading, setLoading]       = useState(true);
  const [error, setError]           = useState(null);
  const [preview, setPreview]       = useState(null); // { id, page_title, content, saved_at }
  const [previewLoading, setPL]     = useState(false);
  const [restoring, setRestoring]   = useState(false);

  useEffect(() => {
    if (!pageId) return;
    setLoading(true);
    setError(null);
    getPageHistory(pageId)
      .then(res => setHistory(res.data?.history || []))
      .catch(() => setError('Could not load history.'))
      .finally(() => setLoading(false));
  }, [pageId]);

  const openPreview = useCallback(async (id) => {
    setPL(true);
    try {
      const res = await getHistorySnapshot(id);
      setPreview(res.data?.snapshot || null);
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

  return (
    <div className={s.panel}>
      {/* Panel header */}
      <div className={s.header}>
        <div className={s.headerLeft}>
          <svg viewBox="0 0 16 16" fill="currentColor" className={s.icon}>
            <path d="M8 1a7 7 0 100 14A7 7 0 008 1zM0 8a8 8 0 1116 0A8 8 0 010 8zm8-4a.75.75 0 01.75.75v3.69l2.28 1.32a.75.75 0 01-.75 1.3l-2.5-1.44A.75.75 0 017.25 9V4.75A.75.75 0 018 4z"/>
          </svg>
          <span className={s.headerTitle}>Version History</span>
        </div>
        <button className={s.closeBtn} onClick={onClose} title="Close history">
          <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M2 2l10 10M12 2L2 12"/>
          </svg>
        </button>
      </div>

      <div className={s.body}>
        {/* Left: version list */}
        <div className={s.list}>
          <p className={s.listLabel}>
            Saved versions of <strong>{pageTitle || 'this page'}</strong>
          </p>

          {loading && (
            <div className={s.loadingWrap}><div className={s.spinner}/></div>
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
              className={`${s.versionRow} ${preview?.id === row.id ? s.versionRowActive : ''}`}
              onClick={() => openPreview(row.id)}
            >
              <div className={s.versionMeta}>
                <span className={s.versionDate}>{fmtDate(row.saved_at)}</span>
                {i === 0 && <span className={s.latestBadge}>Latest</span>}
              </div>
              <span className={s.versionTitle}>{row.page_title || 'Untitled'}</span>
            </button>
          ))}
        </div>

        {/* Right: preview pane */}
        <div className={s.preview}>
          {!preview && !previewLoading && (
            <div className={s.previewEmpty}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M9 12h6M9 8h6m-9 8h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v8a2 2 0 002 2z"/>
              </svg>
              <p>Select a version to preview it</p>
            </div>
          )}

          {previewLoading && (
            <div className={s.loadingWrap}><div className={s.spinner}/></div>
          )}

          {preview && !previewLoading && (
            <>
              <div className={s.previewHeader}>
                <div>
                  <div className={s.previewTitle}>{preview.page_title || 'Untitled'}</div>
                  <div className={s.previewDate}>{fmtDate(preview.saved_at)}</div>
                </div>
                <button
                  className={`btn btn-primary btn-sm ${restoring ? s.restoring : ''}`}
                  onClick={handleRestore}
                  disabled={restoring}
                  title="Replace current content with this version"
                >
                  {restoring ? 'Restoring…' : '↩ Restore this version'}
                </button>
              </div>
              <div
                className={s.previewContent}
                dangerouslySetInnerHTML={{ __html: preview.content || '<em>Empty page</em>' }}
              />
            </>
          )}
        </div>
      </div>
    </div>
  );
}

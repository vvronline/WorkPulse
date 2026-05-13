import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link2, Trash2, Copy, Check, X, ExternalLink } from '../../../constants/icons';
import { Globe } from 'lucide-react';
import { getNoteShare, createNoteShare, revokeNoteShare } from '../../../api';
import s from './ShareNoteModal.module.css';

/**
 * ShareNoteModal — manage a public read-only share link for the active page.
 *
 * - On open, fetches the current share token (if any).
 * - User can mint a new link, copy the URL, open it in a new tab, or revoke.
 * - The link is unguessable (32 random bytes, base64url) and is stable for the
 *   life of the page — re-shares of the same page reuse the existing token.
 */
export default function ShareNoteModal({ page, isOpen, onClose }) {
    const [loading, setLoading] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [token, setToken] = useState(null);
    const [url, setUrl] = useState('');
    const [copied, setCopied] = useState(false);

    useEffect(() => {
        if (!isOpen || !page?.id) return;
        let cancelled = false;
        setLoading(true); setError(''); setCopied(false);
        getNoteShare(page.id)
            .then(({ data }) => {
                if (cancelled) return;
                setToken(data.token);
                setUrl(data.token ? buildUrl(data.token) : '');
            })
            .catch(err => { if (!cancelled) setError(err.response?.data?.error || 'Failed to load share state'); })
            .finally(() => { if (!cancelled) setLoading(false); });
        return () => { cancelled = true; };
    }, [isOpen, page?.id]);

    const buildUrl = (t) => `${window.location.origin}/n/${t}`;

    const create = async () => {
        if (!page?.id) return;
        setBusy(true); setError(''); setCopied(false);
        try {
            const { data } = await createNoteShare(page.id);
            setToken(data.token);
            setUrl(data.url || buildUrl(data.token));
        } catch (err) {
            setError(err.response?.data?.error || 'Failed to create share link');
        } finally {
            setBusy(false);
        }
    };

    const revoke = async () => {
        if (!page?.id || !token) return;
        if (!window.confirm('Revoke this share link? Anyone with the URL will lose access.')) return;
        setBusy(true); setError('');
        try {
            await revokeNoteShare(page.id);
            setToken(null);
            setUrl('');
            setCopied(false);
        } catch (err) {
            setError(err.response?.data?.error || 'Failed to revoke link');
        } finally {
            setBusy(false);
        }
    };

    const copy = async () => {
        if (!url) return;
        try {
            await navigator.clipboard.writeText(url);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
        } catch {
            // Older browsers / Electron offline — fall back to legacy execCommand
            const ta = document.createElement('textarea');
            ta.value = url;
            ta.style.position = 'fixed';
            ta.style.opacity = '0';
            document.body.appendChild(ta);
            ta.select();
            try { document.execCommand('copy'); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* ignore */ }
            ta.remove();
        }
    };

    if (!isOpen) return null;

    const content = (
        <div className={s.backdrop} onMouseDown={onClose}>
            <div className={s.modal} onMouseDown={e => e.stopPropagation()}>
                <header className={s.head}>
                    <div className={s.headInner}>
                        <Globe size={16} className={s.headIcon} />
                        <div>
                            <h3 className={s.title}>Share page</h3>
                            <p className={s.subtitle}>Anyone with the link can read this page.</p>
                        </div>
                    </div>
                    <button className={s.close} onClick={onClose} aria-label="Close">
                        <X size={16} />
                    </button>
                </header>

                <div className={s.body}>
                    <div className={s.pageRow}>
                        <span className={s.pageLabel}>Page:</span>
                        <span className={s.pageTitle}>{page?.title || 'Untitled'}</span>
                    </div>

                    {error && <div className={s.error}>{error}</div>}

                    {loading ? (
                        <div className={s.state}>Loading…</div>
                    ) : token ? (
                        <>
                            <div className={s.urlBox}>
                                <Link2 size={14} className={s.urlIcon} />
                                <input
                                    className={s.urlInput}
                                    value={url}
                                    readOnly
                                    onFocus={e => e.target.select()}
                                />
                                <button className={s.copyBtn} onClick={copy} title="Copy link">
                                    {copied ? <Check size={14} /> : <Copy size={14} />}
                                </button>
                            </div>
                            <p className={s.hint}>
                                Anyone who opens this link can <strong>view</strong> the page — they cannot
                                edit, comment, or see other pages. Revoke at any time.
                            </p>
                            <div className={s.actions}>
                                <a
                                    href={url}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className={`btn btn-secondary btn-sm ${s.linkBtn}`}
                                >
                                    <ExternalLink size={13} /> Preview in new tab
                                </a>
                                <button
                                    className="btn btn-secondary btn-sm"
                                    onClick={revoke}
                                    disabled={busy}
                                >
                                    <Trash2 size={13} /> {busy ? 'Revoking…' : 'Revoke link'}
                                </button>
                            </div>
                        </>
                    ) : (
                        <div className={s.empty}>
                            <p className={s.emptyText}>
                                This page is private. Create a share link to give read-only access to anyone
                                — without requiring them to log in.
                            </p>
                            <button
                                className="btn btn-primary"
                                onClick={create}
                                disabled={busy || !page?.id}
                            >
                                <Link2 size={13} /> {busy ? 'Creating…' : 'Create share link'}
                            </button>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );

    return createPortal(content, document.body);
}
import React, { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { getPublicNote } from "../api";
import s from "./PublicNote.module.css";

/**
 * PublicNote — read-only public viewer for a shared note page.
 *
 * Mounted at /n/:token (no auth required). Resolves the token via
 * /api/public/notes/:token, which loads the note from the originating
 * tenant's DB and returns title + content + org branding.
 */
export default function PublicNote() {
    const { token } = useParams();
    const [data, setData] = useState<any>(null);
    const [error, setError] = useState("");
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        let cancelled = false;
        setLoading(true);
        setError("");
        getPublicNote(token as any)
            .then(res => { if (!cancelled) setData(res.data); })
            .catch((err: any) => {
                if (cancelled) return;
                const msg = err?.response?.data?.error || "This share link is no longer active.";
                setError(msg);
            })
            .finally(() => { if (!cancelled) setLoading(false); });
        return () => { cancelled = true; };
    }, [token]);

    const accent = data?.branding?.accent_color || "#6366f1";

    return (
        <div className={s.page} style={{ "--accent": accent } as React.CSSProperties}>
            <div className={s.shell}>
                <header className={s.header}>
                    <div className={s.brand}>
                        {data?.branding?.logo_url
                            ? <img src={data.branding.logo_url} alt={data?.orgName || ""} className={s.logo} />
                            : <span className={s.brandName}>{data?.orgName || "Loops"}</span>}
                    </div>
                    {data?.sharedAt && (
                        <span className={s.sharedAt}>
                            Shared {new Date(data.sharedAt).toLocaleDateString()}
                        </span>
                    )}
                </header>

                {loading && <div className={s.state}>Loading…</div>}

                {error && (
                    <div className={s.errorCard}>
                        <h1 className={s.errorTitle}>Link unavailable</h1>
                        <p>{error}</p>
                        <p className={s.muted}>
                            The owner may have revoked this link, archived the note, or
                            the link may be invalid.
                        </p>
                    </div>
                )}

                {data && !error && (
                    <article className={s.article}>
                        <h1 className={s.title}>{data.title || "Untitled"}</h1>
                        {data.updatedAt && (
                            <div className={s.meta}>
                                Last edited {new Date(data.updatedAt).toLocaleString()}
                            </div>
                        )}
                        <div
                            className={s.content}
                            // The content is HTML produced by the org's own
                            // notebook editor (Quill). It contains no
                            // user-controlled scripts because the editor only
                            // emits a known whitelist of formatting tags.
                            dangerouslySetInnerHTML={{ __html: data.content || "<p><em>This page is empty.</em></p>" }}
                        />
                    </article>
                )}

                <footer className={s.footer}>
                    <span className={s.footerText}>Powered by</span>
                    <Link to="/" className={s.footerLink}>Loops</Link>
                </footer>
            </div>
        </div>
    );
}
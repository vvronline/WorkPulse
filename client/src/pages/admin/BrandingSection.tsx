import React, { useState, useEffect, useRef, useCallback } from "react";
import { Upload, Trash2, Loader2, Check } from "lucide-react";
import {
    getBranding,
    updateBrandingAccent,
    uploadBrandingLogo,
    deleteBrandingLogo,
} from "../../api";
import { useBranding } from "../../BrandingContext";
import { serverURL } from "../../api";
import s from "./BrandingSection.module.css";

const DEFAULT_ACCENT = "#2383e2";
const PRESETS = ["#2383e2", "#6366f1", "#0ea5e9", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6", "#ec4899"];

interface BrandingData {
    logo_url: string | null;
    accent_color: string;
    [key: string]: unknown;
}

interface BrandingSectionProps {
    canEdit?: boolean;
}

/**
 * BrandingSection — logo + accent color editor.
 *
 * UX model: changes to logo, accent, or "remove logo" are STAGED locally
 * and only persisted when the user clicks "Save changes". This means the
 * user can:
 *   - Upload a new logo without changing the accent (or vice versa)
 *   - Preview the changes side-by-side before committing
 *   - Cancel to discard everything in one click
 *
 * The save button is always present but disabled until at least one of
 * (logo, removeLogo, accent) is actually different from the persisted
 * server state.
 */
export default function BrandingSection({ canEdit }: BrandingSectionProps) {
    const { refresh } = useBranding() as any;

    // Persisted server state.
    const [data, setData] = useState<BrandingData>({ logo_url: null, accent_color: DEFAULT_ACCENT });
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState("");
    const [savedFlash, setSavedFlash] = useState(false);

    // Staged (uncommitted) changes.
    const [draftAccent, setDraftAccent] = useState(DEFAULT_ACCENT);
    const [draftLogoFile, setDraftLogoFile] = useState<File | null>(null);   // File | null
    const [draftLogoPreview, setDraftLogoPreview] = useState<string | null>(null); // ObjectURL
    const [removeLogo, setRemoveLogo] = useState(false);

    const fileRef = useRef<HTMLInputElement | null>(null);

    const reload = useCallback(() => {
        setLoading(true);
        getBranding()
            .then(({ data }) => {
                const row = data as BrandingData;
                setData(row);
                setDraftAccent(row.accent_color || DEFAULT_ACCENT);
                setDraftLogoFile(null);
                setDraftLogoPreview(null);
                setRemoveLogo(false);
            })
            .catch(() => setError("Failed to load branding"))
            .finally(() => setLoading(false));
    }, []);

    useEffect(() => { reload(); }, [reload]);

    // Free any in-flight blob URL on full unmount only. We deliberately
    // do NOT depend on `draftLogoPreview` here — under React StrictMode
    // the cleanup would fire twice in dev and revoke the URL right after
    // creating it, leaving the preview <img> with a broken src.
    // Per-change cleanup is handled inline by `stageFile` / `stageRemove`
    // / `cancel` / `save` before they assign a new URL.
    const lastBlobRef = useRef<string | null>(null);
    useEffect(() => { lastBlobRef.current = draftLogoPreview; }, [draftLogoPreview]);
    useEffect(() => () => {
        if (lastBlobRef.current) URL.revokeObjectURL(lastBlobRef.current);
    }, []);

    const accentDirty = draftAccent.toLowerCase() !== (data.accent_color || "").toLowerCase();
    const logoDirty = !!draftLogoFile || removeLogo;
    const dirty = accentDirty || logoDirty;
    const accentValid = /^#[0-9a-fA-F]{6}$/.test(draftAccent);

    const stageFile = (file?: File) => {
        if (!file || !canEdit) return;
        if (file.size > 2 * 1024 * 1024) {
            setError("Logo must be under 2 MB");
            return;
        }
        if (draftLogoPreview) URL.revokeObjectURL(draftLogoPreview);
        setDraftLogoFile(file);
        setDraftLogoPreview(URL.createObjectURL(file));
        setRemoveLogo(false);
        setError("");
    };

    const stageRemove = () => {
        if (!canEdit) return;
        if (draftLogoPreview) {
            URL.revokeObjectURL(draftLogoPreview);
            setDraftLogoPreview(null);
        }
        setDraftLogoFile(null);
        setRemoveLogo(true);
        setError("");
    };

    const cancel = () => {
        if (saving) return;
        setDraftAccent(data.accent_color || DEFAULT_ACCENT);
        if (draftLogoPreview) URL.revokeObjectURL(draftLogoPreview);
        setDraftLogoFile(null);
        setDraftLogoPreview(null);
        setRemoveLogo(false);
        setError("");
        if (fileRef.current) fileRef.current.value = "";
    };

    const save = async () => {
        if (!canEdit || !dirty || saving) return;
        if (!accentValid) {
            setError("Accent color must be a 6-digit hex (e.g. #2383e2)");
            return;
        }
        setSaving(true); setError("");
        try {
            // Persist logo changes first so subsequent reads reflect the new state.
            let nextRow: BrandingData = data;
            if (draftLogoFile) {
                const { data: row } = await uploadBrandingLogo(draftLogoFile);
                nextRow = row as BrandingData;
            } else if (removeLogo) {
                await deleteBrandingLogo();
                nextRow = { ...nextRow, logo_url: null };
            }
            if (accentDirty) {
                const { data: row } = await updateBrandingAccent(draftAccent);
                nextRow = { ...nextRow, accent_color: (row as BrandingData).accent_color };
            }
            setData(nextRow);
            setDraftAccent(nextRow.accent_color || DEFAULT_ACCENT);
            if (draftLogoPreview) URL.revokeObjectURL(draftLogoPreview);
            setDraftLogoFile(null);
            setDraftLogoPreview(null);
            setRemoveLogo(false);
            if (fileRef.current) fileRef.current.value = "";
            // Push the change app-wide (navbar logo, CSS variables).
            refresh();
            setSavedFlash(true);
            setTimeout(() => setSavedFlash(false), 2200);
        } catch (err: any) {
            setError(err.response?.data?.error || "Failed to save branding");
        } finally {
            setSaving(false);
        }
    };

    // Effective preview: staged > server > none.
    const effectiveLogoSrc = (() => {
        if (draftLogoPreview) return draftLogoPreview;
        if (removeLogo) return null;
        if (data.logo_url) {
            return data.logo_url.startsWith("http") ? data.logo_url : `${serverURL}${data.logo_url}`;
        }
        return null;
    })();

    if (loading) return <div className={s.loading}>Loading branding…</div>;

    return (
        <div className={s.wrap}>
            {error && <div className={s.error}>{error}</div>}
            {savedFlash && (
                <div className={s.savedBar}>
                    <Check size={14} /> Branding saved
                </div>
            )}

            {/* Logo */}
            <div className={s.row}>
                <div className={s.label}>Organization logo</div>
                <div className={s.logoControls}>
                    <div className={s.logoPreview}>
                        {effectiveLogoSrc ? (
                            <img src={effectiveLogoSrc} alt="Org logo" className={s.logoImg} />
                        ) : (
                            <div className={s.logoEmpty}>No logo set</div>
                        )}
                    </div>
                    <div className={s.logoBtns}>
                        <input
                            type="file"
                            accept="image/png,image/jpeg,image/gif,image/svg+xml,image/webp"
                            ref={fileRef}
                            onChange={e => stageFile(e.target.files?.[0])}
                            style={{ display: "none" }}
                            disabled={!canEdit || saving}
                        />
                        <button
                            type="button"
                            className="btn btn-secondary btn-sm"
                            onClick={() => fileRef.current?.click()}
                            disabled={!canEdit || saving}
                        >
                            <Upload size={14} />{" "}
                            {effectiveLogoSrc ? "Replace" : "Choose logo"}
                        </button>
                        {effectiveLogoSrc && (
                            <button
                                type="button"
                                className="btn btn-secondary btn-sm"
                                onClick={stageRemove}
                                disabled={!canEdit || saving}
                            >
                                <Trash2 size={14} /> Remove
                            </button>
                        )}
                        {(draftLogoFile || removeLogo) && (
                            <span className={s.pendingTag}>
                                {removeLogo ? "Removal pending — click Save to apply"
                                    : "New logo selected — click Save to apply"}
                            </span>
                        )}
                        <p className={s.hint}>
                            PNG, JPG, SVG, GIF or WebP — max 2 MB. Recommended height 40&nbsp;px.
                        </p>
                    </div>
                </div>
            </div>

            {/* Accent color */}
            <div className={s.row}>
                <div className={s.label}>Accent color</div>
                <div className={s.accentControls}>
                    <div className={s.presets}>
                        {PRESETS.map(c => (
                            <button
                                key={c}
                                type="button"
                                title={c}
                                className={`${s.swatch} ${draftAccent.toLowerCase() === c ? s.swatchActive : ""}`}
                                style={{ background: c }}
                                onClick={() => canEdit && setDraftAccent(c)}
                                disabled={!canEdit || saving}
                            />
                        ))}
                    </div>
                    <div className={s.customRow}>
                        <input
                            type="color"
                            value={draftAccent}
                            onChange={e => setDraftAccent(e.target.value)}
                            disabled={!canEdit || saving}
                            className={s.colorInput}
                        />
                        <input
                            type="text"
                            value={draftAccent}
                            onChange={e => {
                                const v = e.target.value;
                                if (/^#?[0-9a-fA-F]{0,6}$/.test(v)) {
                                    setDraftAccent(v.startsWith("#") ? v : `#${v}`);
                                }
                            }}
                            maxLength={7}
                            disabled={!canEdit || saving}
                            className={s.hexInput}
                            placeholder={DEFAULT_ACCENT}
                        />
                    </div>
                    <p className={s.hint}>
                        The accent color is applied to buttons, links, badges, and outgoing email templates.
                    </p>
                </div>
            </div>

            {/* Preview */}
            <div className={s.previewBlock} style={{ "--preview-accent": draftAccent } as React.CSSProperties}>
                <div className={s.previewLabel}>Live preview</div>
                <div className={s.previewCard}>
                    {effectiveLogoSrc && <img src={effectiveLogoSrc} alt="" className={s.previewLogo} />}
                    <h4 className={s.previewHeading}>Sample heading</h4>
                    <p className={s.previewText}>
                        This is how content will look with your accent color. The button below uses the same hue.
                    </p>
                    <button type="button" className={s.previewBtn}>Primary action</button>
                </div>
            </div>

            {/* Sticky save row */}
            {canEdit && (
                <div className={s.actionsBar}>
                    <button
                        type="button"
                        className="btn btn-primary"
                        onClick={save}
                        disabled={!dirty || saving || !accentValid}
                    >
                        {saving
                            ? <><Loader2 size={14} className={s.spin} /> Saving…</>
                            : "Save changes"}
                    </button>
                    <button
                        type="button"
                        className="btn btn-secondary"
                        onClick={cancel}
                        disabled={!dirty || saving}
                    >
                        Cancel
                    </button>
                    {!dirty && !savedFlash && (
                        <span className={s.cleanTag}>No unsaved changes</span>
                    )}
                </div>
            )}

            {!canEdit && (
                <p className={s.readOnly}>
                    You don't have permission to edit branding. Contact your HR admin or super admin.
                </p>
            )}
        </div>
    );
}
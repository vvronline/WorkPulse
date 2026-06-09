import React, { useState, useEffect, useCallback, useRef } from "react";
import { Mail, RotateCcw, Save, Eye, ChevronRight, AlertCircle } from "lucide-react";
import ConfirmDialog from "../../components/common/ConfirmDialog";
import {
    getEmailTemplates, updateEmailTemplate, revertEmailTemplate, previewEmailTemplate,
} from "../../api";
import s from "./EmailTemplatesSection.module.css";

/**
 * Human-readable labels for each built-in template key. Keep in sync with
 * server/utils/mailer.js#TEMPLATE_KEYS.
 */
const TEMPLATE_LABELS: Record<string, string> = {
    leaveApproved: "Leave approved",
    leaveRejected: "Leave rejected",
    leaveRevoked: "Leave revoked",
    taskAssigned: "Task assigned",
    mention: "You were mentioned",
    manualEntryApproved: "Manual entry approved",
    manualEntryRejected: "Manual entry rejected",
    meetingScheduled: "Meeting scheduled",
    meetingUpdated: "Meeting updated",
    meetingCancelled: "Meeting cancelled",
};

interface EmailTemplate {
    template_key: string;
    subject: string;
    body_html: string;
    enabled: boolean;
    is_overridden?: boolean;
    builtin_subject?: string;
    builtin_body_html?: string;
    [key: string]: unknown;
}

interface EmailTemplatesSectionProps {
    canEdit?: boolean;
}

/**
 * EmailTemplatesSection — manage per-template subject + body overrides for
 * the org. Selecting a template on the left opens an editor on the right
 * with a live-rendered preview pane below the editor.
 *
 * Tokens supported in the body: {{accent}} → org accent color (hex).
 *
 * Other dynamic content (recipient name, leave date, task title, …) is
 * inlined by the SERVER at send time using sample arguments specific to each
 * template. The preview uses the same sample args.
 */
export default function EmailTemplatesSection({ canEdit }: EmailTemplatesSectionProps) {
    const [list, setList] = useState<EmailTemplate[]>([]);
    const [loading, setLoading] = useState(true);
    const [selected, setSelected] = useState<string | null>(null);

    const reload = useCallback(() => {
        setLoading(true);
        getEmailTemplates()
            .then(({ data }) => {
                const templates = (data as any).templates || [];
                setList(templates);
                setSelected(prev => prev || (templates?.[0]?.template_key ?? null));
            })
            .catch(() => setList([]))
            .finally(() => setLoading(false));
    }, []);

    useEffect(() => { reload(); }, [reload]);

    const current = list.find(t => t.template_key === selected) || null;

    if (loading) return <div className={s.loading}>Loading email templates…</div>;
    if (!list.length) return <div className={s.loading}>No email templates available.</div>;

    return (
        <div className={s.layout}>
            <ul className={s.list}>
                {list.map(t => (
                    <li key={t.template_key}>
                        <button
                            type="button"
                            className={`${s.listItem} ${selected === t.template_key ? s.listItemActive : ""}`}
                            onClick={() => setSelected(t.template_key)}
                        >
                            <Mail size={14} className={s.listIcon} />
                            <span className={s.listLabel}>
                                {TEMPLATE_LABELS[t.template_key] || t.template_key}
                            </span>
                            {t.is_overridden && <span className={s.dot} title="Customised" />}
                            {!t.enabled && <span className={s.disabled}>off</span>}
                            <ChevronRight size={12} className={s.chevron} />
                        </button>
                    </li>
                ))}
            </ul>

            <div className={s.editor}>
                {current && (
                    <TemplateEditor
                        key={current.template_key}
                        template={current}
                        canEdit={canEdit}
                        onSaved={reload}
                        onReverted={reload}
                    />
                )}
            </div>
        </div>
    );
}

interface TemplateEditorProps {
    template: EmailTemplate;
    canEdit?: boolean;
    onSaved: () => void;
    onReverted: () => void;
}

function TemplateEditor({ template, canEdit, onSaved, onReverted }: TemplateEditorProps) {
    const [subject, setSubject] = useState(template.subject);
    const [body, setBody] = useState(template.body_html);
    const [enabled, setEnabled] = useState(template.enabled);
    const [previewHtml, setPreviewHtml] = useState("");
    const [previewLoading, setPreviewLoading] = useState(false);
    const [saving, setSaving] = useState(false);
    const [reverting, setReverting] = useState(false);
    const [savedFlash, setSavedFlash] = useState(false);
    const [error, setError] = useState("");
    const [confirmRevert, setConfirmRevert] = useState(false);
    const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const dirty =
        subject !== template.subject ||
        body !== template.body_html ||
        enabled !== template.enabled;

    // Live preview — debounced so we don't hammer the server while typing.
    const refreshPreview = useCallback(() => {
        setPreviewLoading(true);
        previewEmailTemplate(template.template_key, { subject, body_html: body })
            .then(({ data }) => setPreviewHtml((data as any).html || ""))
            .catch(() => setPreviewHtml(""))
            .finally(() => setPreviewLoading(false));
    }, [template.template_key, subject, body]);

    useEffect(() => {
        if (debounceRef.current) clearTimeout(debounceRef.current);
        debounceRef.current = setTimeout(refreshPreview, 350);
        return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
    }, [refreshPreview]);

    const save = async () => {
        if (!dirty || !canEdit) return;
        setSaving(true); setError("");
        try {
            await updateEmailTemplate(template.template_key, { subject, body_html: body, enabled });
            setSavedFlash(true);
            setTimeout(() => setSavedFlash(false), 1500);
            onSaved();
        } catch (err: any) {
            setError(err.response?.data?.error || "Failed to save");
        } finally {
            setSaving(false);
        }
    };

    const revert = () => {
        if (!template.is_overridden || !canEdit) return;
        setConfirmRevert(true);
    };

    const doRevert = async () => {
        setConfirmRevert(false);
        setReverting(true); setError("");
        try {
            await revertEmailTemplate(template.template_key);
            onReverted();
        } catch (err: any) {
            setError(err.response?.data?.error || "Failed to revert");
        } finally {
            setReverting(false);
        }
    };

    const restoreBuiltin = () => {
        // Swap the editor draft back to the built-in (without saving).
        setSubject(template.builtin_subject || "");
        setBody(template.builtin_body_html || "");
    };

    return (
        <div className={s.editorInner}>
            <div className={s.editorHead}>
                <div>
                    <h3 className={s.editorTitle}>{TEMPLATE_LABELS[template.template_key] || template.template_key}</h3>
                    <p className={s.editorMeta}>
                        Template key: <code>{template.template_key}</code>
                        {template.is_overridden && (
                            <> · <span className={s.metaCustom}>Customised</span></>
                        )}
                    </p>
                </div>
                <div className={s.editorHeadActions}>
                    <label className={s.toggleRow}>
                        <input
                            type="checkbox"
                            checked={enabled}
                            onChange={e => setEnabled(e.target.checked)}
                            disabled={!canEdit}
                        />
                        <span>Send this email</span>
                    </label>
                </div>
            </div>

            {error && <div className={s.error}><AlertCircle size={14} /> {error}</div>}

            <div className={s.fieldGroup}>
                <label className={s.fieldLabel}>Subject</label>
                <input
                    type="text"
                    value={subject}
                    maxLength={200}
                    onChange={e => setSubject(e.target.value)}
                    disabled={!canEdit}
                    className={s.input}
                />
            </div>

            <div className={s.fieldGroup}>
                <div className={s.fieldLabelRow}>
                    <label className={s.fieldLabel}>Body (HTML)</label>
                    <button
                        type="button"
                        className={s.linkBtn}
                        onClick={restoreBuiltin}
                        disabled={!canEdit}
                        title="Replace the editor with the built-in template (does NOT save until you click Save)"
                    >
                        Insert built-in template
                    </button>
                </div>
                <textarea
                    value={body}
                    maxLength={30000}
                    onChange={e => setBody(e.target.value)}
                    disabled={!canEdit}
                    className={s.textarea}
                    rows={12}
                    spellCheck={false}
                />
                <div className={s.tokenHint}>
                    Tokens: <code>{"{{accent}}"}</code> = your accent color. Recipient name, dates, task titles
                    and other dynamic values are inserted automatically — see the preview below.
                </div>
            </div>

            <div className={s.actions}>
                <button
                    type="button"
                    className="btn btn-primary"
                    onClick={save}
                    disabled={!canEdit || !dirty || saving}
                >
                    <Save size={14} /> {saving ? "Saving…" : savedFlash ? "Saved ✓" : "Save changes"}
                </button>
                {template.is_overridden && (
                    <button
                        type="button"
                        className="btn btn-secondary"
                        onClick={revert}
                        disabled={!canEdit || reverting}
                    >
                        <RotateCcw size={14} /> {reverting ? "Reverting…" : "Revert to built-in"}
                    </button>
                )}
                {dirty && (
                    <span className={s.dirtyHint}>Unsaved changes</span>
                )}
            </div>

            <div className={s.previewWrap}>
                <div className={s.previewHeader}>
                    <Eye size={13} /> Live preview {previewLoading && <span className={s.previewLoading}>updating…</span>}
                </div>
                <div className={s.previewSubject}><strong>Subject:</strong> {subject}</div>
                <div className={s.previewBody} dangerouslySetInnerHTML={{ __html: previewHtml }} />
                <p className={s.previewNote}>
                    Sample data is used to fill template variables. The actual emails sent to your team will use
                    the real recipient name, dates, task titles, etc.
                </p>
            </div>

            <ConfirmDialog
                isOpen={confirmRevert}
                title="Revert to built-in template"
                message="Revert to the built-in template? Your custom subject and body will be deleted. This cannot be undone."
                confirmText="Revert"
                onConfirm={doRevert}
                onCancel={() => setConfirmRevert(false)}
                isDanger
            />
        </div>
    );
}
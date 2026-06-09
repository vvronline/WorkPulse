/**
 * CustomFieldRenderer & CustomFieldsEditor — render and edit task custom field
 * values based on the org's CustomFieldsContext definitions.
 *
 * <CustomFieldRenderer field value /> — read-only badge / value renderer.
 * <CustomFieldsEditor taskId values onChange onSave /> — full editor block
 *     used inside the task detail modal. `values` is { fieldId: value }.
 *
 * Field types: text, number, date, select, multiselect, checkbox, url.
 */
import React, { useState, useEffect, useCallback } from "react";
import { useCustomFields } from "../../CustomFieldsContext";
import {
    getTaskCustomFieldValues, updateTaskCustomFieldValues,
} from "../../api";
import { Save, Loader2 } from "lucide-react";
import s from "./CustomFields.module.css";

interface FieldOption {
    value: string | number;
    label: string;
}

interface CustomFieldDefinition {
    id: number | string;
    label: string;
    field_type: string;
    description?: string;
    is_required?: boolean;
    show_on_card?: boolean;
    options?: FieldOption[];
    applies_to_types?: Array<number | string>;
    [key: string]: unknown;
}

type FieldValue = unknown;
type ValuesMap = Record<string, FieldValue>;

// ── Read-only value renderer ───────────────────────────────────────────────

export function CustomFieldRenderer({ field, value }: { field?: CustomFieldDefinition | null; value: FieldValue }) {
    if (!field) return null;
    if (value === null || value === undefined || value === "" ||
        (Array.isArray(value) && value.length === 0)) {
        return <span className={s.muted}>—</span>;
    }
    switch (field.field_type) {
        case "checkbox":
            return <span className={s.checkValue}>{value ? "✓ Yes" : "— No"}</span>;
        case "date":
            return <span>{value as React.ReactNode}</span>;
        case "number":
            return <span>{value as React.ReactNode}</span>;
        case "url": {
            const strVal = String(value);
            const href = /^https?:\/\//i.test(strVal) ? strVal : `https://${strVal}`;
            return (
                <a className={s.link} href={href} target="_blank" rel="noreferrer noopener">
                    {strVal}
                </a>
            );
        }
        case "select": {
            const opt = (field.options || []).find((o) => String(o.value) === String(value));
            return <span className={s.pill}>{opt?.label || (value as React.ReactNode)}</span>;
        }
        case "multiselect": {
            const arr = Array.isArray(value) ? value : [value];
            return (
                <span className={s.pillRow}>
                    {arr.map((v) => {
                        const opt = (field.options || []).find((o) => String(o.value) === String(v));
                        return <span key={String(v)} className={s.pill}>{opt?.label || String(v)}</span>;
                    })}
                </span>
            );
        }
        default:
            return <span>{String(value)}</span>;
    }
}

// ── Per-field input ────────────────────────────────────────────────────────

function FieldInput({ field, value, onChange, disabled }: {
    field: CustomFieldDefinition;
    value: FieldValue;
    onChange: (v: FieldValue) => void;
    disabled?: boolean;
}) {
    const ft = field.field_type;
    switch (ft) {
        case "text":
            return (
                <input
                    type="text"
                    className={s.input}
                    value={(value as string) ?? ""}
                    placeholder={field.label}
                    disabled={disabled}
                    onChange={(e) => onChange(e.target.value)}
                />
            );
        case "url":
            return (
                <input
                    type="url"
                    className={s.input}
                    value={(value as string) ?? ""}
                    placeholder="https://…"
                    disabled={disabled}
                    onChange={(e) => onChange(e.target.value)}
                />
            );
        case "number":
            return (
                <input
                    type="number"
                    className={s.input}
                    value={(value as number) ?? ""}
                    disabled={disabled}
                    onChange={(e) => {
                        const v = e.target.value;
                        onChange(v === "" ? null : Number(v));
                    }}
                />
            );
        case "date":
            return (
                <input
                    type="date"
                    className={s.input}
                    value={(value as string) ?? ""}
                    disabled={disabled}
                    onChange={(e) => onChange(e.target.value || null)}
                />
            );
        case "checkbox":
            return (
                <label className={s.checkbox}>
                    <input
                        type="checkbox"
                        checked={!!value}
                        disabled={disabled}
                        onChange={(e) => onChange(e.target.checked)}
                    />
                    <span>{field.label}</span>
                </label>
            );
        case "select":
            return (
                <select
                    className={s.input}
                    value={(value as string) ?? ""}
                    disabled={disabled}
                    onChange={(e) => onChange(e.target.value || null)}
                >
                    <option value="">—</option>
                    {(field.options || []).map((o) => (
                        <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                </select>
            );
        case "multiselect": {
            const arr = Array.isArray(value) ? value : [];
            const toggle = (v: string | number) => {
                const next = arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v];
                onChange(next);
            };
            return (
                <div className={s.multiBox}>
                    {(field.options || []).map((o) => (
                        <label key={o.value} className={s.multiOpt}>
                            <input
                                type="checkbox"
                                checked={arr.includes(o.value)}
                                disabled={disabled}
                                onChange={() => toggle(o.value)}
                            />
                            <span>{o.label}</span>
                        </label>
                    ))}
                </div>
            );
        }
        default:
            return null;
    }
}

// ── Full editor block for the task detail modal ────────────────────────────

interface CustomFieldsEditorProps {
    taskId?: number | string | null;
    workItemTypeId?: number | string | null;
    canEdit?: boolean;
    autoLoad?: boolean;
    /** Called after successful save with the new values map. */
    onSaved?: (values: ValuesMap) => void;
}

export function CustomFieldsEditor({
    taskId,
    workItemTypeId = null,
    canEdit = true,
    autoLoad = true,
    onSaved,
}: CustomFieldsEditorProps) {
    const { fields } = useCustomFields() as unknown as { fields: CustomFieldDefinition[] };
    const [values, setValues] = useState<ValuesMap>({});
    const [original, setOriginal] = useState<ValuesMap>({});
    const [loading, setLoading] = useState(false);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState("");

    // Filter fields by applies_to_types — empty array means "applies to all".
    const visible = fields.filter((f) => {
        const applies = Array.isArray(f.applies_to_types) ? f.applies_to_types : [];
        if (applies.length === 0) return true;
        if (!workItemTypeId) return true;
        return applies.includes(workItemTypeId);
    });

    const load = useCallback(async () => {
        if (!taskId || visible.length === 0) return;
        setLoading(true);
        try {
            const r = await getTaskCustomFieldValues(taskId);
            const v = (r.data && (r.data as { values?: ValuesMap }).values) || {};
            setValues(v);
            setOriginal(v);
            setError("");
        } catch (e: any) {
            setError(e?.response?.data?.error || "Failed to load custom fields");
        } finally {
            setLoading(false);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [taskId, visible.length]);

    useEffect(() => { if (autoLoad) load(); }, [load, autoLoad]);

    const dirty = JSON.stringify(values) !== JSON.stringify(original);

    const setOne = (fieldId: number | string, val: FieldValue) => {
        setValues((prev) => ({ ...prev, [fieldId]: val }));
    };

    const save = async () => {
        if (!taskId || saving) return;
        // Required-field check
        const missing = visible.filter((f) => f.is_required).filter((f) => {
            const v = values[f.id];
            if (f.field_type === "checkbox") return false; // checkbox always has a value
            if (Array.isArray(v)) return v.length === 0;
            return v === null || v === undefined || v === "";
        });
        if (missing.length > 0) {
            setError(`Required: ${missing.map((f) => f.label).join(", ")}`);
            return;
        }
        setSaving(true);
        try {
            const r = await updateTaskCustomFieldValues(taskId, values);
            const fresh = (r.data && (r.data as { values?: ValuesMap }).values) || {};
            setValues(fresh);
            setOriginal(fresh);
            setError("");
            if (onSaved) onSaved(fresh);
        } catch (e: any) {
            setError(e?.response?.data?.error || "Failed to save custom fields");
        } finally {
            setSaving(false);
        }
    };

    if (visible.length === 0) return null;

    return (
        <div className={s.editorBlock}>
            <div className={s.editorHead}>
                <div className={s.editorTitle}>Custom fields</div>
                {dirty && canEdit && (
                    <button
                        type="button"
                        className="btn btn-primary btn-sm"
                        onClick={save}
                        disabled={saving}
                    >
                        {saving ? <Loader2 size={13} className={s.spin} /> : <Save size={13} />}
                        {saving ? " Saving…" : " Save"}
                    </button>
                )}
            </div>
            {error && <div className={s.error}>{error}</div>}
            {loading ? (
                <div className={s.loading}>Loading…</div>
            ) : (
                <div className={s.fieldGrid}>
                    {visible.map((f) => (
                        <div key={f.id} className={s.fieldRow}>
                            {f.field_type !== "checkbox" && (
                                <label className={s.fieldLabel}>
                                    {f.label}
                                    {f.is_required && <span className={s.required}>*</span>}
                                </label>
                            )}
                            {f.description && f.field_type !== "checkbox" && (
                                <div className={s.fieldDesc}>{f.description}</div>
                            )}
                            <FieldInput
                                field={f}
                                value={values[f.id]}
                                onChange={(v) => setOne(f.id, v)}
                                disabled={!canEdit}
                            />
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}

// ── Read-only summary row (used on cards / detail view) ────────────────────

export function CustomFieldsSummary({ values, onlyShowOnCard = false }: { values?: ValuesMap | null; onlyShowOnCard?: boolean }) {
    const { fields } = useCustomFields() as unknown as { fields: CustomFieldDefinition[] };
    if (!fields.length || !values) return null;
    const list = fields.filter((f) => {
        if (onlyShowOnCard && !f.show_on_card) return false;
        const v = values[f.id];
        if (v === null || v === undefined || v === "" ||
            (Array.isArray(v) && v.length === 0)) return false;
        return true;
    });
    if (list.length === 0) return null;
    return (
        <div className={s.summaryRow}>
            {list.map((f) => (
                <span key={f.id} className={s.summaryItem}>
                    <span className={s.summaryLabel}>{f.label}:</span>
                    <CustomFieldRenderer field={f} value={values[f.id]} />
                </span>
            ))}
        </div>
    );
}
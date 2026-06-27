/**
 * CustomFieldsSection — admin UI to manage tenant-customisable task fields.
 *
 * Lives inside Org Settings (own anchor section). Lists all defined fields,
 * lets admins add/edit/delete them, and configures the field type, options
 * (for select/multiselect), and which work-item types it applies to.
 */
import React, { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  getCustomFieldsAll,
  createCustomField,
  updateCustomField,
  deleteCustomField,
} from "../api";
import { useAgileConfig } from "../AgileConfigContext";
import { useCustomFields } from "../CustomFieldsContext";
import { Plus, Pencil, Trash2, X, Save, Loader2 } from "lucide-react";
import s from "../components/customFields/CustomFields.module.css";

interface FieldTypeDef {
  value: string;
  label: string;
}

const FIELD_TYPES: FieldTypeDef[] = [
  { value: "text", label: "Single-line text" },
  { value: "number", label: "Number" },
  { value: "date", label: "Date" },
  { value: "select", label: "Select (single)" },
  { value: "multiselect", label: "Select (multiple)" },
  { value: "checkbox", label: "Checkbox" },
  { value: "url", label: "URL" },
];

interface FieldOption {
  value: string;
  label: string;
}

interface CustomFieldForm {
  label: string;
  field_type: string;
  description: string;
  is_required: boolean;
  show_on_card: boolean;
  is_active: boolean;
  options: FieldOption[];
  applies_to_types: any[];
}

const blankForm: CustomFieldForm = {
  label: "",
  field_type: "text",
  description: "",
  is_required: false,
  show_on_card: false,
  is_active: true,
  options: [{ value: "", label: "" }],
  applies_to_types: [],
};

interface CustomFieldsSectionProps {
  canEdit?: boolean;
}

const EMPTY_ROWS: any[] = [];

export default function CustomFieldsSection({
  canEdit = true,
}: CustomFieldsSectionProps) {
  const { workItemTypes } = useAgileConfig() as any;
  const { refresh: refreshFields } = useCustomFields() as unknown as {
    refresh: () => Promise<void>;
  };
  const queryClient = useQueryClient();
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [editingId, setEditingId] = useState<string | number | null>(null); // null = closed, 'new' = new, number = edit
  const [form, setForm] = useState<CustomFieldForm>(blankForm);

  const {
    data: rows = EMPTY_ROWS,
    isLoading: loading,
    error: queryError,
  } = useQuery({
    queryKey: ["custom-fields", "all"],
    queryFn: async () => {
      const r = await getCustomFieldsAll();
      return Array.isArray(r.data) ? r.data : [];
    },
  });

  const displayError =
    error ||
    (queryError
      ? (queryError as any)?.response?.data?.error ||
        "Failed to load custom fields"
      : "");

  const startNew = () => {
    setEditingId("new");
    setForm({ ...blankForm, options: [{ value: "", label: "" }] });
  };

  const startEdit = (row: any) => {
    setEditingId(row.id);
    setForm({
      label: row.label || "",
      field_type: row.field_type || "text",
      description: row.description || "",
      is_required: !!row.is_required,
      show_on_card: !!row.show_on_card,
      is_active: row.is_active !== false,
      options:
        Array.isArray(row.options) && row.options.length > 0
          ? row.options.map((o: any) => ({
              value: o.value || "",
              label: o.label || "",
            }))
          : [{ value: "", label: "" }],
      applies_to_types: Array.isArray(row.applies_to_types)
        ? row.applies_to_types
        : [],
    });
  };

  const cancel = () => {
    setEditingId(null);
    setForm(blankForm);
    setError("");
  };

  const setF = (k: keyof CustomFieldForm, v: any) =>
    setForm((prev) => ({ ...prev, [k]: v }));

  const setOption = (idx: number, key: keyof FieldOption, val: string) => {
    setForm((prev) => ({
      ...prev,
      options: prev.options.map((o, i) =>
        i === idx ? { ...o, [key]: val } : o,
      ),
    }));
  };
  const addOption = () => {
    setForm((prev) => ({
      ...prev,
      options: [...prev.options, { value: "", label: "" }],
    }));
  };
  const removeOption = (idx: number) => {
    setForm((prev) => ({
      ...prev,
      options: prev.options.filter((_, i) => i !== idx),
    }));
  };

  const toggleAppliesTo = (id: any) => {
    setForm((prev) => ({
      ...prev,
      applies_to_types: prev.applies_to_types.includes(id)
        ? prev.applies_to_types.filter((x) => x !== id)
        : [...prev.applies_to_types, id],
    }));
  };

  const save = async () => {
    if (!form.label.trim()) {
      setError("Label is required");
      return;
    }
    const payload: any = {
      label: form.label.trim(),
      field_type: form.field_type,
      description: form.description?.trim() || null,
      is_required: !!form.is_required,
      show_on_card: !!form.show_on_card,
      is_active: !!form.is_active,
      applies_to_types: form.applies_to_types,
    };
    if (form.field_type === "select" || form.field_type === "multiselect") {
      const cleaned = form.options
        .map((o) => ({
          value: String(o.value || o.label || "").trim(),
          label: String(o.label || o.value || "").trim(),
        }))
        .filter((o) => o.value);
      if (cleaned.length === 0) {
        setError("Select fields need at least one option");
        return;
      }
      payload.options = cleaned;
    }
    setSaving(true);
    try {
      if (editingId === "new") {
        await createCustomField(payload);
      } else {
        await updateCustomField(editingId as any, payload);
      }
      await queryClient.invalidateQueries({
        queryKey: ["custom-fields", "all"],
      });
      await refreshFields();
      cancel();
    } catch (e: any) {
      setError(e?.response?.data?.error || "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (row: any) => {
    if (
      !window.confirm(
        `Delete custom field "${row.label}"? Existing values on tasks will be lost.`,
      )
    )
      return;
    try {
      await deleteCustomField(row.id);
      await queryClient.invalidateQueries({
        queryKey: ["custom-fields", "all"],
      });
      await refreshFields();
    } catch (e: any) {
      setError(e?.response?.data?.error || "Delete failed");
    }
  };

  const isSelectType =
    form.field_type === "select" || form.field_type === "multiselect";

  return (
    <div className={s.adminWrap}>
      {displayError && <div className={s.error}>{displayError}</div>}

      <div className={s.adminToolbar}>
        <div className={s.helpText}>
          Add tenant-specific fields that appear on every task — extra metadata
          your workflow needs (Component, Customer, External ID, etc.).
        </div>
        {canEdit && editingId === null && (
          <button className="btn btn-primary btn-sm" onClick={startNew}>
            <Plus
              size={13}
              style={{ marginRight: 4, verticalAlign: "middle" }}
            />
            New field
          </button>
        )}
      </div>

      {editingId !== null && (
        <div className={s.formCard}>
          <div className={s.formGrid}>
            <div>
              <label className={s.fieldLabel}>Label</label>
              <input
                className={s.input}
                value={form.label}
                onChange={(e) => setF("label", e.target.value)}
                placeholder="e.g. Component"
                autoFocus
              />
            </div>
            <div>
              <label className={s.fieldLabel}>Type</label>
              <select
                className={s.input}
                value={form.field_type}
                onChange={(e) => setF("field_type", e.target.value)}
              >
                {FIELD_TYPES.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </select>
            </div>
            <div style={{ gridColumn: "1 / -1" }}>
              <label className={s.fieldLabel}>Description (optional)</label>
              <input
                className={s.input}
                value={form.description}
                onChange={(e) => setF("description", e.target.value)}
                placeholder="Helper text shown beneath the field"
              />
            </div>
          </div>

          {isSelectType && (
            <div>
              <label className={s.fieldLabel}>Options</label>
              <div className={s.optionsList}>
                {form.options.map((o, i) => (
                  <div key={i} className={s.optionRow}>
                    <input
                      className={s.input}
                      value={o.label}
                      placeholder="Display label"
                      onChange={(e) => setOption(i, "label", e.target.value)}
                    />
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      onClick={() => removeOption(i)}
                      disabled={form.options.length === 1}
                    >
                      <X size={12} />
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={addOption}
                >
                  <Plus
                    size={12}
                    style={{ marginRight: 4, verticalAlign: "middle" }}
                  />
                  Add option
                </button>
              </div>
            </div>
          )}

          {workItemTypes && workItemTypes.length > 0 && (
            <div>
              <label className={s.fieldLabel}>Applies to work item types</label>
              <div className={s.helpText} style={{ marginBottom: 4 }}>
                Leave all unchecked to apply to every type.
              </div>
              <div className={s.multiBox} style={{ maxHeight: "none" }}>
                {workItemTypes.map((t: any) => (
                  <label key={t.id} className={s.multiOpt}>
                    <input
                      type="checkbox"
                      checked={form.applies_to_types.includes(t.id)}
                      onChange={() => toggleAppliesTo(t.id)}
                    />
                    <span>{t.name}</span>
                  </label>
                ))}
              </div>
            </div>
          )}

          <div className={s.formGrid}>
            <label className={s.checkbox}>
              <input
                type="checkbox"
                checked={form.is_required}
                onChange={(e) => setF("is_required", e.target.checked)}
              />
              <span>Required</span>
            </label>
            <label className={s.checkbox}>
              <input
                type="checkbox"
                checked={form.show_on_card}
                onChange={(e) => setF("show_on_card", e.target.checked)}
              />
              <span>Show on task card</span>
            </label>
            <label className={s.checkbox}>
              <input
                type="checkbox"
                checked={form.is_active}
                onChange={(e) => setF("is_active", e.target.checked)}
              />
              <span>Active</span>
            </label>
          </div>

          <div className={s.formActions}>
            <button
              className="btn btn-secondary btn-sm"
              onClick={cancel}
              disabled={saving}
            >
              Cancel
            </button>
            <button
              className="btn btn-primary btn-sm"
              onClick={save}
              disabled={saving}
            >
              {saving ? (
                <Loader2 size={13} className={s.spin} />
              ) : (
                <Save size={13} />
              )}
              {saving
                ? " Saving…"
                : editingId === "new"
                  ? " Create field"
                  : " Save changes"}
            </button>
          </div>
        </div>
      )}

      {loading ? (
        <div className={s.loading}>Loading…</div>
      ) : rows.length === 0 ? (
        <div className={s.adminEmpty}>
          No custom fields yet. Click <strong>New field</strong> to add one.
        </div>
      ) : (
        <table className={s.adminTable}>
          <thead>
            <tr>
              <th>Label</th>
              <th>Key</th>
              <th>Type</th>
              <th>Required</th>
              <th>On card</th>
              <th>Active</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td>{r.label}</td>
                <td>
                  <code style={{ fontSize: "0.75rem" }}>{r.key}</code>
                </td>
                <td>
                  <span className={s.typeBadge}>{r.field_type}</span>
                </td>
                <td>{r.is_required ? "✓" : "—"}</td>
                <td>{r.show_on_card ? "✓" : "—"}</td>
                <td>{r.is_active ? "✓" : "—"}</td>
                <td>
                  <div className={s.rowActions}>
                    {canEdit && (
                      <>
                        <button
                          className="btn btn-secondary btn-sm"
                          onClick={() => startEdit(r)}
                          title="Edit"
                        >
                          <Pencil size={12} />
                        </button>
                        <button
                          className="btn btn-danger btn-sm"
                          onClick={() => handleDelete(r)}
                          title="Delete"
                        >
                          <Trash2 size={12} />
                        </button>
                      </>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

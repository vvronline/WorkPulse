import React, { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Tag } from "lucide-react";
import { useAutoDismiss } from "../../hooks/useAutoDismiss";
import ConfirmDialog from "../../components/common/ConfirmDialog";
import {
  getTaskLabelsManage,
  createTaskLabel,
  updateTaskLabel,
  deleteTaskLabel,
} from "../../api";
import s from "../Admin.module.css";
import tl from "./TaskLabels.module.css";
import sf from "./AdminForms.module.css";
import su from "./AdminUtils.module.css";

const PRESET_COLORS = [
  "#0ea5e9",
  "#ef4444",
  "#f59e0b",
  "#10b981",
  "#3b82f6",
  "#8b5cf6",
  "#ec4899",
  "#14b8a6",
  "#f97316",
  "#64748b",
];

const EMPTY_LABELS: any[] = [];

export default function TaskLabelsTab() {
  const queryClient = useQueryClient();
  const { data: labels = EMPTY_LABELS, isLoading: loading } = useQuery({
    queryKey: ["admin", "taskLabels"],
    queryFn: async () => (await getTaskLabelsManage()).data as any[],
  });
  const [name, setName] = useState("");
  const [color, setColor] = useState("#0ea5e9");
  const [editId, setEditId] = useState<any>(null);
  const [editName, setEditName] = useState("");
  const [editColor, setEditColor] = useState("#0ea5e9");
  const [error, setError] = useAutoDismiss("") as [string, (v: string) => void];
  const [success, setSuccess] = useAutoDismiss("") as [
    string,
    (v: string) => void,
  ];
  const [deleteId, setDeleteId] = useState<any>(null);

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ["admin", "taskLabels"] });

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    try {
      await createTaskLabel({ name, color });
      setName("");
      setColor("#0ea5e9");
      setSuccess("Label created");
      invalidate();
    } catch (err: any) {
      setError(err.response?.data?.error || "Failed to create label");
    }
  };

  const startEdit = (label: any) => {
    setEditId(label.id);
    setEditName(label.name);
    setEditColor(label.color);
  };

  const saveEdit = async () => {
    if (!editName.trim()) return;
    try {
      await updateTaskLabel(editId, { name: editName, color: editColor });
      setEditId(null);
      setSuccess("Label updated");
      invalidate();
    } catch (err: any) {
      setError(err.response?.data?.error || "Failed to update label");
    }
  };

  const confirmDelete = async () => {
    const id = deleteId;
    setDeleteId(null);
    if (id == null) return;
    try {
      await deleteTaskLabel(id);
      setSuccess("Label deleted");
      invalidate();
    } catch {
      setError("Failed to delete label");
    }
  };

  if (loading)
    return (
      <div className="loading-spinner">
        <div className="spinner" />
      </div>
    );

  return (
    <div className={s.section}>
      <h3 className={sf.sectionTitle}>
        <Tag size={15} style={{ marginRight: 6, verticalAlign: "middle" }} />
        Task Labels
      </h3>
      <p className={su["section-desc-muted"]}>
        Create labels that members of your organization can use to categorize
        tasks.
      </p>

      {error && <div className="error-msg error-msg-mb">{error}</div>}
      {success && <div className={`success-msg ${su["mb-1"]}`}>{success}</div>}

      <form onSubmit={handleCreate} className={tl["label-form"]}>
        <div className={`form-group ${tl["label-form-group"]}`}>
          <label>Label Name</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Bug, Feature, Urgent"
            maxLength={30}
            required
          />
        </div>
        <div className={`form-group ${tl["form-group-compact"]}`}>
          <label>Color</label>
          <div className={tl["color-picker-row"]}>
            {PRESET_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setColor(c)}
                className={tl["color-swatch"]}
                style={{
                  border:
                    color === c
                      ? "2px solid var(--text)"
                      : "2px solid transparent",
                  background: c,
                }}
              />
            ))}
            <input
              type="color"
              value={color}
              onChange={(e) => setColor(e.target.value)}
              className={tl["color-input"]}
            />
          </div>
        </div>
        <button
          type="submit"
          className={`btn btn-primary ${tl["btn-add-label"]}`}
        >
          Add Label
        </button>
      </form>

      {labels.length === 0 ? (
        <p className={tl["empty-message"]}>No labels yet. Create one above!</p>
      ) : (
        <div className={su["overflow-auto"]}>
          <table className={s.table}>
            <thead>
              <tr>
                <th>Label</th>
                <th>Created By</th>
                <th className={tl["col-actions"]}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {labels.map((label) => (
                <tr key={label.id}>
                  <td>
                    {editId === label.id ? (
                      <div className={tl["edit-label-row"]}>
                        <input
                          type="text"
                          value={editName}
                          onChange={(e) => setEditName(e.target.value)}
                          maxLength={30}
                          className={tl["edit-label-input"]}
                        />
                        <input
                          type="color"
                          value={editColor}
                          onChange={(e) => setEditColor(e.target.value)}
                          className={tl["color-input"]}
                        />
                      </div>
                    ) : (
                      <span className={tl["label-display"]}>
                        <span
                          className={tl["label-badge"]}
                          style={{ background: label.color }}
                        >
                          {label.name}
                        </span>
                      </span>
                    )}
                  </td>
                  <td className={su["text-sm-muted"]}>
                    {label.created_by_username || "—"}
                  </td>
                  <td>
                    {editId === label.id ? (
                      <div className={su["actions-row"]}>
                        <button
                          className="btn btn-primary btn-sm"
                          onClick={saveEdit}
                        >
                          Save
                        </button>
                        <button
                          className="btn btn-secondary btn-sm"
                          onClick={() => setEditId(null)}
                        >
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <div className={su["actions-row"]}>
                        <button
                          className="btn btn-secondary btn-sm"
                          onClick={() => startEdit(label)}
                        >
                          Edit
                        </button>
                        <button
                          className="btn btn-danger btn-sm"
                          onClick={() => setDeleteId(label.id)}
                        >
                          Delete
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <ConfirmDialog
        isOpen={deleteId != null}
        title="Delete Label"
        message="Delete this label? It will be removed from all tasks. This cannot be undone."
        confirmText="Delete"
        onConfirm={confirmDelete}
        onCancel={() => setDeleteId(null)}
        isDanger
      />
    </div>
  );
}

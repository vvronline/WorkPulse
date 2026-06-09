import React, { useState, useEffect, useCallback, useMemo } from "react";
import {
    Plus,
    Save,
    Trash2,
    AlertCircle,
    Lock,
    X,
    Edit3,
    ShieldCheck,
    Users,
} from "lucide-react";
import {
    getOrgRoles,
    createOrgRole,
    updateOrgRole,
    deleteOrgRole,
} from "../../api";
import { useRoleLabels } from "../../RoleLabelsContext";
import { useToast } from "../../components/common/Toast";
import s from "./OrgRoleLabels.module.css";

/**
 * OrgRoleLabels — admin UI for managing the tenant's custom roles.
 *
 * Tenants get a fully customisable role catalogue. Each row stores:
 *   - role_key          (immutable, lowercase a-z0-9_, 1..40 chars)
 *   - label             (display name, 1..40 chars)
 *   - description       (optional, ≤200 chars)
 *   - color             (#RRGGBB swatch)
 *   - permission_level  (1=employee, 2=team_lead, 3=manager, 4=hr_admin)
 *   - is_system         (canonical seeded rows — UI warns before deleting)
 *
 * The two top-level system roles (super_admin / platform_admin) are NOT
 * managed here; they're shown read-only at the bottom for context.
 */

const HEX_RE = /^#[0-9a-fA-F]{6}$/;
const KEY_RE = /^[a-z][a-z0-9_]{0,39}$/;

interface PermissionLevel {
    value: number;
    label: string;
    hint: string;
}

const PERMISSION_LEVELS: PermissionLevel[] = [
    {
        value: 1,
        label: "Standard member",
        hint: "Basic access only — equivalent to employee.",
    },
    {
        value: 2,
        label: "Team lead",
        hint: "Can review and manage their own team.",
    },
    {
        value: 3,
        label: "Manager",
        hint: "Approves leaves and tasks; manages a department.",
    },
    {
        value: 4,
        label: "HR admin",
        hint: "Full people-ops: invite/remove/manage org members.",
    },
];

const PERMISSION_LEVEL_LABEL: Record<number, string> = Object.fromEntries(
    PERMISSION_LEVELS.map((p) => [p.value, p.label]),
);

interface OrgRoleLabelsProps {
    canEdit?: boolean;
}

interface RoleDraft {
    label: string;
    description: string;
    color: string;
    permission_level: number;
}

interface AddDraft {
    role_key: string;
    label: string;
    description: string;
    color: string;
    permission_level: number;
}

export default function OrgRoleLabels({ canEdit }: OrgRoleLabelsProps) {
    const { setRoles: pushToCtx } = useRoleLabels() as any;
    const toast = useToast() as any;

    const [roles, setRoles] = useState<any[]>([]);
    const [loading, setLoading] = useState(true);
    const [savingKey, setSavingKey] = useState<string | null>(null); // role_key currently being saved
    const [deletingKey, setDeletingKey] = useState<string | null>(null);
    const [editing, setEditing] = useState<Record<string, RoleDraft>>({}); // { role_key: { label, description, color, permission_level } }
    const [adding, setAdding] = useState<AddDraft | null>(null); // { role_key, label, description, color, permission_level } | null
    const [creating, setCreating] = useState(false);

    const load = useCallback(() => {
        setLoading(true);
        getOrgRoles()
            .then((res) => {
                const list = Array.isArray((res.data as any)?.roles)
                    ? (res.data as any).roles
                    : [];
                setRoles(list);
                pushToCtx(list);
            })
            .catch(() => toast.error("Failed to load roles"))
            .finally(() => setLoading(false));
    }, [pushToCtx, toast]);

    useEffect(() => {
        load();
    }, [load]);

    const sorted = useMemo(
        () =>
            [...roles].sort(
                (a, b) =>
                    (a.sort_order ?? 0) - (b.sort_order ?? 0) ||
                    a.role_key.localeCompare(b.role_key),
            ),
        [roles],
    );

    // ── helpers ────────────────────────────────────────────────────
    const startEdit = (role: any) => {
        setEditing((prev) => ({
            ...prev,
            [role.role_key]: {
                label: role.label,
                description: role.description || "",
                color: role.color || "#6366f1",
                permission_level: role.permission_level,
            },
        }));
    };

    const cancelEdit = (role_key: string) => {
        setEditing((prev) => {
            const { [role_key]: _drop, ...rest } = prev;
            return rest;
        });
    };

    const updateField = (
        role_key: string,
        field: keyof RoleDraft,
        value: any,
    ) => {
        setEditing((prev) => ({
            ...prev,
            [role_key]: { ...prev[role_key], [field]: value },
        }));
    };

    // ── save existing role ─────────────────────────────────────────
    const saveRole = async (role: any) => {
        const draft = editing[role.role_key];
        if (!draft) return;
        const label = (draft.label || "").trim();
        if (!label || label.length > 40)
            return toast.error("Label must be 1..40 chars");
        if (draft.color && !HEX_RE.test(draft.color))
            return toast.error("Color must be #RRGGBB");
        if (![1, 2, 3, 4].includes(Number(draft.permission_level)))
            return toast.error("Invalid permission level");

        setSavingKey(role.role_key);
        try {
            const res = await updateOrgRole(role.role_key, {
                label,
                description: draft.description?.trim() || null,
                color: draft.color,
                permission_level: Number(draft.permission_level),
            });
            const list = Array.isArray((res.data as any)?.roles)
                ? (res.data as any).roles
                : [];
            setRoles(list);
            pushToCtx(list);
            cancelEdit(role.role_key);
            toast.success(`Updated "${label}"`);
        } catch (err: any) {
            toast.error(err?.response?.data?.error || "Failed to update role");
        } finally {
            setSavingKey(null);
        }
    };

    // ── delete role ────────────────────────────────────────────────
    const deleteRole = async (role: any) => {
        const ok = window.confirm(
            `Delete role "${role.label}" (${role.role_key})?` +
                (role.is_system
                    ? "\n\nThis is one of the system-seeded roles. You should keep at least one role per permission level so members can be invited."
                    : "") +
                "\n\nThis cannot be undone.",
        );
        if (!ok) return;
        setDeletingKey(role.role_key);
        try {
            const res = await deleteOrgRole(role.role_key);
            const list = Array.isArray((res.data as any)?.roles)
                ? (res.data as any).roles
                : [];
            setRoles(list);
            pushToCtx(list);
            toast.success(`Deleted "${role.label}"`);
        } catch (err: any) {
            toast.error(err?.response?.data?.error || "Failed to delete role");
        } finally {
            setDeletingKey(null);
        }
    };

    // ── add new role ───────────────────────────────────────────────
    const startAdd = () => {
        setAdding({
            role_key: "",
            label: "",
            description: "",
            color: "#6366f1",
            permission_level: 1,
        });
    };

    const cancelAdd = () => setAdding(null);

    const updateAddField = (field: keyof AddDraft, value: any) => {
        setAdding((prev) => (prev ? { ...prev, [field]: value } : prev));
    };

    const submitAdd = async () => {
        if (!adding) return;
        const role_key = (adding.role_key || "").trim().toLowerCase();
        const label = (adding.label || "").trim();
        if (!KEY_RE.test(role_key)) {
            return toast.error(
                "Key must be lowercase letters/numbers/underscores, start with a letter (1..40 chars)",
            );
        }
        if (!label || label.length > 40)
            return toast.error("Label must be 1..40 chars");
        if (adding.color && !HEX_RE.test(adding.color))
            return toast.error("Color must be #RRGGBB");
        if (![1, 2, 3, 4].includes(Number(adding.permission_level)))
            return toast.error("Invalid permission level");

        setCreating(true);
        try {
            const res = await createOrgRole({
                role_key,
                label,
                description: adding.description?.trim() || null,
                color: adding.color,
                permission_level: Number(adding.permission_level),
            });
            const list = Array.isArray((res.data as any)?.roles)
                ? (res.data as any).roles
                : [];
            setRoles(list);
            pushToCtx(list);
            setAdding(null);
            toast.success(`Created role "${label}"`);
        } catch (err: any) {
            toast.error(err?.response?.data?.error || "Failed to create role");
        } finally {
            setCreating(false);
        }
    };

    if (loading) return <div className={s.loading}>Loading roles…</div>;

    return (
        <div className={s.root}>
            <div className={s.intro}>
                <AlertCircle size={16} className={s.introIcon} />
                <div>
                    Each role is pinned to a <em>permission level</em> (Standard&nbsp;member,
                    Team&nbsp;lead, Manager, or HR&nbsp;admin) which controls what they can
                    see and do. You can rename roles, add new ones, or delete unused
                    ones — the underlying access control rules are determined by the
                    permission level you assign.
                </div>
            </div>

            <div className={s.list}>
                {sorted.map((role) => {
                    const draft = editing[role.role_key];
                    const isEditing = !!draft;
                    const isSaving = savingKey === role.role_key;
                    const isDeleting = deletingKey === role.role_key;

                    return (
                        <div
                            key={role.role_key}
                            className={s.row}
                            style={
                                {
                                    "--role-color":
                                        (isEditing ? draft.color : role.color) || "#6366f1",
                                } as React.CSSProperties
                            }
                        >
                            <div className={s.rowHeader}>
                                <span
                                    className={s.swatch}
                                    style={{
                                        background:
                                            (isEditing ? draft.color : role.color) || "#6366f1",
                                    }}
                                />
                                <div className={s.rowMeta}>
                                    <code className={s.roleKey}>{role.role_key}</code>
                                    {role.is_system && (
                                        <span className={s.lockedBadge}>
                                            <ShieldCheck size={11} /> system
                                        </span>
                                    )}
                                    {!role.is_system && (
                                        <span className={s.customBadge}>custom</span>
                                    )}
                                    {role.user_count > 0 && (
                                        <span
                                            className={s.usersBadge}
                                            title={`${role.user_count} active user${role.user_count === 1 ? "" : "s"} hold${role.user_count === 1 ? "s" : ""} this role`}
                                        >
                                            <Users size={11} /> {role.user_count}
                                        </span>
                                    )}
                                    <span className={s.levelBadge}>
                                        L{role.permission_level} ·{" "}
                                        {PERMISSION_LEVEL_LABEL[role.permission_level] ||
                                            `level ${role.permission_level}`}
                                    </span>
                                </div>

                                {canEdit && !isEditing && (
                                    <>
                                        <button
                                            type="button"
                                            className={s.rowReset}
                                            onClick={() => startEdit(role)}
                                            title="Edit this role"
                                        >
                                            <Edit3 size={12} /> Edit
                                        </button>
                                        <button
                                            type="button"
                                            className={`${s.rowReset} ${s.danger}`}
                                            onClick={() => deleteRole(role)}
                                            disabled={isDeleting || role.user_count > 0}
                                            title={
                                                role.user_count > 0
                                                    ? `Reassign the ${role.user_count} user${role.user_count === 1 ? "" : "s"} holding this role first`
                                                    : "Delete this role"
                                            }
                                        >
                                            <Trash2 size={12} />{" "}
                                            {isDeleting ? "Deleting…" : "Delete"}
                                        </button>
                                    </>
                                )}
                            </div>

                            {!isEditing && (
                                <div className={s.previewRow}>
                                    <strong className={s.previewLabel}>{role.label}</strong>
                                    {role.description && (
                                        <span className={s.previewDesc}>{role.description}</span>
                                    )}
                                </div>
                            )}

                            {isEditing && (
                                <>
                                    <div className={s.fields}>
                                        <label className={s.field}>
                                            <span className={s.fieldLabel}>Display label</span>
                                            <input
                                                type="text"
                                                className={s.input}
                                                value={draft.label}
                                                onChange={(e) =>
                                                    updateField(role.role_key, "label", e.target.value)
                                                }
                                                maxLength={40}
                                                disabled={isSaving}
                                            />
                                        </label>

                                        <label className={s.field}>
                                            <span className={s.fieldLabel}>Description</span>
                                            <input
                                                type="text"
                                                className={s.input}
                                                value={draft.description || ""}
                                                onChange={(e) =>
                                                    updateField(
                                                        role.role_key,
                                                        "description",
                                                        e.target.value,
                                                    )
                                                }
                                                maxLength={200}
                                                disabled={isSaving}
                                            />
                                        </label>

                                        <label className={`${s.field} ${s.colorField}`}>
                                            <span className={s.fieldLabel}>Colour</span>
                                            <div className={s.colorGroup}>
                                                <input
                                                    type="color"
                                                    className={s.colorPicker}
                                                    value={
                                                        HEX_RE.test(draft.color || "")
                                                            ? draft.color
                                                            : "#6366f1"
                                                    }
                                                    onChange={(e) =>
                                                        updateField(
                                                            role.role_key,
                                                            "color",
                                                            e.target.value,
                                                        )
                                                    }
                                                    disabled={isSaving}
                                                />
                                                <input
                                                    type="text"
                                                    className={s.colorHex}
                                                    value={draft.color || ""}
                                                    onChange={(e) =>
                                                        updateField(
                                                            role.role_key,
                                                            "color",
                                                            e.target.value,
                                                        )
                                                    }
                                                    maxLength={7}
                                                    disabled={isSaving}
                                                />
                                            </div>
                                        </label>

                                        <label className={s.field}>
                                            <span className={s.fieldLabel}>Permission level</span>
                                            <select
                                                className={s.input}
                                                value={draft.permission_level}
                                                onChange={(e) =>
                                                    updateField(
                                                        role.role_key,
                                                        "permission_level",
                                                        Number(e.target.value),
                                                    )
                                                }
                                                disabled={isSaving}
                                            >
                                                {PERMISSION_LEVELS.map((p) => (
                                                    <option key={p.value} value={p.value}>
                                                        L{p.value} — {p.label}
                                                    </option>
                                                ))}
                                            </select>
                                        </label>
                                    </div>

                                    <div className={s.actions}>
                                        <button
                                            type="button"
                                            className={s.btnSecondary}
                                            onClick={() => cancelEdit(role.role_key)}
                                            disabled={isSaving}
                                        >
                                            Cancel
                                        </button>
                                        <button
                                            type="button"
                                            className={s.btnPrimary}
                                            onClick={() => saveRole(role)}
                                            disabled={isSaving}
                                        >
                                            <Save size={14} /> {isSaving ? "Saving…" : "Save"}
                                        </button>
                                    </div>
                                </>
                            )}
                        </div>
                    );
                })}

                {/* Add-new-role inline form */}
                {canEdit && adding && (
                    <div
                        className={`${s.row} ${s.addRow}`}
                        style={
                            { "--role-color": adding.color || "#6366f1" } as React.CSSProperties
                        }
                    >
                        <div className={s.rowHeader}>
                            <span
                                className={s.swatch}
                                style={{ background: adding.color || "#6366f1" }}
                            />
                            <div className={s.rowMeta}>
                                <strong>New role</strong>
                            </div>
                            <button
                                type="button"
                                className={s.rowReset}
                                onClick={cancelAdd}
                                disabled={creating}
                            >
                                <X size={12} /> Cancel
                            </button>
                        </div>

                        <div className={s.fields}>
                            <label className={s.field}>
                                <span className={s.fieldLabel}>Key (immutable)</span>
                                <input
                                    type="text"
                                    className={s.input}
                                    value={adding.role_key}
                                    onChange={(e) =>
                                        updateAddField("role_key", e.target.value.toLowerCase())
                                    }
                                    placeholder="e.g. principal_engineer"
                                    maxLength={40}
                                    disabled={creating}
                                />
                            </label>

                            <label className={s.field}>
                                <span className={s.fieldLabel}>Display label</span>
                                <input
                                    type="text"
                                    className={s.input}
                                    value={adding.label}
                                    onChange={(e) => updateAddField("label", e.target.value)}
                                    placeholder="e.g. Principal Engineer"
                                    maxLength={40}
                                    disabled={creating}
                                />
                            </label>

                            <label className={s.field}>
                                <span className={s.fieldLabel}>Description</span>
                                <input
                                    type="text"
                                    className={s.input}
                                    value={adding.description}
                                    onChange={(e) =>
                                        updateAddField("description", e.target.value)
                                    }
                                    placeholder="What does this role do?"
                                    maxLength={200}
                                    disabled={creating}
                                />
                            </label>

                            <label className={`${s.field} ${s.colorField}`}>
                                <span className={s.fieldLabel}>Colour</span>
                                <div className={s.colorGroup}>
                                    <input
                                        type="color"
                                        className={s.colorPicker}
                                        value={
                                            HEX_RE.test(adding.color || "")
                                                ? adding.color
                                                : "#6366f1"
                                        }
                                        onChange={(e) => updateAddField("color", e.target.value)}
                                        disabled={creating}
                                    />
                                    <input
                                        type="text"
                                        className={s.colorHex}
                                        value={adding.color}
                                        onChange={(e) => updateAddField("color", e.target.value)}
                                        maxLength={7}
                                        disabled={creating}
                                    />
                                </div>
                            </label>

                            <label className={s.field}>
                                <span className={s.fieldLabel}>Permission level</span>
                                <select
                                    className={s.input}
                                    value={adding.permission_level}
                                    onChange={(e) =>
                                        updateAddField(
                                            "permission_level",
                                            Number(e.target.value),
                                        )
                                    }
                                    disabled={creating}
                                >
                                    {PERMISSION_LEVELS.map((p) => (
                                        <option key={p.value} value={p.value}>
                                            L{p.value} — {p.label}
                                        </option>
                                    ))}
                                </select>
                            </label>
                        </div>

                        <div className={s.actions}>
                            <button
                                type="button"
                                className={s.btnSecondary}
                                onClick={cancelAdd}
                                disabled={creating}
                            >
                                Cancel
                            </button>
                            <button
                                type="button"
                                className={s.btnPrimary}
                                onClick={submitAdd}
                                disabled={creating}
                            >
                                <Plus size={14} /> {creating ? "Creating…" : "Create role"}
                            </button>
                        </div>
                    </div>
                )}

                {/* System roles — informational, not editable */}
                <div
                    className={`${s.row} ${s.rowReadonly}`}
                    style={{ "--role-color": "#ef4444" } as React.CSSProperties}
                >
                    <div className={s.rowHeader}>
                        <span className={s.swatch} style={{ background: "#ef4444" }} />
                        <div className={s.rowMeta}>
                            <code className={s.roleKey}>super_admin</code>
                            <span className={s.lockedBadge}>
                                <Lock size={11} /> system
                            </span>
                            <span className={s.levelBadge}>L5 · Org admin</span>
                        </div>
                    </div>
                    <p className={s.readonlyNote}>
                        Org-wide admin with access to all settings and billing. Always
                        present in every organisation.
                    </p>
                </div>
                <div
                    className={`${s.row} ${s.rowReadonly}`}
                    style={{ "--role-color": "#0f172a" } as React.CSSProperties}
                >
                    <div className={s.rowHeader}>
                        <span className={s.swatch} style={{ background: "#0f172a" }} />
                        <div className={s.rowMeta}>
                            <code className={s.roleKey}>platform_admin</code>
                            <span className={s.lockedBadge}>
                                <Lock size={11} /> system
                            </span>
                            <span className={s.levelBadge}>L6 · Platform</span>
                        </div>
                    </div>
                    <p className={s.readonlyNote}>
                        Cross-organisation system operator. Not assignable from inside an
                        organisation.
                    </p>
                </div>
            </div>

            {canEdit && !adding && (
                <div className={s.actions}>
                    <button type="button" className={s.btnPrimary} onClick={startAdd}>
                        <Plus size={14} /> Add role
                    </button>
                </div>
            )}

            {!canEdit && (
                <div className={s.readOnlyBanner}>
                    <Lock size={14} /> Only super admins can edit roles.
                </div>
            )}
        </div>
    );
}
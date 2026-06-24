import React, { useState, useEffect, useCallback } from "react";
import { useAutoDismiss } from "../../hooks/useAutoDismiss";
import { CalendarDays } from "lucide-react";
import {
    getOrgTeams,
    getOrgDepartments,
    getOrgMembers,
    createTeam,
    updateTeam,
    deleteTeam,
    getTeamSprintConfig,
    updateTeamSprintConfig,
    getActiveSprint,
    pauseSprint,
    resumeSprint,
} from "../../api";
import s from "../../pages/Admin.module.css";
import tc from "./TeamsConfig.module.css";
import sf from "../../pages/admin/AdminForms.module.css";
import su from "../../pages/admin/AdminUtils.module.css";

interface TeamRow {
    id: number | string;
    name: string;
    department_id?: number | string | null;
    department_name?: string;
    lead_id?: number | string | null;
    lead_name?: string;
    member_count?: number;
    sprint_duration_weeks?: number;
    sprint_start_date?: string;
    [key: string]: unknown;
}

interface DepartmentRow {
    id: number | string;
    name: string;
    [key: string]: unknown;
}

interface MemberRow {
    id: number | string;
    full_name?: string;
    username?: string;
    [key: string]: unknown;
}

interface EditForm {
    name: string;
    department_id: string;
    lead_id: string;
    sprint_duration_weeks: number;
    sprint_start_date: string;
    sprint_mode: string;
}

interface TeamsProps {
    orgId?: number | string;
    userRole?: string;
}

export default function Teams({ orgId, userRole }: TeamsProps) {
    const [teams, setTeams] = useState<TeamRow[]>([]);
    const [departments, setDepartments] = useState<DepartmentRow[]>([]);
    const [members, setMembers] = useState<MemberRow[]>([]);
    const [showForm, setShowForm] = useState(false);
    const [form, setForm] = useState({ name: "", department_id: "", lead_id: "" });
    const [editId, setEditId] = useState<number | string | null>(null);
    const [editForm, setEditForm] = useState<EditForm>({
        name: "",
        department_id: "",
        lead_id: "",
        sprint_duration_weeks: 2,
        sprint_start_date: "",
        sprint_mode: "manual",
    });
    // Active sprint for the team currently being edited (drives pause/resume).
    const [editActiveSprint, setEditActiveSprint] = useState<any>(null);
    const [editPaused, setEditPaused] = useState(false);
    const [msg, setMsg] = useAutoDismiss("");
    const canManage = ["hr_admin", "super_admin", "platform_admin"].includes(userRole ?? "");
    const isAdmin = canManage;

    const fetchTeams = useCallback(() => {
        getOrgTeams(orgId ? { org_id: orgId } : undefined)
            .then((r) => setTeams(r.data))
            .catch((e) => console.error(e));
        getOrgDepartments(orgId ? { org_id: orgId } : undefined)
            .then((r) => setDepartments(r.data))
            .catch((e) => console.error(e));
    }, [orgId]);

    useEffect(() => {
        fetchTeams();
    }, [fetchTeams]);

    useEffect(() => {
        if (canManage) {
            getOrgMembers(orgId ? { is_active: true, org_id: orgId } : { is_active: true })
                .then((r) => setMembers(r.data?.data ?? r.data))
                .catch((e) => console.error(e));
        }
    }, [canManage, orgId]);

    const handleCreate = async (e: React.FormEvent) => {
        e.preventDefault();
        try {
            await createTeam({
                name: form.name,
                department_id: form.department_id || null,
                lead_id: form.lead_id || null,
                org_id: orgId || undefined,
            });
            setForm({ name: "", department_id: "", lead_id: "" });
            setShowForm(false);
            fetchTeams();
        } catch (e: any) {
            setMsg(e.response?.data?.error || "Failed");
        }
    };

    const handleUpdate = async (id: number | string) => {
        try {
            await updateTeam(id, {
                name: editForm.name,
                department_id: editForm.department_id || null,
                lead_id: editForm.lead_id || null,
            });
            if (editForm.sprint_duration_weeks || editForm.sprint_start_date) {
                await updateTeamSprintConfig(id, {
                    sprint_duration_weeks: editForm.sprint_duration_weeks || 2,
                    sprint_start_date: editForm.sprint_start_date || null,
                    sprint_mode: editForm.sprint_mode || "manual",
                });
            }
            setEditId(null);
            fetchTeams();
        } catch (e: any) {
            setMsg(e.response?.data?.error || "Failed");
        }
    };

    // Pause / resume the team's active sprint (auto mode). team_lead and above
    // can do this; the server enforces the role gate too.
    const handlePauseResume = async (sprintId: number | string, paused: boolean) => {
        try {
            if (paused) {
                await resumeSprint(sprintId);
                setEditPaused(false);
                setMsg("Sprint resumed");
            } else {
                await pauseSprint(sprintId);
                setEditPaused(true);
                setMsg("Sprint paused");
            }
        } catch (e: any) {
            setMsg(e.response?.data?.error || "Failed");
        }
    };

    const handleDelete = async (id: number | string) => {
        if (!confirm("Delete this team? Members will be unassigned.")) return;
        try {
            await deleteTeam(id);
            fetchTeams();
        } catch (e: any) {
            setMsg(e.response?.data?.error || "Failed");
        }
    };

    return (
        <>
            {msg && <div className={s.success}>{msg}</div>}
            {canManage && (
                <div className={su["form-toolbar"]}>
                    {showForm ? (
                        <form onSubmit={handleCreate} className={su["inline-form"]}>
                            <input
                                value={form.name}
                                onChange={(e) => setForm({ ...form, name: e.target.value })}
                                placeholder="Team name"
                                required
                                className={su["form-inline-input"]}
                            />
                            <select
                                value={form.department_id}
                                onChange={(e) =>
                                    setForm({ ...form, department_id: e.target.value })
                                }
                                className={su["form-inline-input"]}
                            >
                                <option value="">No department</option>
                                {departments.map((d) => (
                                    <option key={d.id} value={d.id}>
                                        {d.name}
                                    </option>
                                ))}
                            </select>
                            <select
                                value={form.lead_id}
                                onChange={(e) => setForm({ ...form, lead_id: e.target.value })}
                                className={su["form-inline-input"]}
                            >
                                <option value="">No Lead</option>
                                {members.map((m) => (
                                    <option key={m.id} value={m.id}>
                                        {m.full_name || m.username}
                                    </option>
                                ))}
                            </select>
                            <button type="submit" className={s.btnPrimary}>
                                Add
                            </button>
                            <button
                                type="button"
                                className={sf.btnCancel}
                                onClick={() => setShowForm(false)}
                            >
                                Cancel
                            </button>
                        </form>
                    ) : (
                        <button className={s.btnPrimary} onClick={() => setShowForm(true)}>
                            + Add Team
                        </button>
                    )}
                </div>
            )}
            <table className={s.table}>
                <thead>
                    <tr>
                        <th>Name</th>
                        <th>Department</th>
                        <th>Lead</th>
                        {isAdmin && <th>Members</th>}
                        <th>Sprint Config</th>
                        {canManage && <th>Actions</th>}
                    </tr>
                </thead>
                <tbody>
                    {teams.map((t) => (
                        <React.Fragment key={t.id}>
                            <tr>
                                <td>
                                    {editId === t.id ? (
                                        <input
                                            value={editForm.name}
                                            onChange={(e) =>
                                                setEditForm({ ...editForm, name: e.target.value })
                                            }
                                            className={su["edit-inline-input"]}
                                        />
                                    ) : (
                                        t.name
                                    )}
                                </td>
                                <td>
                                    {editId === t.id ? (
                                        <select
                                            value={editForm.department_id}
                                            onChange={(e) =>
                                                setEditForm({
                                                    ...editForm,
                                                    department_id: e.target.value,
                                                })
                                            }
                                            className={su["edit-inline-input"]}
                                        >
                                            <option value="">No department</option>
                                            {departments.map((d) => (
                                                <option key={d.id} value={d.id}>
                                                    {d.name}
                                                </option>
                                            ))}
                                        </select>
                                    ) : (
                                        t.department_name || "—"
                                    )}
                                </td>
                                <td>
                                    {editId === t.id ? (
                                        <select
                                            value={editForm.lead_id}
                                            onChange={(e) =>
                                                setEditForm({
                                                    ...editForm,
                                                    lead_id: e.target.value,
                                                })
                                            }
                                            className={su["edit-inline-input"]}
                                        >
                                            <option value="">No Lead</option>
                                            {members.map((m) => (
                                                <option key={m.id} value={m.id}>
                                                    {m.full_name || m.username}
                                                </option>
                                            ))}
                                        </select>
                                    ) : (
                                        t.lead_name || "—"
                                    )}
                                </td>
                                {isAdmin && <td>{t.member_count}</td>}
                                <td className={su["text-muted-sm"]}>
                                    {t.sprint_duration_weeks
                                        ? `${t.sprint_duration_weeks} week${
                                              t.sprint_duration_weeks > 1 ? "s" : ""
                                          }`
                                        : "Not set"}
                                    {t.sprint_start_date && ` (from ${t.sprint_start_date})`}
                                </td>
                                {canManage && (
                                    <td>
                                        <div className={s.actions}>
                                            {editId === t.id ? (
                                                <>
                                                    <button
                                                        className={`${s.btnSmall} ${s.btnAccent}`}
                                                        onClick={() => handleUpdate(t.id)}
                                                    >
                                                        Save
                                                    </button>
                                                    <button
                                                        className={`${s.btnSmall} ${s.btnSecondary}`}
                                                        onClick={() => setEditId(null)}
                                                    >
                                                        Cancel
                                                    </button>
                                                </>
                                            ) : (
                                                <>
                                                    <button
                                                        className={`${s.btnSmall} ${s.btnAccent}`}
                                                        onClick={async () => {
                                                            setEditId(t.id);
                                                            setEditForm({
                                                                name: t.name,
                                                                department_id: t.department_id
                                                                    ? String(t.department_id)
                                                                    : "",
                                                                lead_id: t.lead_id
                                                                    ? String(t.lead_id)
                                                                    : "",
                                                                sprint_duration_weeks: 2,
                                                                sprint_start_date: "",
                                                                sprint_mode: "manual",
                                                            });
                                                            setEditActiveSprint(null);
                                                            setEditPaused(false);
                                                            try {
                                                                const sprintRes =
                                                                    await getTeamSprintConfig(t.id);
                                                                setEditForm((prev) => ({
                                                                    ...prev,
                                                                    sprint_duration_weeks:
                                                                        sprintRes.data
                                                                            .sprintDurationWeeks ||
                                                                        2,
                                                                    sprint_start_date:
                                                                        sprintRes.data
                                                                            .sprintStartDate || "",
                                                                    sprint_mode:
                                                                        sprintRes.data
                                                                            .sprintMode || "manual",
                                                                }));
                                                                setEditPaused(
                                                                    !!sprintRes.data.sprintPaused
                                                                );
                                                            } catch (err) {
                                                                console.error(
                                                                    "Failed to load sprint config:",
                                                                    err
                                                                );
                                                            }
                                                            // Load the team's active sprint so we
                                                            // can offer Pause/Resume in auto mode.
                                                            try {
                                                                const act = await getActiveSprint();
                                                                setEditActiveSprint(
                                                                    act.data?.sprint || null
                                                                );
                                                                if (act.data?.sprint) {
                                                                    setEditPaused(
                                                                        act.data.sprint.status ===
                                                                            "paused"
                                                                    );
                                                                }
                                                            } catch {
                                                                /* non-fatal */
                                                            }
                                                        }}
                                                    >
                                                        Edit
                                                    </button>
                                                    <button
                                                        className={`${s.btnSmall} ${s.btnDanger}`}
                                                        onClick={() => handleDelete(t.id)}
                                                    >
                                                        Delete
                                                    </button>
                                                </>
                                            )}
                                        </div>
                                    </td>
                                )}
                            </tr>
                            {editId === t.id && (
                                <tr className={tc["sprint-edit-row"]}>
                                    <td
                                        colSpan={
                                            canManage ? (isAdmin ? 7 : 6) : isAdmin ? 6 : 5
                                        }
                                        className={tc["sprint-edit-cell"]}
                                    >
                                        <div className={tc["sprint-config-form"]}>
                                            <div className={tc["sprint-field"]}>
                                                <label className={tc["field-label"]}>
                                                    🏃 Sprint Duration (weeks)
                                                </label>
                                                <input
                                                    type="number"
                                                    min="1"
                                                    max="8"
                                                    value={editForm.sprint_duration_weeks || 2}
                                                    onChange={(e) =>
                                                        setEditForm({
                                                            ...editForm,
                                                            sprint_duration_weeks:
                                                                parseInt(e.target.value) || 2,
                                                        })
                                                    }
                                                    className={su["edit-inline-input"]}
                                                    placeholder="2"
                                                />
                                                <small className={tc["field-hint"]}>
                                                    Length of each sprint (1-8 weeks)
                                                </small>
                                            </div>
                                            <div className={tc["sprint-field"]}>
                                                <label className={tc["field-label"]}>
                                                    <CalendarDays
                                                        size={13}
                                                        style={{
                                                            marginRight: 4,
                                                            verticalAlign: "middle",
                                                        }}
                                                    />
                                                    Sprint Start Date
                                                </label>
                                                <input
                                                    type="date"
                                                    value={editForm.sprint_start_date || ""}
                                                    onChange={(e) =>
                                                        setEditForm({
                                                            ...editForm,
                                                            sprint_start_date: e.target.value,
                                                        })
                                                    }
                                                    className={su["edit-inline-input"]}
                                                />
                                                <small className={tc["field-hint"]}>
                                                    First sprint's start date (sprints
                                                    auto-calculated from this)
                                                </small>
                                            </div>
                                            <div className={tc["sprint-field"]}>
                                                <label className={tc["field-label"]}>
                                                    ⚙️ Sprint Mode
                                                </label>
                                                <select
                                                    value={editForm.sprint_mode || "manual"}
                                                    onChange={(e) =>
                                                        setEditForm({
                                                            ...editForm,
                                                            sprint_mode: e.target.value,
                                                        })
                                                    }
                                                    className={su["edit-inline-input"]}
                                                >
                                                    <option value="manual">
                                                        Manual (start/complete by hand)
                                                    </option>
                                                    <option value="auto">
                                                        Auto (start &amp; rotate on schedule)
                                                    </option>
                                                </select>
                                                <small className={tc["field-hint"]}>
                                                    Auto mode automatically starts, completes, and
                                                    rotates sprints on the configured cadence.
                                                </small>
                                            </div>
                                            {editForm.sprint_mode === "auto" &&
                                                editActiveSprint && (
                                                    <div className={tc["sprint-field"]}>
                                                        <label className={tc["field-label"]}>
                                                            ⏯️ Active Sprint —{" "}
                                                            {editActiveSprint.name} (
                                                            {editPaused
                                                                ? "Paused"
                                                                : editActiveSprint.status}
                                                            )
                                                        </label>
                                                        <button
                                                            type="button"
                                                            className={`${s.btnSmall} ${
                                                                editPaused
                                                                    ? s.btnAccent
                                                                    : s.btnSecondary
                                                            }`}
                                                            onClick={() =>
                                                                handlePauseResume(
                                                                    editActiveSprint.id,
                                                                    editPaused
                                                                )
                                                            }
                                                        >
                                                            {editPaused
                                                                ? "Resume Sprint"
                                                                : "Pause Sprint"}
                                                        </button>
                                                        <small className={tc["field-hint"]}>
                                                            {editPaused
                                                                ? "Resuming extends the end date by the paused duration."
                                                                : "Pausing freezes the cadence clock until you resume."}
                                                        </small>
                                                    </div>
                                                )}
                                        </div>
                                    </td>
                                </tr>
                            )}
                        </React.Fragment>
                    ))}
                    {teams.length === 0 && (
                        <tr>
                            <td
                                colSpan={canManage ? (isAdmin ? 7 : 6) : isAdmin ? 6 : 5}
                                className={s.emptyRow}
                            >
                                No teams yet
                            </td>
                        </tr>
                    )}
                </tbody>
            </table>
        </>
    );
}
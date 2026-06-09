import React, { useState } from "react";
import { ROLE_LABELS } from "./constants";
import s from "../Admin.module.css";
import sf from "./AdminForms.module.css";

interface AssignmentModalProps {
    user: any;
    departments: any[];
    teams: any[];
    organizations: any[];
    userRole: string;
    allUsers: any[];
    onClose: () => void;
    onSave: (
        userId: number | string,
        orgId: number | string | undefined,
        deptId: number | string | null,
        teamId: number | string | null,
        managerId: number | string | null,
    ) => void;
}

export default function AssignmentModal({
    user,
    departments,
    teams,
    organizations,
    userRole,
    allUsers,
    onClose,
    onSave,
}: AssignmentModalProps) {
    const [orgId, setOrgId] = useState(user.org_id || "");
    const [deptId, setDeptId] = useState(user.department_id || "");
    const [teamId, setTeamId] = useState(user.team_id || "");
    const [managerId, setManagerId] = useState(user.manager_id || "");

    const managerOptions = (allUsers || []).filter(
        (u) => u.id !== user.id && u.is_active,
    );
    const isPlatformAdmin = userRole === "platform_admin";

    return (
        <div className={sf.modalOverlay} onClick={onClose}>
            <div className={sf.modal} onClick={(e) => e.stopPropagation()}>
                <h2>Assign {user.full_name}</h2>
                {isPlatformAdmin && (
                    <div className={sf.formGroup}>
                        <label>Organization</label>
                        <select
                            value={orgId}
                            onChange={(e) => {
                                setOrgId(e.target.value);
                                setDeptId("");
                                setTeamId("");
                                setManagerId("");
                            }}
                        >
                            <option value="">None</option>
                            {organizations.map((o) => (
                                <option key={o.id} value={o.id}>
                                    {o.name}
                                </option>
                            ))}
                        </select>
                    </div>
                )}
                <div className={sf.formGroup}>
                    <label>Department</label>
                    <select value={deptId} onChange={(e) => setDeptId(e.target.value)}>
                        <option value="">None</option>
                        {departments.map((d) => (
                            <option key={d.id} value={d.id}>
                                {d.name}
                            </option>
                        ))}
                    </select>
                </div>
                <div className={sf.formGroup}>
                    <label>Team</label>
                    <select value={teamId} onChange={(e) => setTeamId(e.target.value)}>
                        <option value="">None</option>
                        {teams
                            .filter((t) => !deptId || t.department_id === Number(deptId))
                            .map((t) => (
                                <option key={t.id} value={t.id}>
                                    {t.name}
                                </option>
                            ))}
                    </select>
                </div>
                <div className={sf.formGroup}>
                    <label>Manager</label>
                    <select
                        value={managerId}
                        onChange={(e) => setManagerId(e.target.value)}
                    >
                        <option value="">None</option>
                        {managerOptions.map((u) => (
                            <option key={u.id} value={u.id}>
                                {u.full_name} ({ROLE_LABELS[u.role] || u.role})
                            </option>
                        ))}
                    </select>
                </div>
                <div className={sf.formActions}>
                    <button className={sf.btnCancel} onClick={onClose}>
                        Cancel
                    </button>
                    <button
                        className={s.btnPrimary}
                        onClick={() =>
                            onSave(
                                user.id,
                                isPlatformAdmin ? orgId : undefined,
                                deptId || null,
                                teamId || null,
                                managerId || null,
                            )
                        }
                    >
                        Save
                    </button>
                </div>
            </div>
        </div>
    );
}
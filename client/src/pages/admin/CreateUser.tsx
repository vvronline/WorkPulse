import React, { useState, useEffect } from "react";
import { ClipboardList, Users, UserCheck, Building, Info } from "lucide-react";
import { useAutoDismiss } from "../../hooks/useAutoDismiss";
import {
    createAdminUser, getAdminOrganizations, getCurrentOrg, getOrgDepartments, getOrgTeams, getAdminUsers
} from "../../api";
import { ROLES, ROLE_LABELS } from "./constants";
import s from "../Admin.module.css";
import sf from "./AdminForms.module.css";
import su from "./AdminUtils.module.css";

interface CreateUserForm {
    username: string;
    password: string;
    full_name: string;
    email: string;
    role: string;
    org_id: string;
    department_id: string;
    team_id: string;
    manager_id: string;
}

interface CreateUserProps {
    userRole?: string;
    onCreated?: () => void;
}

export default function CreateUser({ userRole, onCreated }: CreateUserProps) {
    const [form, setForm] = useState<CreateUserForm>({ username: "", password: "", full_name: "", email: "", role: "employee", org_id: "", department_id: "", team_id: "", manager_id: "" });
    const [error, setError] = useAutoDismiss("") as [string, (v: string) => void];
    const [success, setSuccess] = useAutoDismiss("") as [string, (v: string) => void];
    const [organizations, setOrganizations] = useState<any[]>([]);
    const [departments, setDepartments] = useState<any[]>([]);
    const [teams, setTeams] = useState<any[]>([]);
    const [users, setUsers] = useState<any[]>([]);

    // Load org list once on mount
    useEffect(() => {
        if (userRole === "platform_admin") {
            getAdminOrganizations().then(r => setOrganizations((r.data as any).data || r.data)).catch(e => console.error(e));
        } else if (userRole === "super_admin") {
            getCurrentOrg()
                .then(r => {
                    const org = r.data as any;
                    setOrganizations(org ? [org] : []);
                    if (org?.id) {
                        setForm(prev => ({ ...prev, org_id: String(org.id) }));
                    }
                })
                .catch(e => console.error(e));
        }
    }, [userRole]);

    // Re-fetch departments, teams and users whenever the selected org changes
    useEffect(() => {
        const isPlatformAdmin = userRole === "platform_admin";
        if (isPlatformAdmin && !form.org_id) {
            setDepartments([]);
            setTeams([]);
            setUsers([]);
            return;
        }
        const orgParam = isPlatformAdmin ? { org_id: form.org_id } : {};
        getOrgDepartments(orgParam).then(r => setDepartments(r.data as any[])).catch(e => console.error(e));
        getOrgTeams(orgParam).then(r => setTeams(r.data as any[])).catch(e => console.error(e));
        getAdminUsers(isPlatformAdmin ? { org_id: form.org_id } : {})
            .then(r => setUsers((r.data as any)?.data ?? r.data)).catch(e => console.error(e));
    }, [form.org_id, userRole]);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setError("");
        setSuccess("");
        try {
            const payload: Partial<CreateUserForm> = { ...form };
            if (!payload.org_id) delete payload.org_id;
            if (!payload.department_id) delete payload.department_id;
            if (!payload.team_id) delete payload.team_id;
            if (!payload.manager_id) delete payload.manager_id;
            const r = await createAdminUser(payload);
            setSuccess((r.data as any).message + " (User must change password on first login)");
            setForm({ username: "", password: "", full_name: "", email: "", role: "employee", org_id: "", department_id: "", team_id: "", manager_id: "" });
            setTimeout(() => onCreated?.(), 2000);
        } catch (e: any) { setError(e.response?.data?.error || "Failed to create user"); }
    };

    const canShowOrganization = userRole === "platform_admin" || userRole === "super_admin";
    const canChooseOrganization = userRole === "platform_admin";
    const filteredTeams = form.department_id ? teams.filter(t => t.department_id === Number(form.department_id)) : teams;
    const managerOptions = users.filter(u => u.is_active);

    return (
        <div className={su["form-container"]}>
            <h2 className={su["section-heading"]}>➕ Create New User</h2>
            <p className={su["section-subtitle"]}>
                Create a new user account. The user will be required to change their password on first login.
            </p>
            <form onSubmit={handleSubmit} className={sf.createUserForm}>
                {error && <div className={s.error}>{error}</div>}
                {success && <div className={s.success}>{success}</div>}

                <div className={sf.formSection}>
                    <h3 className={sf.sectionTitle}><ClipboardList size={15} style={{ marginRight: 6, verticalAlign: "middle" }} />Basic Information</h3>
                    <div className={sf.formGroup}>
                        <label>Full Name</label>
                        <input required value={form.full_name} onChange={e => setForm({ ...form, full_name: e.target.value })} placeholder="e.g. John Doe" />
                    </div>
                    <div className={sf.formGroup}>
                        <label>Username</label>
                        <input required value={form.username} onChange={e => setForm({ ...form, username: e.target.value })} placeholder="e.g. johndoe" />
                    </div>
                    <div className={sf.formGroup}>
                        <label>Email</label>
                        <input type="email" required value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} placeholder="e.g. john@example.com" />
                    </div>
                    <div className={sf.formGroup}>
                        <label>Initial Password</label>
                        <input type="password" required minLength={8} value={form.password} onChange={e => setForm({ ...form, password: e.target.value })} placeholder="Minimum 8 characters" />
                        <small className={sf.hint}><Info size={13} style={{ marginRight: 4, verticalAlign: "middle" }} />User will be required to change this on first login</small>
                    </div>
                </div>

                <div className={sf.formSection}>
                    <h3 className={sf.sectionTitle}><Users size={15} style={{ marginRight: 6, verticalAlign: "middle" }} />Role & Organization</h3>
                    <div className={sf.formGroup}>
                        <label>Role</label>
                        <select value={form.role} onChange={e => setForm({ ...form, role: e.target.value })}>
                            {ROLES.map(r => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
                        </select>
                    </div>
                    {canShowOrganization && (
                        <div className={sf.formGroup}>
                            <label>Organization</label>
                            <select
                                value={form.org_id}
                                disabled={!canChooseOrganization}
                                onChange={e => { setForm({ ...form, org_id: e.target.value, department_id: "", team_id: "", manager_id: "" }); }}
                            >
                                {canChooseOrganization && <option value="">None</option>}
                                {organizations.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
                            </select>
                            {!canChooseOrganization && <small className={sf.hint}>Users created by Super Admin are assigned to your organization.</small>}
                        </div>
                    )}
                </div>

                <div className={sf.formSection}>
                    <h3 className={sf.sectionTitle}><Building size={15} style={{ marginRight: 6, verticalAlign: "middle" }} />Assignment</h3>
                    <div className={sf.formGroup}>
                        <label>Department</label>
                        <select value={form.department_id} onChange={e => setForm({ ...form, department_id: e.target.value, team_id: "" })}>
                            <option value="">None</option>
                            {departments.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
                        </select>
                    </div>
                    <div className={sf.formGroup}>
                        <label>Team</label>
                        <select value={form.team_id} onChange={e => setForm({ ...form, team_id: e.target.value })}>
                            <option value="">None</option>
                            {filteredTeams.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                        </select>
                    </div>
                    <div className={sf.formGroup}>
                        <label>Manager</label>
                        <select value={form.manager_id} onChange={e => setForm({ ...form, manager_id: e.target.value })}>
                            <option value="">None</option>
                            {managerOptions.map(u => <option key={u.id} value={u.id}>{u.full_name} ({ROLE_LABELS[u.role] || u.role})</option>)}
                        </select>
                    </div>
                </div>

                <div className={su["form-footer"]}>
                    <button type="submit" className={`${s.btnPrimary} ${su["btn-submit"]}`}>
                        <UserCheck size={15} style={{ marginRight: 6, verticalAlign: "middle" }} />Create User Account
                    </button>
                </div>
            </form>
        </div>
    );
}
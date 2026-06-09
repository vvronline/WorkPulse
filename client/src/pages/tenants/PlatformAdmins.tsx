import React, { useState, useEffect, useCallback } from "react";
import {
    getPlatformUsers, createPlatformUser, deactivatePlatformUser, resetPlatformUserPassword,
} from "../../api";
import { useAuth } from "../../AuthContext";
import { Shield, Plus, X, Loader2, Key, UserX, UserCheck } from "lucide-react";
import ConfirmDialog from "../../components/common/ConfirmDialog";
import s from "./Tenants.module.css";

export default function PlatformAdmins() {
    const { user } = useAuth() as any;
    const [admins, setAdmins] = useState<any[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");
    const [success, setSuccess] = useState("");
    const [showCreate, setShowCreate] = useState(false);

    // Create form
    const [form, setForm] = useState({ username: "", full_name: "", email: "", password: "" });
    const [submitting, setSubmitting] = useState(false);

    // Reset password
    const [resetModal, setResetModal] = useState<{ open: boolean; id: any; name: string }>({ open: false, id: null, name: "" });
    const [newPassword, setNewPassword] = useState("");

    const loadAdmins = useCallback(async () => {
        try {
            const res = await getPlatformUsers();
            setAdmins(Array.isArray(res.data) ? res.data : []);
        } catch (e: any) {
            setError(e.response?.data?.error || "Failed to load platform admins");
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => { loadAdmins(); }, [loadAdmins]);

    const handleCreate = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!form.username || !form.full_name || !form.email || !form.password) {
            setError("All fields are required"); return;
        }
        setSubmitting(true); setError(""); setSuccess("");
        try {
            await createPlatformUser(form);
            setSuccess("Platform admin created successfully");
            setForm({ username: "", full_name: "", email: "", password: "" });
            setShowCreate(false);
            loadAdmins();
        } catch (e: any) {
            setError(e.response?.data?.error || "Failed to create platform admin");
        } finally {
            setSubmitting(false);
        }
    };

    const handleToggleActive = async (admin: any) => {
        setError(""); setSuccess("");
        try {
            const res = await deactivatePlatformUser(admin.id);
            setSuccess((res.data as any).message);
            loadAdmins();
        } catch (e: any) {
            setError(e.response?.data?.error || "Failed");
        }
    };

    const handleResetPassword = async () => {
        if (!newPassword || newPassword.length < 8) { setError("Password must be at least 8 characters"); return; }
        setError(""); setSuccess("");
        try {
            const res = await resetPlatformUserPassword(resetModal.id, newPassword);
            setSuccess((res.data as any).message);
            setResetModal({ open: false, id: null, name: "" });
            setNewPassword("");
        } catch (e: any) {
            setError(e.response?.data?.error || "Failed");
        }
    };

    if (loading) return <div className={s.loading}><Loader2 size={20} className={s.spinner} /> Loading…</div>;

    return (
        <div>
            {error && (
                <div className={s.errorBanner}>
                    <span className={s.errorText}>{error}</span>
                    <button onClick={() => setError("")} className={s.errorClose}><X size={16} /></button>
                </div>
            )}
            {success && (
                <div className={s.successBanner}>
                    <span>{success}</span>
                    <button onClick={() => setSuccess("")} className={s.errorClose} style={{ color: "var(--success)" }}><X size={16} /></button>
                </div>
            )}

            <div className={s.toolbar}>
                <h3 style={{ margin: 0, flex: 1 }}>Platform Administrators ({admins.length})</h3>
                <button className={s.btnPrimary} onClick={() => setShowCreate(!showCreate)}>
                    <Plus size={14} /> New Platform Admin
                </button>
            </div>

            {/* Create form */}
            {showCreate && (
                <div className={s.wizard} style={{ marginBottom: 16 }}>
                    <h3 className={s.wizardTitle}>Create Platform Admin</h3>
                    <p className={s.wizardSubtitle}>This user will have full platform access across all tenants</p>
                    <form onSubmit={handleCreate}>
                        <div className={s.wizardGrid}>
                            <div>
                                <label className={s.fieldLabelSec}>Full Name *</label>
                                <input value={form.full_name} onChange={e => setForm(f => ({ ...f, full_name: e.target.value }))} className={s.input} style={{ width: "100%" }} />
                            </div>
                            <div>
                                <label className={s.fieldLabelSec}>Username *</label>
                                <input value={form.username} onChange={e => setForm(f => ({ ...f, username: e.target.value }))} className={s.input} style={{ width: "100%" }} />
                            </div>
                            <div>
                                <label className={s.fieldLabelSec}>Email *</label>
                                <input type="email" value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} className={s.input} style={{ width: "100%" }} />
                            </div>
                            <div>
                                <label className={s.fieldLabelSec}>Password *</label>
                                <input type="password" value={form.password} onChange={e => setForm(f => ({ ...f, password: e.target.value }))} className={s.input} style={{ width: "100%" }} />
                            </div>
                        </div>
                        <div className={s.wizardActions}>
                            <button type="button" className={s.btnSmall} onClick={() => setShowCreate(false)}>Cancel</button>
                            <button type="submit" className={s.btnPrimary} disabled={submitting}>
                                {submitting ? <><Loader2 size={14} className={s.spinner} /> Creating…</> : <><Shield size={14} /> Create Admin</>}
                            </button>
                        </div>
                    </form>
                </div>
            )}

            {/* Admin list */}
            <div className={s.platformAdminGrid}>
                {admins.map(a => (
                    <div key={a.id} className={s.adminCard}>
                        <div className={s.adminCardAvatar}>
                            {a.full_name?.charAt(0)?.toUpperCase() || "?"}
                        </div>
                        <div className={s.adminCardInfo}>
                            <div className={s.adminCardName}>
                                {a.full_name}
                                {a.id === user?.id && <span style={{ fontSize: 11, color: "var(--accent)", marginLeft: 6 }}>(you)</span>}
                            </div>
                            <div className={s.adminCardMeta}>
                                {a.username} · {a.email}
                            </div>
                            <div className={s.adminCardMeta}>
                                {a.is_active ? <span className={s.badgeActive}>active</span> : <span className={s.badgeInactive}>inactive</span>}
                                {" "}· Joined {new Date(a.created_at).toLocaleDateString()}
                            </div>
                        </div>
                        <div className={s.adminCardActions}>
                            <button className={s.btnSmall} title="Reset Password" onClick={() => { setNewPassword(""); setResetModal({ open: true, id: a.id, name: a.full_name }); }}>
                                <Key size={13} />
                            </button>
                            {a.id !== user?.id && (
                                <button className={s.btnSmall} title={a.is_active ? "Deactivate" : "Reactivate"}
                                    style={{ color: a.is_active ? "var(--danger)" : "var(--success)" }}
                                    onClick={() => handleToggleActive(a)}>
                                    {a.is_active ? <UserX size={13} /> : <UserCheck size={13} />}
                                </button>
                            )}
                        </div>
                    </div>
                ))}
            </div>

            {/* Reset password dialog */}
            <ConfirmDialog
                isOpen={resetModal.open}
                title={`Reset Password — ${resetModal.name}`}
                message={
                    <div>
                        <label className={s.fieldLabelSec}>New Password (min 8 characters)</label>
                        <input type="password" value={newPassword} onChange={e => setNewPassword(e.target.value)}
                            className={s.input} style={{ width: "100%", marginTop: 4 }}
                            onKeyDown={e => { if (e.key === "Enter" && newPassword.length >= 8) handleResetPassword(); }} />
                    </div>
                }
                confirmText="Reset Password"
                cancelText="Cancel"
                onConfirm={handleResetPassword}
                onCancel={() => setResetModal({ open: false, id: null, name: "" })}
            />
        </div>
    );
}
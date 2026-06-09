import React, { useState, useEffect, useCallback } from "react";
import {
    getTenants, getTenantOverview, suspendTenant, reactivateTenant,
    deleteTenantApi,
} from "../../api";
import {
    Building2, Pause, Play, Trash2, Users, Shield, X, Search, Calendar, Loader2,
} from "lucide-react";
import ConfirmDialog from "../../components/common/ConfirmDialog";
import RequestAccessModal from "./RequestAccessModal";
import s from "./Tenants.module.css";

const STATUS_COLORS: Record<string, { bg: string; fg: string }> = {
    active: { bg: "color-mix(in srgb, var(--success) 14%, transparent)", fg: "var(--success)" },
    suspended: { bg: "color-mix(in srgb, var(--warning) 14%, transparent)", fg: "var(--warning)" },
    deleted: { bg: "color-mix(in srgb, var(--danger) 14%, transparent)", fg: "var(--danger)" },
};

function Badge({ status }: { status?: string }) {
    const c = STATUS_COLORS[status || ""] || STATUS_COLORS.active;
    return <span className={s.badge} style={{ background: c.bg, color: c.fg }}>{status}</span>;
}

function Stat({ icon: Icon, value, label, accent }: { icon: any; value: React.ReactNode; label: string; accent?: boolean }) {
    return (
        <div className={s.stat}>
            <div className={`${s.statIcon} ${accent ? s.statIconAccent : s.statIconDefault}`}>
                <Icon size={18} />
            </div>
            <div>
                <div className={s.statValue}>{value}</div>
                <div className={s.statLabel}>{label}</div>
            </div>
        </div>
    );
}

interface TenantListProps {
    onSelectTenant: (id: number | string) => void;
}

export default function TenantList({ onSelectTenant }: TenantListProps) {
    const [tenants, setTenants] = useState<any[]>([]);
    const [overview, setOverview] = useState<any>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");
    const [search, setSearch] = useState("");
    const [statusFilter, setStatusFilter] = useState("");
    const [debouncedSearch, setDebouncedSearch] = useState("");

    const [suspendModal, setSuspendModal] = useState<{ open: boolean; id: number | string | null }>({ open: false, id: null });
    const [suspendReason, setSuspendReason] = useState("");
    const [suspendPassword, setSuspendPassword] = useState("");
    const [deleteModal, setDeleteModal] = useState<{ open: boolean; id: number | string | null; name: string }>({ open: false, id: null, name: "" });
    const [deletePassword, setDeletePassword] = useState("");
    // Tenant object whose Request-Access modal is currently open. null when closed.
    const [accessTenant, setAccessTenant] = useState<any>(null);

    useEffect(() => {
        const id = setTimeout(() => setDebouncedSearch(search), 300);
        return () => clearTimeout(id);
    }, [search]);

    const loadTenants = useCallback(async () => {
        try {
            const params: Record<string, string> = {};
            if (debouncedSearch) params.search = debouncedSearch;
            if (statusFilter) params.status = statusFilter;
            const [tenantsRes, overviewRes] = await Promise.all([
                getTenants(params as any),
                getTenantOverview(),
            ]);
            setTenants((tenantsRes.data as any).tenants);
            setOverview(overviewRes.data);
        } catch (e: any) {
            setError(e.response?.data?.error || "Failed to load tenants");
        } finally {
            setLoading(false);
        }
    }, [debouncedSearch, statusFilter]);

    useEffect(() => { loadTenants(); }, [loadTenants]);

    const handleSuspend = async () => {
        const { id } = suspendModal;
        const password = suspendPassword;
        const reason = suspendReason;
        // Close the dialog immediately, then perform the request. Any failure
        // (e.g. wrong password) surfaces in the page-level error banner.
        setSuspendModal({ open: false, id: null });
        setSuspendPassword("");
        try {
            await suspendTenant(id as any, reason, password);
            loadTenants();
        }
        catch (e: any) { setError(e.response?.data?.error || "Failed to suspend"); }
    };

    const handleReactivate = async (id: number | string) => {
        try { await reactivateTenant(id as any); loadTenants(); }
        catch (e: any) { setError(e.response?.data?.error || "Failed to reactivate"); }
    };

    const handleDelete = async () => {
        const { id } = deleteModal;
        const password = deletePassword;
        setDeleteModal({ open: false, id: null, name: "" });
        setDeletePassword("");
        try {
            await deleteTenantApi(id as any, false, password);
            loadTenants();
        }
        catch (e: any) { setError(e.response?.data?.error || "Failed to delete"); }
    };

    // The legacy direct-impersonate path was replaced by the consent-gated
    // Request Access flow. Clicking the card-level button just opens the
    // multi-step modal (the same one TenantDetail uses).
    const openAccessFlow = (tenant: any) => setAccessTenant(tenant);

    if (loading) return <div className={s.loading}><Loader2 size={20} className={s.spinner} /> Loading tenants…</div>;

    return (
        <div>
            {error && (
                <div className={s.errorBanner}>
                    <span className={s.errorText}>{error}</span>
                    <button onClick={() => setError("")} className={s.errorClose}><X size={16} /></button>
                </div>
            )}

            {overview && (
                <div className={s.overviewStats}>
                    <Stat icon={Building2} value={overview.total_tenants} label="Tenants" accent />
                    <Stat icon={Users} value={overview.total_users} label="Total Users" />
                    <Stat icon={Play} value={overview.by_status?.active || 0} label="Active" />
                    <Stat icon={Pause} value={overview.by_status?.suspended || 0} label="Suspended" />
                </div>
            )}

            <div className={s.toolbar}>
                <div className={s.searchWrap}>
                    <Search size={15} className={s.searchIcon} />
                    <input
                        type="text" placeholder="Search tenants…" value={search}
                        onChange={e => setSearch(e.target.value)}
                        className={s.searchInput}
                    />
                </div>
                <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)} className={s.statusSelect}>
                    <option value="">All Status</option>
                    <option value="active">Active</option>
                    <option value="suspended">Suspended</option>
                    <option value="deleted">Deleted</option>
                </select>
            </div>

            {tenants.length === 0 ? (
                <div className={s.emptyState}>No tenants found</div>
            ) : (
                <div className={s.tenantGrid}>
                    {tenants.map(t => (
                        <div key={t.id} className={s.tenantCard} onClick={() => onSelectTenant(t.id)}>
                            <div className={s.cardHeader}>
                                <div>
                                    <div className={s.cardOrgName}>
                                        <Building2 size={16} className={s.iconAccent} />
                                        {t.org_name}
                                    </div>
                                    <div className={s.cardSlug}>{t.slug}</div>
                                </div>
                                <Badge status={t.status} />
                            </div>
                            <div className={s.cardStats}>
                                <div className={s.cardStat}><Users size={14} /> <strong>{t.user_count || 0}</strong> users</div>
                                <div className={s.cardStat}><Calendar size={14} /> {new Date(t.created_at).toLocaleDateString()}</div>
                            </div>
                            <div className={s.cardActions} onClick={e => e.stopPropagation()}>
                                {t.status === "active" && (
                                    <button className={s.btnSmall} onClick={() => openAccessFlow(t)} title="Request consent-gated access to this tenant">
                                        <Shield size={13} /> Request Access
                                    </button>
                                )}
                                {t.status === "active" && (
                                    <button className={s.btnSmall} style={{ color: "var(--warning)" }}
                                        onClick={() => { setSuspendReason(""); setSuspendPassword(""); setSuspendModal({ open: true, id: t.id }); }}>
                                        <Pause size={13} /> Suspend
                                    </button>
                                )}
                                {t.status === "suspended" && (
                                    <button className={s.btnSmall} style={{ color: "var(--success)" }}
                                        onClick={() => handleReactivate(t.id)}>
                                        <Play size={13} /> Reactivate
                                    </button>
                                )}
                                {!t.is_default && (
                                    <button className={s.btnSmall} style={{ color: "var(--danger)" }}
                                        onClick={() => { setDeletePassword(""); setDeleteModal({ open: true, id: t.id, name: t.org_name }); }}>
                                        <Trash2 size={13} /> Delete
                                    </button>
                                )}
                            </div>
                        </div>
                    ))}
                </div>
            )}

            {/* Suspend dialog */}
            <ConfirmDialog
                isOpen={suspendModal.open}
                title="Suspend Tenant"
                message={
                    <div>
                        <p style={{ margin: "0 0 10px" }}>Provide a reason for suspending this tenant:</p>
                        <input
                            value={suspendReason}
                            onChange={e => setSuspendReason(e.target.value)}
                            placeholder="Suspension reason…"
                            className={s.input}
                            style={{ width: "100%", marginBottom: 10 }}
                        />
                        <p style={{ margin: "0 0 6px" }}>Re-enter your password to confirm:</p>
                        <input
                            type="password"
                            value={suspendPassword}
                            onChange={e => setSuspendPassword(e.target.value)}
                            placeholder="Your password"
                            autoComplete="current-password"
                            className={s.input}
                            style={{ width: "100%" }}
                            onKeyDown={e => { if (e.key === "Enter" && suspendReason.trim() && suspendPassword) handleSuspend(); }}
                        />
                    </div>
                }
                confirmText="Suspend"
                cancelText="Cancel"
                onConfirm={() => { if (suspendReason.trim() && suspendPassword) handleSuspend(); }}
                onCancel={() => { setSuspendModal({ open: false, id: null }); setSuspendPassword(""); }}
            />

            {/* Delete dialog */}
            <ConfirmDialog
                isOpen={deleteModal.open}
                title="Delete Tenant"
                message={
                    <div>
                        <p style={{ margin: "0 0 10px" }}>
                            Are you sure you want to delete "{deleteModal.name}"? This marks the tenant as deleted and is recorded in the audit log.
                        </p>
                        <p style={{ margin: "0 0 6px" }}>Re-enter your password to confirm:</p>
                        <input
                            type="password"
                            value={deletePassword}
                            onChange={e => setDeletePassword(e.target.value)}
                            placeholder="Your password"
                            autoComplete="current-password"
                            className={s.input}
                            style={{ width: "100%" }}
                            onKeyDown={e => { if (e.key === "Enter" && deletePassword) handleDelete(); }}
                        />
                    </div>
                }
                confirmText="Delete"
                cancelText="Cancel"
                isDanger
                onConfirm={() => { if (deletePassword) handleDelete(); }}
                onCancel={() => { setDeleteModal({ open: false, id: null, name: "" }); setDeletePassword(""); }}
            />

            {/* Consent-gated impersonation modal — same component used in TenantDetail */}
            {accessTenant && (
                <RequestAccessModal
                    tenant={accessTenant}
                    onClose={() => setAccessTenant(null)}
                />
            )}
        </div>
    );
}
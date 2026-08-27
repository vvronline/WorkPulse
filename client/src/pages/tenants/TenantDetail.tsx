import React, { useState, useEffect, useCallback } from "react";
import {
    getTenant, getTenantStats, getTenantUsers,
    suspendTenant, reactivateTenant, deleteTenantApi, updateTenant, updateTenantDomain, updateTenantLimits,
    getAdminOrganizations, updateAdminOrganization,
    getPlanCatalog, updateTenantPlan, updateTenantFeatures,
} from "../../api";
import {
    ArrowLeft, Building2, Users, Shield, Globe, Database, HardDrive,
    BarChart3, ExternalLink, Clock, Calendar, Settings2, Loader2,
    Pause, Play, Pencil, Building, UsersRound, GitBranch, X,
} from "lucide-react";
import Departments from "../../components/organization/Departments";
import Teams from "../../components/organization/Teams";
import OrgChartView from "../../components/organization/OrgChartView";
import OrgModal from "../admin/OrgModal";
import RequestAccessModal from "./RequestAccessModal";
import s from "./Tenants.module.css";

function InfoCard({ icon: Icon, label, value }: { icon: any; label: string; value?: React.ReactNode }) {
    return (
        <div className={s.infoCard}>
            <Icon size={16} className={s.iconAccent} />
            <div>
                <div className={s.infoCardLabel}>{label}</div>
                <div className={s.infoCardValue}>{value ?? "—"}</div>
            </div>
        </div>
    );
}

/** Bytes -> the largest sensible unit. Mirrors the server-side formatter. */
function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
    return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

/**
 * Live upload usage, with quota consumption when a limit is set.
 *
 * `storage_bytes` is null when usage could not be measured (local dev, or R2
 * unreachable). The caller must not render the card at all in that case — a
 * "0 MB" would read as "no uploads" rather than "not measured".
 */
function StorageValue({ bytes, objects, quotaMb }: {
    bytes: number; objects: number | null; quotaMb?: number | null;
}) {
    const pct = quotaMb ? Math.round((bytes / 1024 / 1024 / quotaMb) * 100) : null;
    // Warn before the quota actually bites, not after uploads start failing.
    const colour = pct === null ? undefined
        : pct >= 90 ? "var(--danger)"
            : pct >= 75 ? "var(--warning)" : undefined;

    return (
        <span style={colour ? { color: colour } : undefined}>
            {formatBytes(bytes)}
            {pct !== null && ` (${pct}% of ${quotaMb} MB)`}
            {objects !== null && (
                <span className={s.infoCardHint}> · {objects} file{objects === 1 ? "" : "s"}</span>
            )}
        </span>
    );
}

function Badge({ status }: { status?: string }) {
    const colors: Record<string, { bg: string; fg: string }> = {
        active: { bg: "color-mix(in srgb, var(--success) 14%, transparent)", fg: "var(--success)" },
        suspended: { bg: "color-mix(in srgb, var(--warning) 14%, transparent)", fg: "var(--warning)" },
        deleted: { bg: "color-mix(in srgb, var(--danger) 14%, transparent)", fg: "var(--danger)" },
    };
    const c = colors[status || ""] || colors.active;
    return <span className={s.badge} style={{ background: c.bg, color: c.fg }}>{status}</span>;
}

function formatWorkDays(wd?: string | number | null) {
    if (!wd) return "Mon–Fri";
    const names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    return String(wd).split(",").map(d => names[+d] || d).join(", ");
}

interface TenantDetailProps {
    tenantId: number | string;
    onBack: () => void;
}

export default function TenantDetail({ tenantId, onBack }: TenantDetailProps) {
    const [tenant, setTenant] = useState<any>(null);
    const [stats, setStats] = useState<any>(null);
    const [users, setUsers] = useState<any[]>([]);
    const [orgs, setOrgs] = useState<any[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");
    const [tab, setTab] = useState("overview");
    const [editingOrg, setEditingOrg] = useState<any>(null);
    const [showAccessModal, setShowAccessModal] = useState(false);
    // Password-confirm modal for destructive lifecycle actions (suspend/delete).
    // { action: 'suspend' | 'delete', hard?: boolean }
    const [confirmAction, setConfirmAction] = useState<{ action: string; hard?: boolean } | null>(null);
    const [confirmPassword, setConfirmPassword] = useState("");
    const [confirmReason, setConfirmReason] = useState("");
    const [confirmBusy, setConfirmBusy] = useState(false);
    const [confirmError, setConfirmError] = useState("");

    const loadData = useCallback(async () => {
        try {
            setLoading(true);
            const [tenantRes, statsRes, usersRes, orgsRes] = await Promise.all([
                getTenant(tenantId as any),
                getTenantStats(tenantId as any).catch(() => ({ data: null })),
                getTenantUsers(tenantId as any).catch(() => ({ data: { users: [] } })),
                getAdminOrganizations().catch(() => ({ data: { data: [] } })),
            ]);
            setTenant(tenantRes.data);
            setStats(statsRes.data);
            setUsers((usersRes.data as any).users || []);
            setOrgs((orgsRes.data as any).data || orgsRes.data || []);
        } catch (e: any) {
            setError(e.response?.data?.error || "Failed to load tenant");
        } finally {
            setLoading(false);
        }
    }, [tenantId]);

    useEffect(() => { loadData(); }, [loadData]);

    const org = tenant && orgs.find(o => o.slug === tenant.slug || o.name === tenant.org_name);

    // Open the multi-step consent flow instead of dropping in silently. The
    // legacy direct-impersonate path was removed in the consent-gated
    // refactor — see RequestAccessModal for the new UX.
    const openAccessFlow = () => setShowAccessModal(true);

    const handleReactivate = async () => {
        try { await reactivateTenant(tenantId as any); loadData(); }
        catch (e: any) { setError(e.response?.data?.error || "Failed"); }
    };

    const openConfirm = (action: string, opts: { hard?: boolean } = {}) => {
        setConfirmAction({ action, ...opts });
        setConfirmPassword("");
        setConfirmReason(action === "suspend" ? "Suspended by platform admin" : "");
        setConfirmError("");
    };

    const submitConfirm = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!confirmPassword) { setConfirmError("Password is required."); return; }
        setConfirmBusy(true); setConfirmError("");
        try {
            if (confirmAction?.action === "suspend") {
                await suspendTenant(tenantId as any, confirmReason || "Suspended by platform admin", confirmPassword);
                setConfirmAction(null);
                loadData();
            } else if (confirmAction?.action === "delete") {
                await deleteTenantApi(tenantId as any, confirmAction.hard as any, confirmPassword);
                setConfirmAction(null);
                onBack();
            }
        } catch (err: any) {
            setConfirmError(err.response?.data?.error || "Action failed");
        } finally {
            setConfirmBusy(false);
        }
    };

    const handleOrgUpdate = async (id: number | string, data: any) => {
        try { await updateAdminOrganization(id as any, data); setEditingOrg(null); loadData(); }
        catch (e: any) { setError(e.response?.data?.error || "Failed to update"); }
    };

    if (loading) return <div className={s.detailPage}><div className={s.loading}><Loader2 size={20} className={s.spinner} /> Loading tenant…</div></div>;
    if (!tenant) return <div className={s.detailPage}><div className={s.emptyMsg}>Tenant not found</div></div>;

    return (
        <div className={s.detailPage}>
            <button className={s.backBtn} onClick={onBack}><ArrowLeft size={16} /> Back to Tenants</button>

            {error && (
                <div className={s.errorBanner}>
                    <span className={s.errorText}>{error}</span>
                    <button onClick={() => setError("")} className={s.errorClose}><X size={16} /></button>
                </div>
            )}

            <div className={s.detailHeader}>
                <div className={s.detailTitle}>
                    <Building2 size={24} className={s.iconAccent} />
                    <div>
                        <h1>{tenant.org_name}</h1>
                        <span className={s.cellMono} style={{ color: "var(--text-muted)" }}>{tenant.slug}</span>
                    </div>
                    <Badge status={tenant.status} />
                </div>
                <div className={s.detailActions}>
                    {tenant.status === "active" && (
                        <button className={s.btnPrimary} onClick={openAccessFlow}>
                            <Shield size={14} /> Request Access
                        </button>
                    )}
                    {tenant.status === "active" && (
                        <button className={s.btnSmall} style={{ color: "var(--warning)" }} onClick={() => openConfirm("suspend")}>
                            <Pause size={14} /> Suspend
                        </button>
                    )}
                    {tenant.status === "suspended" && (
                        <button className={s.btnSmall} style={{ color: "var(--success)" }} onClick={handleReactivate}>
                            <Play size={14} /> Reactivate
                        </button>
                    )}
                    {!tenant.is_default && tenant.status !== "deleted" && (
                        <button className={s.btnSmall} style={{ color: "var(--danger)" }} onClick={() => openConfirm("delete", { hard: false })}>
                            <X size={14} /> Delete
                        </button>
                    )}
                </div>
            </div>

            <div className={s.detailTabs}>
                {[
                    { key: "overview", label: "Overview", icon: BarChart3 },
                    // Individual user data (PII) is only exposed for the default tenant —
                    // for privacy, every other tenant's user list is hidden here. The
                    // aggregate user count is still surfaced on the Overview tab.
                    ...(tenant.is_default ? [{ key: "users", label: `Users (${users.length})`, icon: Users }] : []),
                    // Org structure is resolved from the caller's own tenant DB, so it
                    // is only meaningful for the default tenant. For every other tenant
                    // structure is managed inside the workspace itself, reachable only
                    // through the consent-gated Request Access flow.
                    ...(tenant.is_default ? [
                        { key: "departments", label: "Departments", icon: Building },
                        { key: "teams", label: "Teams", icon: UsersRound },
                        { key: "chart", label: "Org Chart", icon: GitBranch },
                    ] : []),
                    { key: "settings", label: "Settings", icon: Settings2 },
                ].map(({ key, label, icon: Icon }) => (
                    <button key={key} onClick={() => setTab(key)}
                        className={`${s.detailTab} ${tab === key ? s.detailTabActive : ""}`}>
                        <Icon size={14} /> {label}
                    </button>
                ))}
            </div>

            {/* Overview */}
            {tab === "overview" && (
                <div className={s.overviewGrid}>
                    <InfoCard icon={Globe} label="Custom Domain" value={tenant.custom_domain || "None"} />
                    <InfoCard icon={Database} label="Database" value={tenant.db_name || "—"} />
                    <InfoCard icon={Users} label="Max Users" value={tenant.max_users || "∞"} />
                    <InfoCard icon={HardDrive} label="Max Storage" value={tenant.max_storage_mb ? `${tenant.max_storage_mb} MB` : "∞"} />
                    <InfoCard icon={Users} label="User Count" value={tenant.user_count || 0} />
                    {stats && <InfoCard icon={Database} label="DB Size" value={`${(stats.db_size_bytes / 1024 / 1024).toFixed(1)} MB`} />}
                    {/* Live R2 upload usage. Hidden (not zeroed) when unmeasurable —
                        see tenantStorageStatsFields on the server. Uploads are what
                        max_storage_mb meters, and they dwarf the database. */}
                    {stats?.storage_bytes != null && (
                        <InfoCard
                            icon={HardDrive}
                            label="Upload Storage"
                            value={<StorageValue
                                bytes={stats.storage_bytes}
                                objects={stats.storage_objects ?? null}
                                quotaMb={tenant.max_storage_mb}
                            />}
                        />
                    )}
                    {/* Business-activity metrics are tenant-private: the server only
                        returns them for the default tenant or during an approved
                        access session. Hide the cards rather than show zeroes. */}
                    {stats && !stats.activity_restricted && <>
                        <InfoCard icon={BarChart3} label="Tasks" value={stats.task_count} />
                        <InfoCard icon={ExternalLink} label="Messages" value={stats.message_count} />
                    </>}
                    {stats?.activity_restricted && (
                        <div className={s.emptyMsg} style={{ gridColumn: "1 / -1" }}>
                            Activity metrics are hidden. Request access to view this tenant's activity.
                        </div>
                    )}
                    {org && <>
                        <InfoCard icon={Clock} label="Work Hours" value={`${org.work_hours_per_day || 8}h / day`} />
                        <InfoCard icon={Calendar} label="Work Days" value={formatWorkDays(org.work_days)} />
                        <InfoCard icon={Globe} label="Timezone" value={org.timezone || "UTC"} />
                    </>}
                </div>
            )}

            {/* Users — default tenant only (PII privacy guard) */}
            {tab === "users" && tenant.is_default && (
                <div>
                    {users.length === 0 ? <div className={s.emptyMsg}>No users found</div> : (
                        <table className={s.table}>
                            <thead>
                                <tr><th>Name</th><th>Username</th><th>Email</th><th>Role</th><th>Status</th></tr>
                            </thead>
                            <tbody>
                                {users.map(u => (
                                    <tr key={u.id}>
                                        <td className={s.cellBold}>{u.full_name}</td>
                                        <td className={s.cellMono}>{u.username}</td>
                                        <td className={s.cellSecondary}>{u.email}</td>
                                        <td><span className={s.badgeRole}>{u.role}</span></td>
                                        <td>{u.is_active !== false ? <span className={s.badgeActive}>active</span> : <span className={s.badgeInactive}>inactive</span>}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    )}
                </div>
            )}

            {/* Departments / Teams / Org Chart — default tenant only. The
                `is_default` check is repeated here (not just in the tab list)
                because `tab` state survives navigating between tenants. */}
            {tab === "departments" && tenant.is_default && (org ? <Departments orgId={org.id} userRole="platform_admin" /> : <div className={s.emptyMsg}>No linked organization found</div>)}

            {tab === "teams" && tenant.is_default && (org ? <Teams orgId={org.id} userRole="platform_admin" /> : <div className={s.emptyMsg}>No linked organization found</div>)}

            {tab === "chart" && tenant.is_default && (org ? <OrgChartView orgId={org.id} /> : <div className={s.emptyMsg}>No linked organization found</div>)}

            {/* Settings */}
            {tab === "settings" && (
                <TenantSettings tenant={tenant} org={org} onEditOrg={() => setEditingOrg(org)} onReload={loadData} />
            )}

            {editingOrg && <OrgModal org={editingOrg} onClose={() => setEditingOrg(null)} onSave={(data: any) => handleOrgUpdate(editingOrg.id, data)} />}

            {showAccessModal && (
                <RequestAccessModal
                    tenant={tenant}
                    onClose={() => setShowAccessModal(false)}
                />
            )}

            {confirmAction && (
                <div className={s.modalScrim} onClick={() => !confirmBusy && setConfirmAction(null)}>
                    <div className={s.modalCard} onClick={e => e.stopPropagation()} style={{ maxWidth: 440 }}>
                        <h3 style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
                            <Shield size={18} />
                            {confirmAction.action === "suspend" ? "Suspend tenant" : "Delete tenant"}
                        </h3>
                        <p style={{ fontSize: 13, color: "var(--text-secondary)" }}>
                            {confirmAction.action === "suspend"
                                ? `This will suspend "${tenant.org_name}" and block all its users from signing in.`
                                : `This will ${confirmAction.hard ? "PERMANENTLY delete" : "mark as deleted"} "${tenant.org_name}". This action is recorded in the audit log.`}
                            {" "}Re-enter your password to confirm.
                        </p>
                        {confirmError && <div className={s.errorBanner}><span className={s.errorText}>{confirmError}</span></div>}
                        <form onSubmit={submitConfirm}>
                            {confirmAction.action === "suspend" && (
                                <div style={{ marginBottom: 10 }}>
                                    <label className={s.fieldLabel}>Reason (optional)</label>
                                    <input
                                        type="text"
                                        value={confirmReason}
                                        onChange={e => setConfirmReason(e.target.value)}
                                        className={s.inputFull}
                                        placeholder="Reason for suspension"
                                    />
                                </div>
                            )}
                            <div style={{ marginBottom: 12 }}>
                                <label className={s.fieldLabel}>Your password</label>
                                <input
                                    type="password"
                                    value={confirmPassword}
                                    onChange={e => setConfirmPassword(e.target.value)}
                                    className={s.inputFull}
                                    placeholder="Enter your password"
                                    autoFocus
                                    autoComplete="current-password"
                                    required
                                />
                            </div>
                            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
                                <button type="button" className={s.btnSmall} onClick={() => setConfirmAction(null)} disabled={confirmBusy}>
                                    Cancel
                                </button>
                                <button
                                    type="submit"
                                    className={s.btnPrimary}
                                    style={{ color: confirmAction.action === "delete" ? "var(--danger)" : undefined }}
                                    disabled={confirmBusy}
                                >
                                    {confirmBusy ? "Working…" : confirmAction.action === "suspend" ? "Suspend" : "Delete"}
                                </button>
                            </div>
                        </form>
                    </div>
                </div>
            )}
        </div>
    );
}

/* ── Tenant Settings sub-section ── */
function TenantSettings({ tenant, org, onEditOrg, onReload }: { tenant: any; org: any; onEditOrg: () => void; onReload: () => void }) {
    const [orgName, setOrgName] = useState(tenant.org_name || "");
    const [domain, setDomain] = useState(tenant.custom_domain || "");
    const [maxUsers, setMaxUsers] = useState<number | string>(tenant.max_users || "");
    const [maxStorage, setMaxStorage] = useState<number | string>(tenant.max_storage_mb || "");
    const [saving, setSaving] = useState(false);
    const [msg, setMsg] = useState("");
    const [domainError, setDomainError] = useState("");

    // Plan & Features
    const [plans, setPlans] = useState<any>(null);
    const [featureLabels, setFeatureLabels] = useState<Record<string, string>>({});
    const [currentPlan, setCurrentPlan] = useState(tenant.plan || "standard");
    const [overrides, setOverrides] = useState<Record<string, boolean>>(tenant.features || {});

    useEffect(() => {
        setOrgName(tenant.org_name || "");
        setDomain(tenant.custom_domain || "");
        setMaxUsers(tenant.max_users || "");
        setMaxStorage(tenant.max_storage_mb || "");
        setCurrentPlan(tenant.plan || "standard");
        setOverrides(tenant.features || {});
        setMsg("");
        setDomainError("");
    }, [tenant.id]);

    useEffect(() => {
        getPlanCatalog().then(res => {
            setPlans((res.data as any).plans);
            setFeatureLabels((res.data as any).feature_labels || {});
        }).catch(() => { });
    }, []);

    const DOMAIN_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i;

    const handleDomainChange = (val: string) => {
        setDomain(val);
        setDomainError(val && !DOMAIN_RE.test(val) ? "Enter a valid domain (e.g. app.company.com)" : "");
    };

    const saveName = async () => {
        const trimmed = orgName.trim();
        if (!trimmed) { setMsg("Organization name cannot be empty"); return; }
        if (trimmed === tenant.org_name) return;
        setSaving(true); setMsg("");
        try { await updateTenant(tenant.id, { org_name: trimmed }); setMsg("Name updated"); onReload(); }
        catch (e: any) { setMsg(e.response?.data?.error || "Failed"); }
        finally { setSaving(false); }
    };

    const saveDomain = async () => {
        if (domain && !DOMAIN_RE.test(domain)) { setDomainError("Enter a valid domain"); return; }
        setSaving(true); setMsg("");
        try { await updateTenantDomain(tenant.id, domain); setMsg("Domain updated"); onReload(); }
        catch (e: any) { setMsg(e.response?.data?.error || "Failed"); }
        finally { setSaving(false); }
    };

    const saveLimits = async () => {
        setSaving(true); setMsg("");
        try {
            await updateTenantLimits(tenant.id, {
                max_users: maxUsers ? Number(maxUsers) : null,
                max_storage_mb: maxStorage ? Number(maxStorage) : null,
            } as any);
            setMsg("Limits updated"); onReload();
        } catch (e: any) { setMsg(e.response?.data?.error || "Failed"); }
        finally { setSaving(false); }
    };

    const handlePlanChange = async (newPlan: string) => {
        setSaving(true); setMsg("");
        try {
            await updateTenantPlan(tenant.id, newPlan, true);
            setCurrentPlan(newPlan);
            setMsg("Plan updated");
            onReload();
        } catch (e: any) { setMsg(e.response?.data?.error || "Failed to change plan"); }
        finally { setSaving(false); }
    };

    const handleFeatureOverride = (featureKey: string, value: string) => {
        const newOverrides = { ...overrides };
        if (value === "default") {
            delete newOverrides[featureKey];
        } else {
            newOverrides[featureKey] = value === "on";
        }
        setOverrides(newOverrides);
    };

    const saveFeatures = async () => {
        setSaving(true); setMsg("");
        try {
            await updateTenantFeatures(tenant.id, overrides);
            setMsg("Features updated");
            onReload();
        } catch (e: any) { setMsg(e.response?.data?.error || "Failed"); }
        finally { setSaving(false); }
    };

    const allFeatureKeys = plans ? Object.keys(plans[currentPlan]?.features || {}) : [];

    return (
        <div className={s.settingsWrap}>
            {msg && <div className={s.settingsMsg}>{msg}</div>}

            {/* Tenant Details (name). Slug is immutable — it's tied to the
                tenant DB name and domain routing, so it's shown read-only. */}
            <fieldset className={s.fieldset}>
                <legend className={s.legend}>Tenant Details</legend>
                <div className={s.fieldRow}>
                    <input value={orgName} onChange={e => setOrgName(e.target.value)}
                        placeholder="Organization name"
                        className={s.inputFull} />
                    <button onClick={saveName} disabled={saving || !orgName.trim() || orgName.trim() === tenant.org_name} className={s.saveBtn}>Save</button>
                </div>
                {tenant.slug && (
                    <p style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 6 }}>
                        Slug: <strong>{tenant.slug}</strong> (cannot be changed after creation)
                    </p>
                )}
            </fieldset>

            {/* Plan Management */}
            <fieldset className={s.fieldset}>
                <legend className={s.legend}>Subscription Plan</legend>
                <div className={s.planSelector}>
                    <span className={s.planBadge}>{plans?.[currentPlan]?.label || currentPlan}</span>
                    <select
                        value={currentPlan}
                        onChange={e => handlePlanChange(e.target.value)}
                        disabled={saving}
                    >
                        {plans && Object.entries(plans).map(([key, p]: [string, any]) => (
                            <option key={key} value={key}>{p.label} — {p.description}</option>
                        ))}
                    </select>
                </div>
            </fieldset>

            {/* Feature Overrides */}
            {plans && (
                <fieldset className={s.fieldset}>
                    <legend className={s.legend}>Feature Overrides</legend>
                    <p style={{ fontSize: 12, color: "var(--text-secondary)", marginBottom: 10 }}>
                        Override individual features from the plan defaults. "Default" uses the plan setting.
                    </p>
                    <div className={s.featureGrid}>
                        {allFeatureKeys.map(key => {
                            const planDefault = plans[currentPlan].features[key];
                            const hasOverride = key in overrides;
                            const currentState = hasOverride ? (overrides[key] ? "on" : "off") : "default";
                            return (
                                <div key={key} className={s.featureRow}>
                                    <div className={s.featureRowLabel}>
                                        <span>{featureLabels[key] || key}</span>
                                        <span className={`${s.featureDefault} ${planDefault ? s.featureDefaultOn : s.featureDefaultOff}`}>
                                            {planDefault ? "Plan: ON" : "Plan: OFF"}
                                        </span>
                                    </div>
                                    <div className={s.featureToggle}>
                                        <button
                                            className={currentState === "default" ? s.featureToggleActive : ""}
                                            onClick={() => handleFeatureOverride(key, "default")}
                                        >Default</button>
                                        <button
                                            className={currentState === "on" ? s.featureToggleActive : ""}
                                            onClick={() => handleFeatureOverride(key, "on")}
                                        >On</button>
                                        <button
                                            className={currentState === "off" ? s.featureToggleActive : ""}
                                            onClick={() => handleFeatureOverride(key, "off")}
                                        >Off</button>
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                    <div style={{ marginTop: 12, display: "flex", justifyContent: "flex-end" }}>
                        <button onClick={saveFeatures} disabled={saving} className={s.saveBtn}>Save Features</button>
                    </div>
                </fieldset>
            )}

            <fieldset className={s.fieldset}>
                <legend className={s.legend}>Custom Domain</legend>
                <div className={s.fieldRow}>
                    <input value={domain} onChange={e => handleDomainChange(e.target.value)}
                        placeholder="e.g. app.company.com"
                        className={`${s.inputFull} ${domainError ? s.inputError : ""}`} />
                    <button onClick={saveDomain} disabled={saving || !!domainError} className={s.saveBtn}>Save</button>
                </div>
                {domainError && <div className={s.fieldError}>{domainError}</div>}
            </fieldset>

            <fieldset className={s.fieldset}>
                <legend className={s.legend}>Limits</legend>
                <div className={s.fieldRowWrap}>
                    <div>
                        <label className={s.fieldLabel}>Max Users</label>
                        <input type="number" value={maxUsers} onChange={e => setMaxUsers(e.target.value)} placeholder="∞" className={s.inputSmall} />
                    </div>
                    <div>
                        <label className={s.fieldLabel}>Max Storage (MB)</label>
                        <input type="number" value={maxStorage} onChange={e => setMaxStorage(e.target.value)} placeholder="∞" className={s.inputSmall} />
                    </div>
                    <button onClick={saveLimits} disabled={saving} className={s.saveBtn}>Save Limits</button>
                </div>
            </fieldset>

            {org && (
                <fieldset className={s.fieldset}>
                    <legend className={s.legend}>Organization Settings</legend>
                    <div className={s.fieldRowWrap}>
                        <span style={{ fontSize: 13, color: "var(--text-secondary)" }}>
                            Timezone: <strong>{org.timezone || "UTC"}</strong> · Work hours: <strong>{org.work_hours_per_day || 8}h</strong> · Work days: <strong>{formatWorkDays(org.work_days)}</strong> · Fiscal year: <strong>Month {org.fiscal_year_start || 1}</strong>
                        </span>
                        <button onClick={onEditOrg} className={s.btnSmall}>
                            <Pencil size={13} /> Edit Org Settings
                        </button>
                    </div>
                </fieldset>
            )}
        </div>
    );
}
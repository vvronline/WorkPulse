import React, { useState, useEffect, useMemo, useCallback } from "react";
import { useSearchParams } from "react-router-dom";
import {
    Building2, Plus, Shield, Settings2, ScrollText, Activity,
    LayoutDashboard, Menu, X, ChevronDown, ArrowLeft, CreditCard,
} from "lucide-react";
import { useAuth } from "../../AuthContext";
import PlatformDashboard from "./PlatformDashboard";
import TenantList from "./TenantList";
import TenantDetail from "./TenantDetail";
import CreateTenant from "./CreateTenant";
import PlatformAdmins from "./PlatformAdmins";
import PlatformSettings from "./PlatformSettings";
import PlatformAuditLogs from "./PlatformAuditLogs";
import PlanManagement from "./PlanManagement";
import s from "../admin/AdminLayout.module.css";

// ─── Section registry ────────────────────────────────────────────────────────
//
// Each section: { key, label, icon, group }
//
// Mirrors the admin panel structure so the platform console feels familiar
// to anyone already comfortable with /admin.

interface Section {
    key: string;
    label: string;
    icon: any;
    group: string;
}

const SECTIONS: Section[] = [
    { key: "dashboard", label: "Dashboard", icon: LayoutDashboard, group: "Overview" },

    { key: "tenants", label: "Tenants", icon: Building2, group: "Tenants" },
    { key: "create", label: "New Tenant", icon: Plus, group: "Tenants" },

    { key: "plans", label: "Plans", icon: CreditCard, group: "Configuration" },
    { key: "admins", label: "Platform Admins", icon: Shield, group: "Access" },
    { key: "settings", label: "Platform Settings", icon: Settings2, group: "Access" },

    { key: "audit", label: "Audit Trail", icon: ScrollText, group: "Compliance" },
];

const GROUP_ORDER = ["Overview", "Tenants", "Configuration", "Access", "Compliance"];

export default function TenantsPage() {
    const { user } = useAuth() as any;
    const [searchParams, setSearchParams] = useSearchParams();

    const initialSection = searchParams.get("tab") || "dashboard";
    const [section, setSection] = useState(initialSection);

    // Selected tenant for the drill-down detail view
    const [selectedTenantId, setSelectedTenantId] = useState<any>(null);

    // Sidebar group collapsed state (persisted)
    const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() => {
        try {
            const raw = localStorage.getItem("platform_groups_collapsed");
            return raw ? JSON.parse(raw) : {};
        } catch { return {}; }
    });
    useEffect(() => {
        try { localStorage.setItem("platform_groups_collapsed", JSON.stringify(collapsed)); } catch {}
    }, [collapsed]);

    // Mobile drawer
    const [mobileOpen, setMobileOpen] = useState(false);

    // Sync ?tab= changes from outside (e.g. global search deep-links)
    useEffect(() => {
        const t = searchParams.get("tab") || "dashboard";
        if (t !== section) setSection(t);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [searchParams]);

    const goSection = useCallback((key: string) => {
        setSection(key);
        setSelectedTenantId(null);
        setMobileOpen(false);
        const next = new URLSearchParams(searchParams);
        if (key === "dashboard") next.delete("tab");
        else next.set("tab", key);
        setSearchParams(next, { replace: true });
    }, [searchParams, setSearchParams]);

    // Build navigation grouped by group label
    const navGroups = useMemo(() => {
        const groups = new Map<string, Section[]>();
        for (const sec of SECTIONS) {
            if (!groups.has(sec.group)) groups.set(sec.group, []);
            groups.get(sec.group)!.push(sec);
        }
        return GROUP_ORDER.filter(g => groups.has(g)).map(g => ({ name: g, items: groups.get(g)! }));
    }, []);

    const currentSection = SECTIONS.find(sec => sec.key === section) || SECTIONS[0];
    const currentTitle = selectedTenantId ? "Tenant Details" : currentSection.label;

    // Access check: platform_admin only — tenant super_admins must not see the
    // platform-wide console; they administer their own org from /admin.
    if (!user || user.role !== "platform_admin") {
        return (
            <div className={s.shell}>
                <div className={s.content}>
                    <h1>Platform Console</h1>
                    <div className={s.accessDenied}>
                        Access denied. Platform Admin role required.
                    </div>
                </div>
            </div>
        );
    }

    const toggleGroup = (groupName: string) => {
        setCollapsed(c => ({ ...c, [groupName]: !c[groupName] }));
    };

    // ─── Section renderer ────────────────────────────────────────────────
    const renderSection = () => {
        if (selectedTenantId) {
            return (
                <TenantDetail
                    tenantId={selectedTenantId}
                    onBack={() => setSelectedTenantId(null)}
                />
            );
        }
        switch (section) {
            case "dashboard":
                return <PlatformDashboard />;
            case "tenants":
                return <TenantList onSelectTenant={setSelectedTenantId} />;
            case "create":
                return <CreateTenant onCreated={(id: any) => setSelectedTenantId(id)} />;
            case "plans":
                return <PlanManagement />;
            case "admins":
                return <PlatformAdmins />;
            case "settings":
                return <PlatformSettings />;
            case "audit":
                return <PlatformAuditLogs />;
            default:
                return <PlatformDashboard />;
        }
    };

    return (
        <div className={s.shell}>
            {/* Mobile top bar */}
            <div className={s.mobileBar}>
                <button className={s.mobileToggle} onClick={() => setMobileOpen(true)} aria-label="Open platform menu">
                    <Menu size={16} /> Menu
                </button>
                <div className={s.mobileTitle}>{currentTitle}</div>
                <span style={{ width: 70 }} />
            </div>

            {/* Mobile scrim */}
            <div
                className={`${s.scrim} ${mobileOpen ? s.open : ""}`}
                onClick={() => setMobileOpen(false)}
                aria-hidden="true"
            />

            {/* ─── Sidebar ─── */}
            <aside className={`${s.sidebar} ${mobileOpen ? s.open : ""}`} aria-label="Platform navigation">
                <div className={s.brandRow}>
                    <Activity size={18} />
                    <div>
                        <div className={s.brandTitle}>Platform Console</div>
                        <div className={s.brandSubtitle}>
                            {user.role === "platform_admin" ? "Platform Admin" : "Super Admin"}
                        </div>
                    </div>
                    <button
                        className={s.mobileToggle}
                        style={{ marginLeft: "auto", padding: "0.25rem 0.4rem", display: "none" }}
                        onClick={() => setMobileOpen(false)}
                        aria-label="Close menu"
                    >
                        <X size={14} />
                    </button>
                </div>

                {navGroups.map(group => {
                    const isCollapsed = !!collapsed[group.name];
                    return (
                        <div className={s.group} key={group.name}>
                            <button
                                type="button"
                                className={`${s.groupLabel} ${isCollapsed ? s.collapsed : ""}`}
                                onClick={() => toggleGroup(group.name)}
                            >
                                <span>{group.name}</span>
                                <ChevronDown size={12} className={s.chev} />
                            </button>
                            {!isCollapsed && (
                                <div className={s.groupItems}>
                                    {group.items.map(item => {
                                        const Icon = item.icon;
                                        const isActive = section === item.key && !selectedTenantId;
                                        return (
                                            <button
                                                key={item.key}
                                                className={`${s.navItem} ${isActive ? s.active : ""}`}
                                                onClick={() => goSection(item.key)}
                                            >
                                                <span className={s.navIcon}><Icon size={16} /></span>
                                                <span className={s.navLabel}>{item.label}</span>
                                            </button>
                                        );
                                    })}
                                </div>
                            )}
                        </div>
                    );
                })}

                {/* Back to /admin link */}
                <div className={s.group}>
                    <div className={s.groupLabel} style={{ cursor: "default" }}>
                        <span>Switch</span>
                    </div>
                    <div className={s.groupItems}>
                        <button
                            className={s.navItem}
                            onClick={() => { window.location.href = "/admin"; }}
                            title="Back to your organization's admin panel"
                        >
                            <span className={s.navIcon}><ArrowLeft size={16} /></span>
                            <span className={s.navLabel}>Back to Admin</span>
                        </button>
                    </div>
                </div>
            </aside>

            {/* ─── Content ─── */}
            <main className={s.content}>
                <div className={s.contentHeader}>
                    <div>
                        <h1 className={s.contentTitle}>{currentTitle}</h1>
                        {!selectedTenantId && currentSection.key === "tenants" && (
                            <p className={s.contentDesc}>
                                Manage every tenant on the platform. Suspend, restore, impersonate,
                                or drill into a tenant's resources.
                            </p>
                        )}
                        {!selectedTenantId && currentSection.key === "create" && (
                            <p className={s.contentDesc}>
                                Provision a new tenant. A dedicated database is created and the schema initialised.
                            </p>
                        )}
                        {!selectedTenantId && currentSection.key === "admins" && (
                            <p className={s.contentDesc}>
                                Manage platform-level administrators (these accounts can act across all tenants).
                            </p>
                        )}
                        {!selectedTenantId && currentSection.key === "settings" && (
                            <p className={s.contentDesc}>
                                Global settings that apply across every tenant.
                            </p>
                        )}
                        {!selectedTenantId && currentSection.key === "audit" && (
                            <p className={s.contentDesc}>
                                Platform-wide audit trail across every tenant.
                            </p>
                        )}
                    </div>
                </div>
                {renderSection()}
            </main>
        </div>
    );
}
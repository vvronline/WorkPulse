import React, { useState, useEffect, useMemo, useCallback } from "react";
import {
    Home, Users, UserPlus, Building, UsersRound, GitBranch, ScrollText,
    RefreshCw, DollarSign, Settings as SettingsIcon,
    Menu, X, ChevronDown, ExternalLink, Workflow as WorkflowIcon,
    Wallet, Receipt, CreditCard, Folder, GitMerge, Shield,
} from "lucide-react";
import { useAuth } from "../../AuthContext";
import { useFeatures } from "../../FeaturesContext";
import { useSearchParams, useNavigate } from "react-router-dom";
import { getRoleChangeRequests, getCurrentOrg } from "../../api";
import UserManagement from "./UserManagement";
import AddPeopleWizard from "./AddPeopleWizard";
import MyOrganization from "./MyOrganization";
import AuditLogs from "./AuditLogs";
import RoleRequests from "./RoleRequests";
import PayPeriods from "./PayPeriods";
import CompensationSetup from "./CompensationSetup";
import SalarySlips from "./SalarySlips";
import PaymentSettings from "./PaymentSettings";
import TaskLabelsTab from "./TaskLabelsTab";
import AdminHome from "./AdminHome";
import PlatformAccessInbox from "./PlatformAccessInbox";
import OrgSettingsPage from "./OrgSettingsPage";
import Departments from "../../components/organization/Departments";
import Teams from "../../components/organization/Teams";
import OrgChartView from "../../components/organization/OrgChartView";
import AgileSettings from "../AgileSettings";
// Stage 3 — Projects + GitHub integrations live inside Admin → Structure /
// Integrations rather than as separate top-level pages. The page components
// themselves are still standalone files and unchanged.
import Projects from "../Projects";
import Integrations from "../Integrations";
import s from "./AdminLayout.module.css";
import type { LucideIcon } from "lucide-react";

// ─── Section registry ─────────────────────────────────────────────────────
//
// Each section: { key, label, icon, group, requires?, hidden?, badgeKey? }
//   requires: 'orgId' | 'super' | function(user) => boolean
//
// Note: tenant management, announcements, and platform-wide registration
// settings have moved to /platform — they are not listed here.

interface Section {
    key: string;
    label: string;
    icon: LucideIcon;
    group: string;
    requires?: string | ((user: any) => boolean);
    feature?: string;
    badgeKey?: string;
    hidden?: boolean;
}

const SECTIONS: Section[] = [
    { key: "home",           label: "Home",              icon: Home,         group: "Overview" },

    { key: "users",          label: "Users",             icon: Users,        group: "People" },
    { key: "add",            label: "Add People",        icon: UserPlus,     group: "People" },
    { key: "role-requests",  label: "Role Requests",     icon: RefreshCw,    group: "People", badgeKey: "roleRequests" },

    { key: "departments",    label: "Departments",       icon: Building,     group: "Structure", requires: "orgId" },
    { key: "teams",          label: "Teams",             icon: UsersRound,   group: "Structure", requires: "orgId" },
    { key: "org-chart",      label: "Org Chart",         icon: GitBranch,    group: "Structure", requires: "orgId" },
    { key: "agile",          label: "Agile Config",      icon: WorkflowIcon, group: "Structure", requires: "orgId", feature: "agile" },
    { key: "projects",       label: "Projects",          icon: Folder,       group: "Structure", requires: "orgId", feature: "agile" },

    { key: "integrations",   label: "Integrations",      icon: GitMerge,     group: "Settings",  requires: "orgId" },

    { key: "payroll",        label: "Payroll Periods",   icon: DollarSign,   group: "Operations", feature: "payroll" },
    { key: "compensation",   label: "Compensation",      icon: Wallet,       group: "Operations", requires: "orgId", feature: "payroll" },
    { key: "salary-slips",   label: "Salary Slips",      icon: Receipt,      group: "Operations", requires: "orgId", feature: "payroll" },
    { key: "payment-config", label: "Payment Settings",  icon: CreditCard,   group: "Operations", requires: "orgId", feature: "payroll" },
    // Task Labels moved into Agile Config → Labels tab; the legacy
    // ?tab=labels URL still routes to the Agile Config page below.

    { key: "audit",          label: "Audit Logs",        icon: ScrollText,   group: "Compliance" },
    // Platform Support Access — tenant super admins approve / deny incoming
    // platform_admin impersonation requests here, and revoke active sessions.
    // Visible to super_admin AND hr_admin — both can approve incoming
    // platform-admin support sessions. Matches server-side APPROVER_ROLES
    // in routes/platformAccess.js.
    { key: "platform-access", label: "Platform Access", icon: Shield,        group: "Compliance", requires: "approver" },
    // Org Settings owns branding/email templates/general org config — it's
    // a configuration surface, not a compliance one. Promote it into its
    // own "Settings" group so it's findable.
    { key: "org-settings",   label: "Org Settings",      icon: SettingsIcon, group: "Settings",   requires: "orgId" },
];

// Back-compat alias map (old ?tab= values → new section keys)
const TAB_ALIASES: Record<string, string> = {
    structure:     "departments",
    create:        "add",     // legacy "Create User" key → unified wizard
    import:        "add",     // legacy "Import Users" key → unified wizard
    settings:      "org-settings",  // legacy registration-settings key → unified org settings
    announcements: "home",    // moved to /platform
    labels:        "agile",   // Task Labels merged into Agile Config (Labels tab)
};

const GROUP_ORDER = ["Overview", "People", "Structure", "Operations", "Compliance", "Settings"];

function isAllowed(section: Section, user: any, hasFeature: (f: string) => boolean): boolean {
    if (section.feature && !hasFeature(section.feature)) return false;
    if (!section.requires) return true;
    if (section.requires === "orgId") return !!user?.org_id;
    if (section.requires === "super") {
        return user?.role === "super_admin" || user?.role === "platform_admin";
    }
    if (section.requires === "approver") {
        // Roles that can approve platform-admin support sessions
        return ["super_admin", "hr_admin", "platform_admin"].includes(user?.role);
    }
    if (typeof section.requires === "function") return section.requires(user);
    return true;
}

export default function AdminPanel() {
    const { user } = useAuth() as any;
    const { hasFeature } = useFeatures() as any;
    const [searchParams, setSearchParams] = useSearchParams();
    const navigate = useNavigate();
    const isPlatform = user?.role === "platform_admin";
    const canSeePlatformConsole = isPlatform;

    // Resolve current section from URL (back-compat with old ?tab= values)
    const initialSection = (() => {
        const t = searchParams.get("tab") || "home";
        return TAB_ALIASES[t] || t;
    })();
    const [section, setSection] = useState(initialSection);

    // Sidebar group collapsed state (persisted)
    const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() => {
        try {
            const raw = localStorage.getItem("admin_groups_collapsed");
            return raw ? JSON.parse(raw) : {};
        } catch { return {}; }
    });
    useEffect(() => {
        try { localStorage.setItem("admin_groups_collapsed", JSON.stringify(collapsed)); } catch {}
    }, [collapsed]);

    // Mobile drawer
    const [mobileOpen, setMobileOpen] = useState(false);

    // Badges (pending counts)
    const [badges, setBadges] = useState<Record<string, number>>({ roleRequests: 0 });
    const refreshBadges = useCallback(() => {
        getRoleChangeRequests({ status: "pending" })
            .then(r => setBadges(b => ({ ...b, roleRequests: ((r.data as any[]) || []).length })))
            .catch(() => {});
    }, []);
    useEffect(() => { refreshBadges(); }, [refreshBadges]);

    // Org-id for structure sub-pages
    const [orgId, setOrgId] = useState<number | string | null>(null);
    useEffect(() => {
        if (!user?.org_id) { setOrgId(null); return; }
        getCurrentOrg().then(r => setOrgId((r.data as any)?.id || user.org_id)).catch(() => setOrgId(user.org_id));
    }, [user?.org_id]);

    // Sync with URL changes from outside (GlobalSearch etc.)
    useEffect(() => {
        const t = searchParams.get("tab");
        if (!t) return;
        const resolved = TAB_ALIASES[t] || t;
        if (resolved !== section) setSection(resolved);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [searchParams]);

    const goSection = useCallback((key: string) => {
        setSection(key);
        setMobileOpen(false);
        const next = new URLSearchParams(searchParams);
        if (key === "home") next.delete("tab");
        else next.set("tab", key);
        setSearchParams(next, { replace: true });
        if (key === "home" || key === "role-requests" || key === "users") refreshBadges();
    }, [searchParams, setSearchParams, refreshBadges]);

    // Build allowed nav grouped by group label
    const navGroups = useMemo(() => {
        const groups = new Map<string, Section[]>();
        for (const sec of SECTIONS) {
            if (!isAllowed(sec, user, hasFeature)) continue;
            if (!groups.has(sec.group)) groups.set(sec.group, []);
            groups.get(sec.group)!.push(sec);
        }
        return GROUP_ORDER.filter(g => groups.has(g)).map(g => ({ name: g, items: groups.get(g)! }));
    }, [user, hasFeature]);

    const currentSection = SECTIONS.find(sec => sec.key === section) || SECTIONS[0];
    const currentTitle = currentSection.label === "Home" ? "Admin Panel" : currentSection.label;

    if (!user || !["hr_admin", "super_admin", "platform_admin"].includes(user.role)) {
        return (
            <div className={s.shell}>
                <div className={s.content}>
                    <h1>Admin Panel</h1>
                    <div className={s.accessDenied}>
                        Access denied. HR Admin, Super Admin, or Platform Admin role required.
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
        switch (section) {
            case "home":
                return <AdminHome user={user} onNavigate={goSection} />;
            case "users":
                return <UserManagement userRole={user.role} />;
            case "add":
                return (
                    <AddPeopleWizard
                        userRole={user.role}
                        onCompleted={() => { refreshBadges(); }}
                    />
                );
            case "role-requests":
                return <RoleRequests userRole={user.role} />;
            case "payroll":
                return <PayPeriods />;
            case "compensation":
                return <CompensationSetup />;
            case "salary-slips":
                return <SalarySlips />;
            case "payment-config":
                return <PaymentSettings />;
            case "audit":
                return <AuditLogs />;
            case "platform-access":
                return <PlatformAccessInbox />;
            case "departments":
                return user.org_id && orgId
                    ? <Departments orgId={orgId} userRole={user.role} />
                    : <p>You are not assigned to an organization.</p>;
            case "teams":
                return user.org_id && orgId
                    ? <Teams orgId={orgId} userRole={user.role} />
                    : <p>You are not assigned to an organization.</p>;
            case "org-chart":
                return user.org_id ? <OrgChartView /> : <p>You are not assigned to an organization.</p>;
            case "agile":
                return user.org_id ? <AgileSettings /> : <p>You are not assigned to an organization.</p>;
            case "projects":
                return user.org_id ? <Projects /> : <p>You are not assigned to an organization.</p>;
            case "integrations":
                return user.org_id ? <Integrations /> : <p>You are not assigned to an organization.</p>;
            case "org-settings":
                return user.org_id
                    ? <OrgSettingsPage userRole={user.role} />
                    : <p>You are not assigned to an organization.</p>;
            case "my-org":
                return user.org_id ? <MyOrganization userRole={user.role} /> : null;
            default:
                return <AdminHome user={user} onNavigate={goSection} />;
        }
    };

    return (
        <div className={s.shell}>
            {/* Mobile top bar */}
            <div className={s.mobileBar}>
                <button className={s.mobileToggle} onClick={() => setMobileOpen(true)} aria-label="Open admin menu">
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
            <aside className={`${s.sidebar} ${mobileOpen ? s.open : ""}`} aria-label="Admin navigation">
                <div className={s.brandRow}>
                    <SettingsIcon size={18} />
                    <div>
                        <div className={s.brandTitle}>Admin Panel</div>
                        <div className={s.brandSubtitle}>
                            {user.role === "platform_admin" ? "Platform Admin"
                                : user.role === "super_admin" ? "Super Admin" : "HR Admin"}
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
                    if (group.items.length === 1 && group.name === "Overview") {
                        const item = group.items[0];
                        const Icon = item.icon;
                        const isActive = section === item.key;
                        return (
                            <div className={s.groupItems} key={group.name}>
                                <button
                                    className={`${s.navItem} ${isActive ? s.active : ""}`}
                                    onClick={() => goSection(item.key)}
                                >
                                    <span className={s.navIcon}><Icon size={16} /></span>
                                    <span className={s.navLabel}>{item.label}</span>
                                </button>
                            </div>
                        );
                    }

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
                                        const isActive = section === item.key;
                                        const badge = item.badgeKey ? badges[item.badgeKey] : 0;
                                        return (
                                            <button
                                                key={item.key}
                                                className={`${s.navItem} ${isActive ? s.active : ""}`}
                                                onClick={() => goSection(item.key)}
                                            >
                                                <span className={s.navIcon}><Icon size={16} /></span>
                                                <span className={s.navLabel}>{item.label}</span>
                                                {badge > 0 && (
                                                    <span className={`${s.navBadge} ${s.warning}`}>{badge}</span>
                                                )}
                                            </button>
                                        );
                                    })}
                                </div>
                            )}
                        </div>
                    );
                })}

                {/* Platform Console link (platform_admin only).
                    Tenant super_admins are intentionally excluded — the
                    console manages every tenant on the install, not their
                    own org. They can still administer their own org from
                    this Admin panel. */}
                {canSeePlatformConsole && (
                    <div className={s.group}>
                        <div className={s.groupLabel} style={{ cursor: "default" }}>
                            <span>Platform</span>
                        </div>
                        <div className={s.groupItems}>
                            <button
                                className={s.navItem}
                                onClick={() => navigate("/tenants")}
                                title="Open the platform-wide console (tenants, plans, system settings)"
                            >
                                <span className={s.navIcon}><ExternalLink size={16} /></span>
                                <span className={s.navLabel}>Platform Console</span>
                            </button>
                        </div>
                    </div>
                )}
            </aside>

            {/* ─── Content ─── */}
            <main className={s.content}>
                <div className={s.contentHeader}>
                    <div>
                        <h1 className={s.contentTitle}>{currentTitle}</h1>
                        {currentSection.key === "home" && (
                            <p className={s.contentDesc}>
                                Welcome back, {user.full_name || user.username}. Here's what needs your attention.
                            </p>
                        )}
                    </div>
                </div>
                {renderSection()}
            </main>
        </div>
    );
}
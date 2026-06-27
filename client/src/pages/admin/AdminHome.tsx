import React, { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  RefreshCw,
  ClipboardList,
  UserPlus,
  Users,
  Building,
  UsersRound,
  ArrowRight,
  CheckCircle2,
  Circle,
  Network,
  Tag,
  DollarSign,
  ScrollText,
  Settings as SettingsIcon,
  AlarmClock,
} from "lucide-react";
import {
  getAdminStats,
  getRoleChangeRequests,
  getApprovals,
  getCurrentOrg,
  getOrgDepartments,
  getOrgTeams,
  getLeavePolicies,
} from "../../api";
import s from "./AdminLayout.module.css";

interface AdminStats {
  activeUsers?: number;
  totalUsers?: number;
  departments?: number;
  teams?: number;
  clockedInToday?: number;
  pendingApprovals?: number;
  [key: string]: unknown;
}

interface SetupState {
  tzSet: boolean;
  hasDept: boolean;
  hasTeam: boolean;
  hasPolicy: boolean;
  loaded: boolean;
}

interface ChecklistItem {
  key: string;
  label: string;
  target: string;
  done: boolean;
}

interface AttentionCard {
  key: string;
  icon: React.ReactNode;
  iconClass: string;
  value: React.ReactNode;
  label: string;
  action?: string;
  target?: string;
}

interface AdminHomeProps {
  user?: { org_id?: number | string | null; [key: string]: unknown } | null;
  onNavigate?: (key: string) => void;
}

const DEFAULT_SETUP: SetupState = {
  tzSet: false,
  hasDept: false,
  hasTeam: false,
  hasPolicy: false,
  loaded: false,
};

/**
 * AdminHome — attention-first dashboard.
 *
 * Shows:
 *  - Attention cards (pending role requests, pending approvals, etc.)
 *  - Compact org stats grid (active users, depts, teams, clocked-in today)
 *  - Quick actions row
 *  - Setup checklist for new orgs (timezone, dept, team, leave policy)
 *
 * Props:
 *   user            – auth user
 *   onNavigate(key) – call to switch to a section in the parent shell
 */
export default function AdminHome({ user, onNavigate }: AdminHomeProps) {
  const { data: homeData } = useQuery({
    queryKey: ["admin", "home", "stats"],
    queryFn: async () => {
      const [statsR, roleR, apprR] = await Promise.allSettled([
        getAdminStats(),
        getRoleChangeRequests({ status: "pending" }),
        getApprovals({ status: "pending" }),
      ]);
      return {
        stats:
          statsR.status === "fulfilled"
            ? (statsR.value.data as AdminStats)
            : null,
        pendingRoleRequests:
          roleR.status === "fulfilled"
            ? ((roleR.value.data as any[]) || []).length
            : 0,
        pendingApprovals:
          apprR.status === "fulfilled"
            ? (
                ((apprR.value.data as any)?.data ||
                  apprR.value.data ||
                  []) as any[]
              ).length
            : 0,
      };
    },
  });
  const stats = homeData?.stats ?? null;
  const pendingRoleRequests = homeData?.pendingRoleRequests ?? 0;
  const pendingApprovals = homeData?.pendingApprovals ?? 0;

  // Setup checklist (silent failures – best-effort signals only)
  const { data: setupData } = useQuery({
    queryKey: ["admin", "home", "setup", user?.org_id],
    enabled: !!user?.org_id,
    queryFn: async () => {
      const [orgR, deptR, teamR, polR] = await Promise.allSettled([
        getCurrentOrg(),
        getOrgDepartments(),
        getOrgTeams(),
        getLeavePolicies(),
      ]);
      const org = orgR.status === "fulfilled" ? (orgR.value.data as any) : null;
      const depts =
        deptR.status === "fulfilled" ? (deptR.value.data as any[]) || [] : [];
      const teams =
        teamR.status === "fulfilled" ? (teamR.value.data as any[]) || [] : [];
      const pols =
        polR.status === "fulfilled" ? (polR.value.data as any[]) || [] : [];
      return {
        tzSet: !!(org && org.timezone && org.timezone !== "UTC"),
        hasDept: depts.length > 0,
        hasTeam: teams.length > 0,
        hasPolicy: pols.length > 0,
        loaded: true,
      } as SetupState;
    },
  });
  const setup = setupData ?? DEFAULT_SETUP;

  const checklist = useMemo<ChecklistItem[]>(
    () => [
      {
        key: "tzSet",
        label: "Set organization timezone & work hours",
        target: "org-settings",
        done: setup.tzSet,
      },
      {
        key: "hasDept",
        label: "Create at least one department",
        target: "departments",
        done: setup.hasDept,
      },
      {
        key: "hasTeam",
        label: "Create at least one team",
        target: "teams",
        done: setup.hasTeam,
      },
      {
        key: "hasPolicy",
        label: "Define a leave policy",
        target: "org-settings",
        done: setup.hasPolicy,
      },
    ],
    [setup],
  );

  const setupComplete = checklist.every((c) => c.done);
  const setupProgress = checklist.filter((c) => c.done).length;

  // ─── Attention cards ──────────────────────────────────────────────────
  const attention: AttentionCard[] = [];
  if (pendingRoleRequests > 0) {
    attention.push({
      key: "role-requests",
      icon: <RefreshCw size={18} />,
      iconClass: "warning",
      value: pendingRoleRequests,
      label:
        pendingRoleRequests === 1
          ? "role change request needs review"
          : "role change requests need review",
      action: "Review now",
      target: "role-requests",
    });
  }
  if (pendingApprovals > 0) {
    attention.push({
      key: "approvals",
      icon: <ClipboardList size={18} />,
      iconClass: "warning",
      value: pendingApprovals,
      label:
        pendingApprovals === 1
          ? "leave / overtime approval pending"
          : "leave / overtime approvals pending",
      action: "Open queue",
      target: "__manager__", // navigate outside admin to /manager
    });
  }
  if (stats && (stats.pendingApprovals ?? 0) > 0 && pendingApprovals === 0) {
    attention.push({
      key: "pending-stats",
      icon: <AlertTriangle size={18} />,
      iconClass: "warning",
      value: stats.pendingApprovals,
      label: "pending approvals across the organization",
      action: "View approvals",
      target: "__manager__",
    });
  }
  if (!setupComplete && setup.loaded && user?.org_id) {
    attention.push({
      key: "setup",
      icon: <SettingsIcon size={18} />,
      iconClass: "success",
      value: `${setupProgress}/${checklist.length}`,
      label: "organization setup steps completed",
      action: "Finish setup",
      target: "__setup__",
    });
  }

  const goto = (target?: string) => {
    if (!target) return;
    if (target === "__manager__") {
      window.location.assign("/manager");
      return;
    }
    if (target === "__setup__") {
      // Scroll the checklist into view
      document
        .getElementById("admin-setup-checklist")
        ?.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }
    onNavigate?.(target);
  };

  return (
    <div className={s.homeWrap}>
      {/* ─── Attention strip ─── */}
      {attention.length > 0 && (
        <div className={s.attentionGrid}>
          {attention.map((a) => (
            <button
              key={a.key}
              type="button"
              className={s.attnCard}
              onClick={() => goto(a.target)}
              disabled={!a.target}
              style={!a.target ? { cursor: "default" } : undefined}
            >
              <div className={`${s.attnIcon} ${s[a.iconClass] || ""}`}>
                {a.icon}
              </div>
              <div className={s.attnBody}>
                <div className={s.attnValue}>{a.value}</div>
                <div className={s.attnLabel}>{a.label}</div>
                {a.action && (
                  <div className={s.attnAction}>
                    {a.action} <ArrowRight size={12} />
                  </div>
                )}
              </div>
            </button>
          ))}
        </div>
      )}

      {/* ─── Compact stats ─── */}
      {stats && (
        <div className={s.statsRow}>
          <div className={s.miniStat}>
            <CheckCircle2 size={20} className={s.miniIcon} />
            <div>
              <div className={s.miniVal}>{stats.activeUsers ?? 0}</div>
              <div className={s.miniLabel}>Active users</div>
            </div>
          </div>
          <div className={s.miniStat}>
            <Users size={20} className={s.miniIcon} />
            <div>
              <div className={s.miniVal}>{stats.totalUsers ?? 0}</div>
              <div className={s.miniLabel}>Total users</div>
            </div>
          </div>
          <div className={s.miniStat}>
            <Building size={20} className={s.miniIcon} />
            <div>
              <div className={s.miniVal}>{stats.departments ?? 0}</div>
              <div className={s.miniLabel}>Departments</div>
            </div>
          </div>
          <div className={s.miniStat}>
            <UsersRound size={20} className={s.miniIcon} />
            <div>
              <div className={s.miniVal}>{stats.teams ?? 0}</div>
              <div className={s.miniLabel}>Teams</div>
            </div>
          </div>
          <div className={s.miniStat}>
            <AlarmClock size={20} className={s.miniIcon} />
            <div>
              <div className={s.miniVal}>{stats.clockedInToday ?? 0}</div>
              <div className={s.miniLabel}>Clocked-in today</div>
            </div>
          </div>
        </div>
      )}

      {/* ─── Quick actions + setup checklist ─── */}
      <div className={s.sectionRow}>
        <div className={s.panel}>
          <h3 className={s.panelTitle}>
            <UserPlus size={16} />
            Quick actions
          </h3>
          <div className={s.quickRow}>
            <button className={s.quickBtn} onClick={() => onNavigate?.("add")}>
              <UserPlus size={14} />
              Add people
            </button>
            {user?.org_id && (
              <button
                className={s.quickBtn}
                onClick={() => onNavigate?.("departments")}
              >
                <Building size={14} />
                New department
              </button>
            )}
            {user?.org_id && (
              <button
                className={s.quickBtn}
                onClick={() => onNavigate?.("teams")}
              >
                <UsersRound size={14} />
                New team
              </button>
            )}
            <button
              className={s.quickBtn}
              onClick={() => onNavigate?.("payroll")}
            >
              <DollarSign size={14} />
              Lock pay period
            </button>
            <button
              className={s.quickBtn}
              onClick={() => onNavigate?.("labels")}
            >
              <Tag size={14} />
              Manage labels
            </button>
            <button
              className={s.quickBtn}
              onClick={() => onNavigate?.("audit")}
            >
              <ScrollText size={14} />
              View audit logs
            </button>
          </div>
        </div>

        {user?.org_id && (
          <div className={s.panel} id="admin-setup-checklist">
            <h3 className={s.panelTitle}>
              <Network size={16} />
              Setup checklist
              <span className={s.ckHint} style={{ marginLeft: "auto" }}>
                {setupProgress}/{checklist.length} done
              </span>
            </h3>
            <ul className={s.checklist}>
              {checklist.map((item) => (
                <li key={item.key} style={{ listStyle: "none" }}>
                  <button
                    type="button"
                    className={`${s.checklistItem} ${item.done ? s.done : ""}`}
                    onClick={() => goto(item.target)}
                  >
                    {item.done ? (
                      <CheckCircle2
                        size={16}
                        className={s.ckIcon}
                        color="var(--success)"
                      />
                    ) : (
                      <Circle size={16} className={s.ckIcon} />
                    )}
                    <span className={s.ckLabel}>{item.label}</span>
                    {!item.done && <ArrowRight size={13} />}
                  </button>
                </li>
              ))}
            </ul>
            {setupComplete && setup.loaded && (
              <div className={s.ckHint} style={{ marginTop: 8 }}>
                <CheckCircle2
                  size={13}
                  color="var(--success)"
                  style={{ verticalAlign: "middle", marginRight: 4 }}
                />
                Your organization is fully set up.
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

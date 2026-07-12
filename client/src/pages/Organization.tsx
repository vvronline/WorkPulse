import React, { useState, Suspense, lazy } from "react";
import { useQuery } from "@tanstack/react-query";
import { Building2, Users, GitBranch, Tag, CreditCard } from "lucide-react";
import { useAutoDismiss } from "../hooks/useAutoDismiss";
import { useAuth } from "../AuthContext";
import { createOrg, getCurrentOrg } from "../api";
import Departments from "../components/organization/Departments";
import Teams from "../components/organization/Teams";
import OrgChartView from "../components/organization/OrgChartView";
import TaskLabelsTab from "./admin/TaskLabelsTab";
import PageSkeleton from "../components/common/PageSkeleton";
import s from "./Admin.module.css";

const MySalarySlips = lazy(() => import("./attendance/MySalarySlips"));

export default function Organization() {
  const { user, updateUser } = useAuth() as any;
  const isAdmin = ["hr_admin", "super_admin", "platform_admin"].includes(
    user?.role,
  );
  const canManageLabels = !isAdmin && ["manager"].includes(user?.role);
  const [tab, setTab] = useState("salary-slips");

  // Stale-while-revalidate: the cached org (restored from localStorage on a
  // cold start) renders instantly while a background refetch keeps it fresh.
  const {
    data: org,
    isLoading: loading,
    refetch: fetchOrg,
  } = useQuery({
    queryKey: ["organization", "current"],
    queryFn: async () => (await getCurrentOrg()).data ?? null,
  });

  if (loading)
    return (
      <div className={s.adminPage}>
        <div className={s.statCard}>Loading...</div>
      </div>
    );

  if (!org) {
    if (user?.role === "super_admin") {
      return (
        <CreateOrgView
          onCreated={(orgId: number | string) => {
            fetchOrg();
            updateUser({ org_id: orgId, role: "super_admin" });
          }}
        />
      );
    }
    // Non-admins without an org get the "not assigned" message. Admins
    // (platform_admin / hr_admin) aren't scoped to a single org but fall
    // through to the full tab UI below — the org-scoped tabs simply show
    // empty states when they have no org.
    if (!isAdmin) {
      return (
        <div className={s.adminPage}>
          <h1>Organization</h1>
          <p style={{ color: "var(--text-secondary)", marginTop: "1rem" }}>
            You are not assigned to any organization yet. Please contact your
            administrator.
          </p>
        </div>
      );
    }
  }

  return (
    <div className={s.adminPage}>
      <h1>{org?.name || "Organization"}</h1>

      <div className={`${s.tabs} ${s.orgTabs}`}>
        <button
          className={`${s.tab} ${tab === "salary-slips" ? s.active : ""}`}
          onClick={() => setTab("salary-slips")}
        >
          <span>
            <CreditCard size={14} />
          </span>{" "}
          Salary Slips
        </button>
        <button
          className={`${s.tab} ${tab === "departments" ? s.active : ""}`}
          onClick={() => setTab("departments")}
        >
          <span>
            <Building2 size={14} />
          </span>{" "}
          My Department
        </button>
        <button
          className={`${s.tab} ${tab === "teams" ? s.active : ""}`}
          onClick={() => setTab("teams")}
        >
          <span>
            <Users size={14} />
          </span>{" "}
          My Team
        </button>
        <button
          className={`${s.tab} ${tab === "chart" ? s.active : ""}`}
          onClick={() => setTab("chart")}
        >
          <span>
            <GitBranch size={14} />
          </span>{" "}
          Org Chart
        </button>
        {canManageLabels && (
          <button
            className={`${s.tab} ${tab === "labels" ? s.active : ""}`}
            onClick={() => setTab("labels")}
          >
            <span>
              <Tag size={14} />
            </span>{" "}
            Task Labels
          </button>
        )}
      </div>

      {tab === "salary-slips" && (
        <Suspense fallback={<PageSkeleton />}>
          <MySalarySlips />
        </Suspense>
      )}
      {tab === "departments" && (
        <Departments orgId={org?.id} userRole={user.role} />
      )}
      {tab === "teams" && <Teams orgId={org?.id} userRole={user.role} />}
      {tab === "chart" && <OrgChartView />}
      {tab === "labels" && canManageLabels && <TaskLabelsTab />}
    </div>
  );
}

function CreateOrgView({
  onCreated,
}: {
  onCreated: (orgId: number | string) => void;
}) {
  const [name, setName] = useState("");
  const [error, setError] = useAutoDismiss("") as [string, (v: string) => void];

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const res = await createOrg(name);
      onCreated((res.data as any).id);
    } catch (e: any) {
      setError(e.response?.data?.error || "Failed");
    }
  };

  return (
    <div className={s.adminPage}>
      <h1>Create Organization</h1>
      <p style={{ color: "var(--text-secondary)", marginBottom: "1.5rem" }}>
        You're not part of any organization yet. Create one to enable enterprise
        features.
      </p>
      {error && <div className={s.error}>{error}</div>}
      <form onSubmit={handleCreate} style={{ maxWidth: 400 }}>
        <div className={s.formGroup}>
          <label>Organization Name</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            placeholder="e.g. Acme Corp"
          />
        </div>
        <button type="submit" className={s.btnPrimary}>
          Create Organization
        </button>
      </form>
    </div>
  );
}

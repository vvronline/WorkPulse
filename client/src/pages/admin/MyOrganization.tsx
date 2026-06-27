import React, { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Building,
  Users,
  UsersRound,
  AlarmClock,
  GitBranch,
  Settings,
} from "lucide-react";
import { useAuth } from "../../AuthContext";
import { getCurrentOrg } from "../../api";
import OrgSettings from "../../components/organization/OrgSettings";
import Departments from "../../components/organization/Departments";
import Teams from "../../components/organization/Teams";
import OrgChartView from "../../components/organization/OrgChartView";
import s from "../Admin.module.css";
import su from "./AdminUtils.module.css";

interface MyOrganizationProps {
  userRole?: string;
  refreshKey?: unknown;
}

export default function MyOrganization({
  userRole,
  refreshKey,
}: MyOrganizationProps) {
  const { updateUser } = useAuth() as any;
  const queryClient = useQueryClient();
  const [tab, setTab] = useState("departments");

  const { data: org = null, isLoading: loading } = useQuery({
    queryKey: ["admin", "my-organization", refreshKey],
    queryFn: async () => (await getCurrentOrg()).data,
  });

  const refetchOrg = () =>
    queryClient.invalidateQueries({ queryKey: ["admin", "my-organization"] });

  if (loading) return <div>Loading...</div>;

  if (!org) {
    return (
      <div>
        <p className={su["no-org-msg"]}>
          You are not assigned to any organization yet. Please contact your
          administrator.
        </p>
      </div>
    );
  }

  return (
    <>
      <h2 className={su.sectionHeading}>
        <Building
          size={20}
          style={{ marginRight: 8, verticalAlign: "middle" }}
        />
        My Organization
      </h2>
      <h3 className={su["org-subtitle"]}>{org.name}</h3>

      <div className={`${s.statsGrid} ${su["stats-compact"]}`}>
        <div className={s.statCard}>
          <div className={s.statIcon}>
            <Users size={22} />
          </div>
          <div className={s.value}>{org.memberCount}</div>
          <div className={s.label}>Members</div>
        </div>
        <div className={s.statCard}>
          <div className={s.statIcon}>
            <Building size={22} />
          </div>
          <div className={s.value}>{org.deptCount}</div>
          <div className={s.label}>Departments</div>
        </div>
        <div className={s.statCard}>
          <div className={s.statIcon}>
            <UsersRound size={22} />
          </div>
          <div className={s.value}>{org.teamCount}</div>
          <div className={s.label}>Teams</div>
        </div>
        <div className={s.statCard}>
          <div className={s.statIcon}>
            <AlarmClock size={22} />
          </div>
          <div className={s.value}>{org.work_hours_per_day}h</div>
          <div className={s.label}>Work Hours/Day</div>
        </div>
      </div>

      <div className={s.tabs}>
        <button
          className={`${s.tab} ${tab === "departments" ? s.active : ""}`}
          onClick={() => setTab("departments")}
        >
          <span>
            <Building
              size={14}
              style={{ marginRight: 4, verticalAlign: "middle" }}
            />
          </span>{" "}
          Departments
        </button>
        <button
          className={`${s.tab} ${tab === "teams" ? s.active : ""}`}
          onClick={() => setTab("teams")}
        >
          <span>
            <UsersRound
              size={14}
              style={{ marginRight: 4, verticalAlign: "middle" }}
            />
          </span>{" "}
          Teams
        </button>
        <button
          className={`${s.tab} ${tab === "chart" ? s.active : ""}`}
          onClick={() => setTab("chart")}
        >
          <span>
            <GitBranch
              size={14}
              style={{ marginRight: 4, verticalAlign: "middle" }}
            />
          </span>{" "}
          Org Chart
        </button>
        <button
          className={`${s.tab} ${tab === "overview" ? s.active : ""}`}
          onClick={() => setTab("overview")}
        >
          <span>
            <Settings
              size={14}
              style={{ marginRight: 4, verticalAlign: "middle" }}
            />
          </span>{" "}
          Settings
        </button>
      </div>

      <div className={su["tab-content"]}>
        {tab === "overview" && (
          <OrgSettings org={org} onUpdate={refetchOrg} userRole={userRole} />
        )}
        {tab === "departments" && (
          <Departments orgId={org.id} userRole={userRole} />
        )}
        {tab === "teams" && <Teams orgId={org.id} userRole={userRole} />}
        {tab === "chart" && <OrgChartView />}
      </div>
    </>
  );
}

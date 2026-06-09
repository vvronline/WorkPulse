import React from "react";
import { formatMin } from "./constants";
import m from "../ManagerDashboard.module.css";

interface StatusConfigEntry {
    label: string;
    cls: string;
    icon: string;
}

const config: Record<string, StatusConfigEntry> = {
    working: { label: "Working", cls: "badgeApproved", icon: "🟢" },
    on_break: { label: "Break", cls: "badgePending", icon: "🟡" },
    on_leave: { label: "On Leave", cls: "badgeRejected", icon: "🔴" },
    left: { label: "Left", cls: "badgeDefault", icon: "⚪" },
    absent: { label: "Absent", cls: "badgeDefault", icon: "⚫" },
};

interface TodayStatusBadgeProps {
    status?: string;
    minutes?: number;
}

export default function TodayStatusBadge({ status, minutes }: TodayStatusBadgeProps) {
    const c = (status && config[status]) || config.absent;
    return (
        <div className={m.todayStatus}>
            <span className={`${m.badge} ${m[c.cls]}`}>
                {c.icon} {c.label}
            </span>
            {(minutes ?? 0) > 0 && <span className={m.todayMins}>{formatMin(minutes ?? 0)}</span>}
        </div>
    );
}
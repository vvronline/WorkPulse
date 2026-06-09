import React from "react";
import m from "../ManagerDashboard.module.css";

interface PriorityBadgeProps {
    priority?: string;
}

export default function PriorityBadge({ priority }: PriorityBadgeProps) {
    const cls =
        priority === "high"
            ? m.badgeHigh
            : priority === "medium"
              ? m.badgeMedium
              : priority === "low"
                ? m.badgeLow
                : m.badgeDefault;
    return <span className={`${m.badgeSmall} ${cls}`}>{priority}</span>;
}
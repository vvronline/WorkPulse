import React from "react";
import m from "../ManagerDashboard.module.css";

interface ApprovalBadgeProps {
    status?: string;
}

export default function ApprovalBadge({ status }: ApprovalBadgeProps) {
    const cls =
        status === "pending"
            ? m.badgePending
            : status === "approved"
              ? m.badgeApproved
              : status === "rejected"
                ? m.badgeRejected
                : m.badgeDefault;
    return <span className={`${m.badge} ${cls}`}>{status}</span>;
}
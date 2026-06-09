import React from "react";
import { formatMin, LEAVE_ICONS } from "./constants";
import { Building2, House } from "lucide-react";
import m from "../ManagerDashboard.module.css";

interface MemberExpandedCardProps {
    member: Record<string, any>;
    targetMinutes: number;
    expectedWeekdays: number;
}

export default function MemberExpandedCard({
    member: mem,
    targetMinutes,
    expectedWeekdays,
}: MemberExpandedCardProps) {
    const utilization =
        expectedWeekdays > 0
            ? Math.round((mem.hours / (expectedWeekdays * (targetMinutes / 60))) * 100)
            : 0;

    return (
        <div className={m.expandedContent}>
            <div className={m.expandedGrid}>
                <div className={m.expandedStat}>
                    <span className={m.expandedStatLabel}>Email</span>
                    <span className={m.expandedStatValue}>{mem.email || "—"}</span>
                </div>
                <div className={m.expandedStat}>
                    <span className={m.expandedStatLabel}>Department</span>
                    <span className={m.expandedStatValue}>{mem.department_name || "—"}</span>
                </div>
                <div className={m.expandedStat}>
                    <span className={m.expandedStatLabel}>Team</span>
                    <span className={m.expandedStatValue}>{mem.team_name || "—"}</span>
                </div>
                <div className={m.expandedStat}>
                    <span className={m.expandedStatLabel}>Days Worked</span>
                    <span className={m.expandedStatValue}>{mem.daysWorked}</span>
                </div>
                <div className={m.expandedStat}>
                    <span className={m.expandedStatLabel}>Target Met</span>
                    <span className={m.expandedStatValue}>
                        {mem.targetMetDays}/{mem.daysWorked} days
                    </span>
                </div>
                <div className={m.expandedStat}>
                    <span className={m.expandedStatLabel}>Avg Break</span>
                    <span className={m.expandedStatValue}>{formatMin(mem.avgBreakMinutes)}</span>
                </div>
                <div className={m.expandedStat}>
                    <span className={m.expandedStatLabel}>Work Mode</span>
                    <span className={m.expandedStatValue}>
                        <Building2 size={13} style={{ marginRight: 3, verticalAlign: "middle" }} />
                        {mem.officeDays} ·{" "}
                        <House
                            size={13}
                            style={{ marginRight: 3, marginLeft: 4, verticalAlign: "middle" }}
                        />
                        {mem.remoteDays}
                    </span>
                </div>
                <div className={m.expandedStat}>
                    <span className={m.expandedStatLabel}>Utilization</span>
                    <span className={m.expandedStatValue}>{utilization}%</span>
                </div>
                <div className={m.expandedStat}>
                    <span className={m.expandedStatLabel}>Current Streak</span>
                    <span className={m.expandedStatValue}>
                        {mem.streak} day{mem.streak !== 1 ? "s" : ""} 🔥
                    </span>
                </div>
                <div className={m.expandedStat}>
                    <span className={m.expandedStatLabel}>Task Completion</span>
                    <span className={m.expandedStatValue}>
                        {mem.taskCompletionRate}% ({mem.tasksDone}/{mem.tasksTotal})
                    </span>
                </div>
                <div className={m.expandedStat}>
                    <span className={m.expandedStatLabel}>Leaves</span>
                    <span className={m.expandedStatValue}>
                        {mem.leaves} total
                        {mem.leavesByType && Object.keys(mem.leavesByType).length > 0 && (
                            <span className={m.leaveBreakdown}>
                                {Object.entries(mem.leavesByType).map(([type, count]) => (
                                    <span
                                        key={type}
                                        className={m.leaveChip}
                                        style={{
                                            display: "inline-flex",
                                            alignItems: "center",
                                            gap: "0.25rem",
                                        }}
                                    >
                                        {(() => {
                                            const Ic = LEAVE_ICONS[type];
                                            return Ic ? <Ic size={12} /> : null;
                                        })()}{" "}
                                        {count as React.ReactNode}
                                    </span>
                                ))}
                            </span>
                        )}
                    </span>
                </div>
            </div>
        </div>
    );
}
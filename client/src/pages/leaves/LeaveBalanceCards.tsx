import React from "react";
import { getLeaveType } from "../../constants/leaves";
import s from "../Leaves.module.css";

interface LeaveBalance {
    leave_type: string;
    year: number | string;
    quota?: number | string;
    carried_forward?: number | string;
    used?: number | string;
    [key: string]: any;
}

interface LeaveBalanceCardsProps {
    balances: LeaveBalance[];
}

/** Displays the leave balance cards row. Renders nothing when balances are empty. */
export default function LeaveBalanceCards({ balances }: LeaveBalanceCardsProps) {
    if (!balances.length) return null;

    return (
        <div className={s.balanceRow}>
            {balances.map((b) => {
                const type = getLeaveType(b.leave_type);
                // Coerce to Number — pg's NUMERIC arrives as a string, and
                // '8' + '0' would silently become '80'.
                const quota = Number(b.quota ?? 0) || 0;
                const carried = Number(b.carried_forward ?? 0) || 0;
                const used = Number(b.used ?? 0) || 0;
                const total = quota + carried;
                const available = total - used;
                const pct = total > 0 ? Math.min(Math.round((used / total) * 100), 100) : 0;
                return (
                    <div
                        key={`${b.leave_type}-${b.year}`}
                        className={s.balanceCard}
                        style={
                            { "--lc": type.color, "--lb": type.bg } as React.CSSProperties
                        }
                    >
                        <div
                            className={s.balanceIcon}
                            style={{
                                display: "flex",
                                alignItems: "center",
                                justifyContent: "center",
                            }}
                        >
                            {type.Icon && <type.Icon size={20} />}
                        </div>
                        <div className={s.balanceInfo}>
                            <div className={s.balanceType}>{type.label}</div>
                            <div className={s.balanceNumbers}>
                                <span className={s.balanceAvail}>{available}</span>
                                <span className={s.balanceOf}>of {total} available</span>
                            </div>
                            <div className={s.progressBar}>
                                <div
                                    className={s.progressFill}
                                    style={{
                                        width: `${pct}%`,
                                        background:
                                            pct >= 80
                                                ? "#ef4444"
                                                : pct >= 50
                                                  ? "#f59e0b"
                                                  : type.color,
                                    }}
                                />
                            </div>
                            <div className={s.balanceMeta}>
                                {used} used · {carried} carried forward
                            </div>
                        </div>
                    </div>
                );
            })}
        </div>
    );
}
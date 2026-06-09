import React, { useState, useEffect } from "react";
import { getLeaveBalances } from "../../api";
import { BarChart3 } from "lucide-react";
import s from "../LeavePolicy.module.css";
import { LEAVE_TYPE_MAP } from "../../constants/leaves";

const TYPE_META = LEAVE_TYPE_MAP;

interface Balance {
    id?: number | string;
    leave_type: string;
    year?: number | string;
    quota?: number | string;
    total_days?: number | string;
    carried_forward?: number | string;
    used?: number | string;
    [key: string]: any;
}

export default function MyBalances() {
    const [balances, setBalances] = useState<Balance[]>([]);
    const [loading, setLoading] = useState(true);
    const [year, setYear] = useState(new Date().getFullYear());

    useEffect(() => {
        setLoading(true);
        getLeaveBalances(year)
            .then((r) => {
                setBalances((r.data as Balance[]) || []);
                setLoading(false);
            })
            .catch(() => setLoading(false));
    }, [year]);

    const years = [year - 1, year, year + 1];

    return (
        <div className={s.tabPanel}>
            <div className={s.panelHeader}>
                <div>
                    <h2 className={s.panelTitle}>My Leave Balances</h2>
                    <p className={s.panelSubtitle}>
                        Your available leave days for the selected year
                    </p>
                </div>
                <select
                    className={s.yearSelect}
                    value={year}
                    onChange={(e) => setYear(+e.target.value)}
                >
                    {years.map((y) => (
                        <option key={y} value={y}>
                            {y}
                        </option>
                    ))}
                </select>
            </div>

            {loading ? (
                <div className={s.loadingWrap}>
                    <div className="spinner" />
                </div>
            ) : balances.length === 0 ? (
                <div className={s.emptyState}>
                    <BarChart3 size={32} strokeWidth={1.5} />
                    <p className={s.emptyTitle}>No balances found</p>
                    <p className={s.emptyText}>
                        Contact HR to set up leave policies for your account
                    </p>
                </div>
            ) : (
                <div className={s.balanceCardGrid}>
                    {balances.map((b) => {
                        const meta = TYPE_META[b.leave_type] || TYPE_META.other;
                        // Coerce to Number — pg's NUMERIC arrives as a string, and
                        // '8' + '0' would silently become '80'.
                        const quota = Number(b.quota ?? b.total_days ?? 0) || 0;
                        const carried = Number(b.carried_forward ?? 0) || 0;
                        const used = Number(b.used ?? 0) || 0;
                        const total = quota + carried;
                        const available = total - used;
                        const pct = total > 0 ? Math.min(Math.round((used / total) * 100), 100) : 0;
                        const barColor =
                            pct >= 80 ? "#ef4444" : pct >= 50 ? "#f59e0b" : meta.color;
                        return (
                            <div
                                key={b.id || b.leave_type}
                                className={s.balanceDetailCard}
                                style={
                                    { "--bc": meta.color, "--bb": meta.bg } as React.CSSProperties
                                }
                            >
                                <div className={s.balanceDetailTop}>
                                    <div
                                        className={s.balanceDetailIcon}
                                        style={{ background: meta.bg, color: meta.color }}
                                    >
                                        {meta.Icon && <meta.Icon size={18} />}
                                    </div>
                                    <div>
                                        <div className={s.balanceDetailType}>{meta.label}</div>
                                        <div className={s.balanceDetailYear}>
                                            Year {b.year || year}
                                        </div>
                                    </div>
                                </div>
                                <div className={s.balanceDetailNums}>
                                    <div className={s.balanceDetailNum}>
                                        <span
                                            className={s.balanceDetailBig}
                                            style={{ color: meta.color }}
                                        >
                                            {available}
                                        </span>
                                        <span className={s.balanceDetailSmall}>available</span>
                                    </div>
                                    <div className={s.balanceDetailDivider} />
                                    <div className={s.balanceDetailNum}>
                                        <span className={s.balanceDetailBig}>{used}</span>
                                        <span className={s.balanceDetailSmall}>used</span>
                                    </div>
                                    <div className={s.balanceDetailDivider} />
                                    <div className={s.balanceDetailNum}>
                                        <span className={s.balanceDetailBig}>{total}</span>
                                        <span className={s.balanceDetailSmall}>total</span>
                                    </div>
                                </div>
                                <div className={s.balanceDetailBar}>
                                    <div
                                        className={s.balanceDetailFill}
                                        style={{ width: `${pct}%`, background: barColor }}
                                    />
                                </div>
                                <div className={s.balanceDetailMeta}>
                                    {carried > 0 && `${carried} carried forward`}
                                </div>
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
}
import React from 'react';
import { LEAVE_ICONS, formatMin } from './constants';
import ApprovalBadge from './ApprovalBadge';
import PriorityBadge from './PriorityBadge';
import StatusBadge from './StatusBadge';
import RequestDetails from './RequestDetails';
import s from '../Admin.module.css';
import m from '../ManagerDashboard.module.css';

export default function MemberOverview({ data }) {
    const stats = data.stats30d || {};
    const taskStats = data.monthTaskStats || {};

    return (
        <>
            {/* Quick Stats */}
            <div className={m.summaryGrid}>
                <div className={m.summaryCard}>
                    <div className={m.summaryIcon}>⏱</div>
                    <div className={m.summaryValue}>{data.todayHours}h</div>
                    <div className={m.summaryLabel}>Today's Hours</div>
                </div>
                <div className={m.summaryCard}>
                    <div className={m.summaryIcon}>☕</div>
                    <div className={m.summaryValue}>{formatMin(data.todayBreakMin || 0)}</div>
                    <div className={m.summaryLabel}>Today's Break</div>
                </div>
                <div className={m.summaryCard}>
                    <div className={m.summaryIcon}>📋</div>
                    <div className={`${m.summaryValue} ${m.colorAmber}`}>{data.pendingRequests}</div>
                    <div className={m.summaryLabel}>Pending Requests</div>
                </div>
                <div className={m.summaryCard}>
                    <div className={m.summaryIcon}>🗓</div>
                    <div className={m.summaryValue}>{data.monthLeaves}</div>
                    <div className={m.summaryLabel}>Leaves This Month</div>
                </div>
                <div className={m.summaryCard}>
                    <div className={m.summaryIcon}>📋</div>
                    <div className={m.summaryValue}>{data.todayTasks?.length || 0}</div>
                    <div className={m.summaryLabel}>Today's Planner</div>
                </div>
            </div>

            {/* Weekly Trend */}
            {data.weeklyTrend && data.weeklyTrend.length > 0 && (
                <div className={m.overviewSection}>
                    <h3 className={m.sectionTitle}>Weekly Trend (Last 7 Days)</h3>
                    <div className={m.weeklyTrendGrid}>
                        {data.weeklyTrend.map((day, i) => {
                            const maxMin = Math.max(...data.weeklyTrend.map(d => d.floorMinutes || 0), 480, 1);
                            const barH = ((day.floorMinutes || 0) / maxMin) * 100;
                            return (
                                <div key={i} className={m.weeklyDayCol}>
                                    <div className={m.weeklyBarContainer}>
                                        <div className={m.weeklyBar} style={{ height: `${barH}%`, background: day.floorMinutes >= 480 ? 'var(--success)' : day.floorMinutes > 0 ? 'var(--warning)' : 'var(--border)' }} />
                                    </div>
                                    <div className={m.weeklyDayLabel}>{day.dayLabel}</div>
                                    <div className={m.weeklyDayHours}>{formatMin(day.floorMinutes)}</div>
                                    {day.workMode && <div className={m.weeklyDayMode}>{day.workMode === 'remote' ? '🏠' : '🏢'}</div>}
                                </div>
                            );
                        })}
                    </div>
                </div>
            )}

            {/* 30-Day Stats */}
            {stats.daysWorked !== undefined && (
                <div className={m.overviewSection}>
                    <h3 className={m.sectionTitle}>30-Day Performance</h3>
                    <div className={m.perfGrid}>
                        <div className={m.perfItem}><span className={m.perfValue}>{stats.daysWorked}</span><span className={m.perfLabel}>Days Worked</span></div>
                        <div className={m.perfItem}><span className={m.perfValue}>{formatMin(stats.totalFloorMinutes)}</span><span className={m.perfLabel}>Total Floor Time</span></div>
                        <div className={m.perfItem}><span className={m.perfValue}>{formatMin(stats.avgFloorMinutes)}</span><span className={m.perfLabel}>Avg Floor/Day</span></div>
                        <div className={m.perfItem}><span className={m.perfValue}>{formatMin(stats.avgBreakMinutes)}</span><span className={m.perfLabel}>Avg Break/Day</span></div>
                        <div className={m.perfItem}><span className={m.perfValue}>{stats.targetMetPercent}%</span><span className={m.perfLabel}>Target Met</span></div>
                        <div className={m.perfItem}><span className={m.perfValue}>{stats.punctualityPercent}%</span><span className={m.perfLabel}>Punctuality</span></div>
                    </div>
                </div>
            )}

            {/* Task Stats + Leave Balances side-by-side */}
            <div className={m.twoColSection}>
                {taskStats.total !== undefined && (
                    <div className={m.overviewSection}>
                        <h3 className={m.sectionTitle}>Planner This Month</h3>
                        <div className={m.taskStatsGrid}>
                            <div className={m.taskStatCard}><span className={m.taskStatNum}>{taskStats.total}</span><span className={m.taskStatLbl}>Total</span></div>
                            <div className={m.taskStatCard}><span className={`${m.taskStatNum} ${m.colorGreen}`}>{taskStats.done}</span><span className={m.taskStatLbl}>Done</span></div>
                            <div className={m.taskStatCard}><span className={`${m.taskStatNum} ${m.colorAmber}`}>{taskStats.inProgress}</span><span className={m.taskStatLbl}>In Progress</span></div>
                            <div className={m.taskStatCard}><span className={m.taskStatNum}>{taskStats.completionRate}%</span><span className={m.taskStatLbl}>Completion</span></div>
                        </div>
                    </div>
                )}

                {data.leaveBalances && data.leaveBalances.length > 0 && (
                    <div className={m.overviewSection}>
                        <h3 className={m.sectionTitle}>Leave Balances</h3>
                        <div className={m.leaveBalanceList}>
                            {data.leaveBalances.map((lb, i) => {
                                const used = lb.used || 0;
                                const total = lb.total_days || 0;
                                const pct = total > 0 ? Math.round((used / total) * 100) : 0;
                                return (
                                    <div key={i} className={m.leaveBalanceRow}>
                                        <div className={m.lbInfo}>
                                            <span className={m.lbName}>{LEAVE_ICONS[lb.leave_type] || '📋'} {lb.policy_name || lb.leave_type}</span>
                                            <span className={m.lbCount}>{used}/{total} used</span>
                                        </div>
                                        <div className={m.lbBarTrack}>
                                            <div className={m.lbBarFill} style={{ width: `${Math.min(pct, 100)}%`, background: pct >= 90 ? 'var(--danger)' : pct >= 60 ? 'var(--warning)' : 'var(--success)' }} />
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                )}
            </div>

            {/* Today's Planner */}
            {data.todayTasks && data.todayTasks.length > 0 && (
                <div className={m.overviewSection}>
                    <h3 className={m.sectionTitle}>Today's Planner</h3>
                    <table className={s.table}>
                        <thead><tr><th>Task</th><th>Priority</th><th>Status</th></tr></thead>
                        <tbody>
                            {data.todayTasks.map(t => (
                                <tr key={t.id}>
                                    <td>{t.title}</td>
                                    <td><PriorityBadge priority={t.priority} /></td>
                                    <td><StatusBadge status={t.status} /></td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}

            {/* Recent Leaves */}
            {data.recentLeaves && data.recentLeaves.length > 0 && (
                <div className={m.overviewSection}>
                    <h3 className={m.sectionTitle}>Recent Leaves</h3>
                    <table className={s.table}>
                        <thead><tr><th>Date</th><th>Type</th><th>Status</th><th>Reason</th></tr></thead>
                        <tbody>
                            {data.recentLeaves.map(l => (
                                <tr key={l.id}>
                                    <td>{new Date(l.date + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}</td>
                                    <td>{LEAVE_ICONS[l.leave_type] || ''} {l.leave_type}</td>
                                    <td><ApprovalBadge status={l.status} /></td>
                                    <td className={m['text-muted-sm']}>{l.reason || '—'}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}

            {/* Recent Requests */}
            {data.recentRequests && data.recentRequests.length > 0 && (
                <div className={m.overviewSection}>
                    <h3 className={m.sectionTitle}>Recent Requests</h3>
                    <table className={s.table}>
                        <thead><tr><th>Type</th><th>Details</th><th>Status</th><th>Date</th></tr></thead>
                        <tbody>
                            {data.recentRequests.map(r => (
                                <tr key={r.id}>
                                    <td><span className={s.badgeRole}>{r.type?.replace('_', ' ')}</span></td>
                                    <td className={m['cell-details']}><RequestDetails request={r} /></td>
                                    <td><ApprovalBadge status={r.status} /></td>
                                    <td className={m['cell-sm']}>{new Date(r.created_at + 'Z').toLocaleDateString()}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
        </>
    );
}

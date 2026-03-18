import { getLeaveType } from '../../constants/leaves';
import s from '../Leaves.module.css';

/** Displays the leave balance cards row. Renders nothing when balances are empty. */
export default function LeaveBalanceCards({ balances }) {
    if (!balances.length) return null;

    return (
        <div className={s.balanceRow}>
            {balances.map(b => {
                const type = getLeaveType(b.leave_type);
                const total = (b.quota || 0) + (b.carried_forward || 0);
                const used = b.used || 0;
                const available = total - used;
                const pct = total > 0 ? Math.min(Math.round((used / total) * 100), 100) : 0;
                return (
                    <div key={`${b.leave_type}-${b.year}`} className={s.balanceCard} style={{ '--lc': type.color, '--lb': type.bg }}>
                        <div className={s.balanceIcon}>{type.icon}</div>
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
                                        background: pct >= 80 ? '#ef4444' : pct >= 50 ? '#f59e0b' : type.color,
                                    }}
                                />
                            </div>
                            <div className={s.balanceMeta}>{used} used · {b.carried_forward || 0} carried forward</div>
                        </div>
                    </div>
                );
            })}
        </div>
    );
}

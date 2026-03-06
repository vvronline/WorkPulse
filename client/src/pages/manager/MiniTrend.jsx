import React from 'react';
import { formatMin } from './constants';
import m from '../ManagerDashboard.module.css';

export default function MiniTrend({ data, target }) {
    if (!data || data.length === 0) return <span className={m.muted}>—</span>;
    const max = Math.max(...data, target || 480, 1);
    return (
        <div className={m.miniTrend}>
            {data.map((val, i) => (
                <div key={i} className={m.trendBarWrap} title={formatMin(val)}>
                    <div
                        className={m.trendBar}
                        style={{
                            height: `${Math.max((val / max) * 28, 2)}px`,
                            background: val >= (target || 480) ? 'var(--success)' : val > 0 ? 'var(--warning)' : 'var(--border)',
                        }}
                    />
                </div>
            ))}
        </div>
    );
}

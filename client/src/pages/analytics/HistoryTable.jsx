import React from 'react';
import { formatTime } from '../../utils/time';
import { ClipboardList, Building2, House, Check, X } from 'lucide-react';
import s from './Analytics.module.css';

export default function HistoryTable({ history }) {
    return (
        <div className={`${s['chart-card']} ${s['history-full']}`}>
            <h3 style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}><ClipboardList size={17} /> Daily Log</h3>
            <div className={s['table-scroll-wrapper']}>
                <table className={s['history-table']}>
                    <thead>
                        <tr>
                            <th>Date</th>
                            <th>Mode</th>
                            <th>Work Time</th>
                            <th>Break Time</th>
                            <th>Total</th>
                            <th>8hr Target</th>
                        </tr>
                    </thead>
                    <tbody>
                        {history.length === 0 ? (
                            <tr>
                                <td colSpan={6} className={s['empty-cell']}>
                                    No data for this period
                                </td>
                            </tr>
                        ) : (
                            history.map((day, i) => {
                                const met = day.floorMinutes >= 480;
                                return (
                                    <tr key={i}>
                                        <td className={s['date-cell']}>
                                            {new Date(day.date + 'T00:00:00').toLocaleDateString('en-US', {
                                                weekday: 'short', month: 'short', day: 'numeric'
                                            })}
                                        </td>
                                        <td>
                                            <span className={`${s['mode-badge']} ${day.workMode === 'remote' ? s['mode-remote'] : s['mode-office']}`} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.3rem' }}>
                                                {day.workMode === 'remote' ? <House size={13} /> : <Building2 size={13} />} {day.workMode === 'remote' ? 'Remote' : 'Office'}
                                            </span>
                                        </td>
                                        <td className={s['work-cell']}>
                                            {formatTime(day.floorMinutes)}
                                        </td>
                                        <td className={s['break-cell']}>
                                            {formatTime(day.breakMinutes)}
                                        </td>
                                        <td>{formatTime(day.floorMinutes + day.breakMinutes)}</td>
                                        <td>
                                            <span className={`${s['target-badge']} ${met ? s.met : s['not-met']}`} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}>
                                                {met ? <><Check size={12} /> Met</> : <><X size={12} /> Not Met</>}
                                            </span>
                                        </td>
                                    </tr>
                                );
                            })
                        )}
                    </tbody>
                </table>
            </div>
        </div>
    );
}

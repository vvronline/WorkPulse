import React, { useState, useEffect } from 'react';
import { getMemberHours } from '../../api';
import s from '../Admin.module.css';
import m from '../ManagerDashboard.module.css';

export default function MemberHoursTab({ userId }) {
    const [hours, setHours] = useState([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        const now = new Date();
        const to = now.toISOString().split('T')[0];
        const from = new Date(now.getTime() - 30 * 86400000).toISOString().split('T')[0];
        getMemberHours(userId, from, to)
            .then(r => { setHours(r.data); setLoading(false); })
            .catch(() => setLoading(false));
    }, [userId]);

    if (loading) return <p>Loading...</p>;

    const totalHours = hours.reduce((acc, d) => acc + (d.floorMinutes || 0), 0) / 60;

    return (
        <>
            <h3 className={m['section-heading-mb']}>Hours (Last 30 Days) — Total: {totalHours.toFixed(1)}h</h3>
            <table className={s.table}>
                <thead><tr><th>Date</th><th>Floor Time</th><th>Break Time</th><th>Work Mode</th></tr></thead>
                <tbody>
                    {hours.map(d => (
                        <tr key={d.date}>
                            <td>{new Date(d.date + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}</td>
                            <td>{Math.floor(d.floorMinutes / 60)}h {d.floorMinutes % 60}m</td>
                            <td>{Math.floor(d.breakMinutes / 60)}h {d.breakMinutes % 60}m</td>
                            <td>{d.workMode === 'remote' ? '🏠 Remote' : '🏢 Office'}</td>
                        </tr>
                    ))}
                    {hours.length === 0 && <tr><td colSpan={4} className={m['empty-cell']}>No data found</td></tr>}
                </tbody>
            </table>
        </>
    );
}

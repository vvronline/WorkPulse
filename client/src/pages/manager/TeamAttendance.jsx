import React, { useState, useEffect } from 'react';
import { getTeamAttendance } from '../../api';
import MemberCard from './MemberCard';
import s from '../Admin.module.css';
import m from '../ManagerDashboard.module.css';

export default function TeamAttendance({ onSelectMember }) {
    const [data, setData] = useState([]);
    const [date, setDate] = useState(new Date().toISOString().split('T')[0]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        setLoading(true);
        getTeamAttendance(date)
            .then(r => { setData(r.data); setLoading(false); })
            .catch(() => setLoading(false));
    }, [date]);

    const groups = { working: [], away: [], not_started: [], on_leave: [] };
    data.forEach(member => { (groups[member.status] || groups.not_started).push(member); });

    const statusLabel = {
        working: '🟢 Working',
        away: '🟡 Away',
        not_started: '⚪ Not Started',
        on_leave: '🔴 On Leave',
    };

    return (
        <>
            <div className={m.dateInput}>
                <input type="date" value={date} onChange={e => setDate(e.target.value)} className={m.inputField} />
            </div>
            <div className={s.statsGrid}>
                <div className={s.statCard}><div className={`${s.value} ${m.colorGreen}`}>{groups.working.length}</div><div className={s.label}>Working</div></div>
                <div className={s.statCard}><div className={`${s.value} ${m.colorAmber}`}>{groups.away.length}</div><div className={s.label}>Away</div></div>
                <div className={s.statCard}><div className={s.value}>{groups.not_started.length}</div><div className={s.label}>Not Started</div></div>
                <div className={s.statCard}><div className={`${s.value} ${m.colorRed}`}>{groups.on_leave.length}</div><div className={s.label}>On Leave</div></div>
            </div>

            {loading ? <p>Loading...</p> : Object.entries(groups).map(([status, members]) => members.length > 0 && (
                <div key={status} className={m.groupSection}>
                    <h3 className={m.groupTitle}>{statusLabel[status]}</h3>
                    <div className={m.groupGrid}>
                        {members.map(member => (
                            <MemberCard key={member.id} member={member} onSelect={onSelectMember} />
                        ))}
                    </div>
                </div>
            ))}
            {!loading && data.length === 0 && <p className={m.emptyState}>No team members found. Make sure you are part of an organization.</p>}
        </>
    );
}

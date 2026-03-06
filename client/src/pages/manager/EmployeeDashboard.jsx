import React, { useState, useEffect } from 'react';
import { getMemberOverview } from '../../api';
import { ROLE_LABELS } from './constants';
import MemberOverview from './MemberOverview';
import MemberLeavesTab from './MemberLeavesTab';
import MemberRequestsTab from './MemberRequestsTab';
import MemberHoursTab from './MemberHoursTab';
import s from '../Admin.module.css';
import sf from '../admin/AdminForms.module.css';
import m from '../ManagerDashboard.module.css';

export default function EmployeeDashboard({ member, onBack }) {
    const [overview, setOverview] = useState(null);
    const [tab, setTab] = useState('overview');
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        setLoading(true);
        getMemberOverview(member.id)
            .then(r => { setOverview(r.data); setLoading(false); })
            .catch(() => setLoading(false));
    }, [member.id]);

    const user = overview?.user || member;

    return (
        <div className={s.adminPage}>
            <div className={m.employeeHeader}>
                <button onClick={onBack} className={`${sf.btnCancel} ${m['btn-back-sm']}`}>← Back</button>
                <div className={m.employeeProfile}>
                    {user.avatar
                        ? <img src={user.avatar} className={m.memberAvatarLg} alt="" />
                        : <span className={`${s.initials} ${m['initials-lg']}`}>{user.full_name?.charAt(0)}</span>}
                    <div>
                        <h2 className={m.employeeName}>{user.full_name}</h2>
                        <div className={m.employeeMeta}>
                            <span className={m.memberRole}>{ROLE_LABELS[user.role] || user.role}</span>
                            {user.email && <span className={m.metaDot}>· {user.email}</span>}
                            {user.department_name && <span className={m.metaDot}>· {user.department_name}</span>}
                            {user.team_name && <span className={m.metaDot}>· {user.team_name}</span>}
                        </div>
                    </div>
                </div>
            </div>

            <div className={s.tabs}>
                <button className={`${s.tab} ${tab === 'overview' ? s.active : ''}`} onClick={() => setTab('overview')}>Overview</button>
                <button className={`${s.tab} ${tab === 'leaves' ? s.active : ''}`} onClick={() => setTab('leaves')}>Leaves</button>
                <button className={`${s.tab} ${tab === 'requests' ? s.active : ''}`} onClick={() => setTab('requests')}>Requests</button>
                <button className={`${s.tab} ${tab === 'hours' ? s.active : ''}`} onClick={() => setTab('hours')}>Hours</button>
            </div>

            {loading ? <p>Loading...</p> : (
                <>
                    {tab === 'overview' && overview && <MemberOverview data={overview} />}
                    {tab === 'leaves' && <MemberLeavesTab userId={member.id} />}
                    {tab === 'requests' && <MemberRequestsTab userId={member.id} />}
                    {tab === 'hours' && <MemberHoursTab userId={member.id} />}
                </>
            )}
        </div>
    );
}

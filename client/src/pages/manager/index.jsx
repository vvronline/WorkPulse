import React, { useState } from 'react';
import TeamAttendance from './TeamAttendance';
import ApprovalsTab from './ApprovalsTab';
import TeamAnalytics from './TeamAnalytics';
import MyRequests from './MyRequests';
import EmployeeDashboard from './EmployeeDashboard';
import s from '../Admin.module.css';

export default function ManagerDashboard() {
    const [tab, setTab] = useState('attendance');
    const [selectedMember, setSelectedMember] = useState(null);

    if (selectedMember) {
        return <EmployeeDashboard member={selectedMember} onBack={() => setSelectedMember(null)} />;
    }

    return (
        <div className={s.adminPage}>
            <h1>Manager Dashboard</h1>
            <div className={s.tabs}>
                <button className={`${s.tab} ${tab === 'attendance' ? s.active : ''}`} onClick={() => setTab('attendance')}>Team Attendance</button>
                <button className={`${s.tab} ${tab === 'approvals' ? s.active : ''}`} onClick={() => setTab('approvals')}>Approvals</button>
                <button className={`${s.tab} ${tab === 'analytics' ? s.active : ''}`} onClick={() => setTab('analytics')}>Analytics</button>
                <button className={`${s.tab} ${tab === 'requests' ? s.active : ''}`} onClick={() => setTab('requests')}>My Requests</button>
            </div>
            {tab === 'attendance' && <TeamAttendance onSelectMember={setSelectedMember} />}
            {tab === 'approvals' && <ApprovalsTab />}
            {tab === 'analytics' && <TeamAnalytics onSelectMember={setSelectedMember} />}
            {tab === 'requests' && <MyRequests />}
        </div>
    );
}

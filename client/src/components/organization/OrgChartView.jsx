import React, { useState, useEffect } from 'react';
import { getOrgChart } from '../../api';
import { ROLE_LABELS } from '../../pages/admin/constants';
import s from '../../pages/Admin.module.css';
import oc from './OrgChart.module.css';
import su from '../../pages/admin/AdminUtils.module.css';

export default function OrgChartView() {
    const [chart, setChart] = useState(null);

    useEffect(() => {
        getOrgChart().then(r => setChart(r.data)).catch(e => console.error(e));
    }, []);

    if (!chart) return <div>Loading...</div>;

    const unassigned = chart.members.filter(m => !m.department_id && !m.team_id);

    return (
        <div>
            {chart.departments.map(dept => {
                const deptTeams = chart.teams.filter(t => t.department_id === dept.id);
                const deptMembers = chart.members.filter(m => m.department_id === dept.id && !m.team_id);
                return (
                    <div key={dept.id} className={oc['card-panel']}>
                        <div className={oc['dept-header']}>
                            <span className={oc['dept-icon']}>🏢</span>
                            <div>
                                <div className={oc['dept-name']}>{dept.name}</div>
                                {dept.head_name && <div className={su['text-muted-xs']}>Head: {dept.head_name}</div>}
                            </div>
                        </div>
                        {deptTeams.map(team => {
                            const tMembers = chart.members.filter(m => m.team_id === team.id);
                            return (
                                <div key={team.id} className={oc['team-card']}>
                                    <div className={oc['team-title']}>👥 {team.name} {team.lead_name && <span className={oc['team-lead-label']}>• Lead: {team.lead_name}</span>}</div>
                                    <div className={oc['flex-wrap']}>
                                        {tMembers.map(m => (
                                            <div key={m.id} className={oc['member-chip']}>
                                                {m.avatar ? <img src={m.avatar} className={`${s.miniAvatar} ${oc['mini-avatar-sm']}`} alt="" /> : <span className={`${s.initials} ${oc['mini-initials-sm']}`}>{m.full_name?.charAt(0)}</span>}
                                                {m.full_name}
                                                <span className={`${s.badgeRole} ${oc['badge-sm']}`} data-role={m.role}>{ROLE_LABELS[m.role]}</span>
                                            </div>
                                        ))}
                                        {tMembers.length === 0 && <span className={su['text-muted-xs']}>No members</span>}
                                    </div>
                                </div>
                            );
                        })}
                        {deptMembers.length > 0 && (
                            <div className={oc['unassigned-section']}>
                                <div className={oc['unassigned-label']}>Unassigned to team:</div>
                                <div className={oc['flex-wrap']}>
                                    {deptMembers.map(m => (
                                        <div key={m.id} className={oc['member-chip-simple']}>{m.full_name}</div>
                                    ))}
                                </div>
                            </div>
                        )}
                    </div>
                );
            })}
            {unassigned.length > 0 && (
                <div className={oc['card-panel']}>
                    <div className={oc['bold-heading']}>Unassigned Members</div>
                    <div className={oc['flex-wrap']}>
                        {unassigned.map(m => (
                            <div key={m.id} className={oc['member-chip-simple']}>
                                {m.full_name} <span className={`${s.badgeRole} ${oc['badge-sm']}`} data-role={m.role}>{ROLE_LABELS[m.role]}</span>
                            </div>
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
}

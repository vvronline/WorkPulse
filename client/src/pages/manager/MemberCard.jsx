import React from 'react';
import { Clock, House, Building2 } from 'lucide-react';
import { ROLE_LABELS, LEAVE_ICONS } from './constants';
import s from '../Admin.module.css';
import m from '../ManagerDashboard.module.css';

function LeaveIconFor({ type }) {
    const Ic = LEAVE_ICONS[type];
    return Ic ? <Ic size={13} /> : null;
}

export default function MemberCard({ member, onSelect }) {
    return (
        <div className={m.memberCard} onClick={() => onSelect(member)}>
            <div className={m.memberCardHeader}>
                {member.avatar
                    ? <img src={member.avatar} className={m.memberAvatar} alt="" />
                    : <span className={`${s.initials} ${m['initials-md']}`}>{member.full_name?.charAt(0)}</span>}
                <div className={m['flex-grow']}>
                    <div className={m.memberName}>{member.full_name}</div>
                    <div className={m.memberRole}>{ROLE_LABELS[member.role] || member.role}</div>
                </div>
            </div>
            <div className={m.memberCardMeta}>
                {member.hours_today != null && <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}><Clock size={13} /> {member.hours_today}h</span>}
                {member.workMode && <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}>{member.workMode === 'remote' ? <House size={13} /> : <Building2 size={13} />} {member.workMode}</span>}
                {member.current_task && <span className={m.taskHighlight}>• {member.current_task}</span>}
                {member.leave_type && <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}><LeaveIconFor type={member.leave_type} /> {member.leave_type}</span>}
            </div>
        </div>
    );
}

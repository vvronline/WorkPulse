import React from 'react';
import { ROLE_LABELS, LEAVE_ICONS } from './constants';
import s from '../Admin.module.css';
import m from '../ManagerDashboard.module.css';

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
                {member.hours_today != null && <span>⏱ {member.hours_today}h</span>}
                {member.workMode && <span>{member.workMode === 'remote' ? '🏠' : '🏢'} {member.workMode}</span>}
                {member.current_task && <span className={m.taskHighlight}>• {member.current_task}</span>}
                {member.leave_type && <span>{LEAVE_ICONS[member.leave_type] || '📋'} {member.leave_type}</span>}
            </div>
        </div>
    );
}

import React from 'react';
import s from '../LeavePolicy.module.css';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export default function HolidayCard({ holiday: h, isHR, onDelete }) {
    const dt = new Date(h.date);
    return (
        <div className={s['holiday-card']}>
            <div className={s['holiday-info']}>
                <div className={s['holiday-date-box']}>
                    <div className={s['date-day']}>{dt.getDate()}</div>
                    <div className={s['date-month']}>{MONTHS[dt.getMonth()]}</div>
                </div>
                <div>
                    <div className={s['holiday-name']}>{h.name}</div>
                    <div className={s['holiday-detail']}>
                        {DAYS[dt.getDay()]}{h.is_optional ? ' • Optional' : ''}
                    </div>
                </div>
            </div>
            {isHR && (
                <button className={`${s.btnSmall} ${s['btn-danger']}`} onClick={() => onDelete(h.id)}>✗</button>
            )}
        </div>
    );
}

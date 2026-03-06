import React from 'react';
import s from '../LeavePolicy.module.css';

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const DAYS   = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

export default function HolidayCard({ holiday: h, isHR, onDelete }) {
    const dt = new Date(h.date + 'T00:00:00');
    const isPast = dt < new Date();
    return (
        <div className={`${s.holidayCard} ${isPast ? s.holidayCardPast : ''} ${h.is_optional ? s.holidayCardOptional : ''}`}>
            <div className={s.holidayDateBox}>
                <span className={s.holidayDay}>{dt.getDate()}</span>
                <span className={s.holidayMonth}>{MONTHS[dt.getMonth()]}</span>
            </div>
            <div className={s.holidayInfo}>
                <div className={s.holidayName}>{h.name}</div>
                <div className={s.holidayMeta}>
                    <span>{DAYS[dt.getDay()]}</span>
                    {h.is_optional && <span className={s.optionalBadge}>Optional</span>}
                </div>
            </div>
            {isHR && (
                <button className={s.deleteHolidayBtn} onClick={() => onDelete(h.id)} title="Delete holiday">×</button>
            )}
        </div>
    );
}

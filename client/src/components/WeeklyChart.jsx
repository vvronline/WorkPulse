import React, { memo } from 'react';
import s from './WeeklyChart.module.css';

const WeeklyChart = memo(function WeeklyChart({ weeklyData }) {
  if (!weeklyData) return null;

  return (
    <div className={`status-card ${s['weekly-chart-card']}`}>
      <h3 className={s['timeline-title']}>
        <span className="page-icon">📊</span> This Week
      </h3>
      <div className={s['weekly-chart']}>
        {weeklyData.days.map((d, i) => {
          const maxHrs = 10;
          const barHeight = Math.min(100, (d.hours / maxHrs) * 100);
          const barColor = d.hours >= 8 ? 'var(--success)' : d.hours >= 4 ? 'var(--primary)' : d.hours > 0 ? 'var(--warning)' : 'rgba(255,255,255,0.06)';
          return (
            <div key={i} className={`${s['weekly-bar-col']} ${d.isToday ? s.today : ''}`}>
              <div className={s['weekly-bar-value']}>{d.hours > 0 ? `${d.hours}h` : ''}</div>
              <div className={s['weekly-bar-track']}>
                <div className={s['weekly-bar-fill']} style={{ '--bar-height': `${barHeight}%`, '--bar-color': barColor }} />
              </div>
              <div className={s['weekly-bar-label']}>{d.day}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
});

export default WeeklyChart;

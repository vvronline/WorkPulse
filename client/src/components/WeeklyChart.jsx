import React, { memo } from 'react';
import s from './WeeklyChart.module.css';

const WeeklyChart = memo(function WeeklyChart({ weeklyData }) {
  if (!weeklyData) return null;

  return (
    <div className={s['weekly-chart-card']}>
      <span className={`${s['inline-stat-icon']} ${s['chart-icon']}`}>📊</span>
      <div className={s['chart-info-col']}>
        <div className={s['inline-stat-label']}>This Week</div>
        <div className={s['weekly-chart']}>
          {weeklyData.days.map((d, i) => {
            const maxHrs = 10;
            const barHeight = Math.min(100, (d.hours / maxHrs) * 100);
            const barColor = d.hours >= 8 ? 'var(--success)' : d.hours >= 4 ? 'var(--primary)' : d.hours > 0 ? 'var(--warning)' : 'rgba(255,255,255,0.06)';
            return (
              <div key={i} className={`${s['weekly-bar-col']} ${d.isToday ? s.today : ''}`} title={`${d.day}: ${d.hours}h`}>
                <div className={s['weekly-bar-track']}>
                  <div className={s['weekly-bar-fill']} style={{ '--bar-height': `${barHeight}%`, '--bar-color': barColor }} />
                </div>
                <div className={s['weekly-bar-label']}>{d.day.substring(0, 3)}</div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
});

export default WeeklyChart;

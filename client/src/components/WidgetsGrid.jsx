import React, { memo } from 'react';
import s from './WidgetsGrid.module.css';

function formatTime(totalMinutes) {
  const hrs = Math.floor(Math.abs(totalMinutes) / 60);
  const mins = Math.abs(totalMinutes) % 60;
  return `${String(hrs).padStart(2, '0')}h ${String(mins).padStart(2, '0')}m`;
}

const WidgetsGrid = memo(function WidgetsGrid({ widgets }) {
  if (!widgets) return null;

  return (
    <div className={`stats-grid ${s['widgets-grid']}`}>
      <div className={`stat-card ${s['widget-card']} ${s['animated-widget']}`}>
        <div className={`${s['widget-icon-bg']} ${s['avg-bg']}`}><span className="page-icon">📊</span></div>
        <div className="stat-value">{formatTime(widgets.avgFloorMinutes)}</div>
        <div className="stat-label">Avg Work Time</div>
      </div>
      <div className={`stat-card ${s['widget-card']} ${s['animated-widget']}`}>
        <div className={`${s['widget-icon-bg']} ${s['punct-bg']}`}><span className="page-icon">⏰</span></div>
        <div className={`stat-value ${widgets.punctualityPercent >= 80 ? 'stat-value-success' : 'stat-value-warning'}`}>
          {widgets.punctualityPercent}%
        </div>
        <div className="stat-label">Punctuality</div>
      </div>
      <div className={`stat-card ${s['widget-card']} ${s['animated-widget']}`}>
        <div className={`${s['widget-icon-bg']} ${s['attend-bg']}`}><span className="page-icon">📅</span></div>
        <div className={`stat-value ${widgets.attendancePercent >= 90 ? 'stat-value-success' : widgets.attendancePercent >= 75 ? 'stat-value-warning' : 'stat-value-danger'}`}>
          {widgets.attendancePercent}%
        </div>
        <div className="stat-label">Attendance</div>
      </div>
      <div className={`stat-card ${s['widget-card']} ${s['animated-widget']}`}>
        <div className={`${s['widget-icon-bg']} ${s['target-bg']}`}><span className="page-icon">🎯</span></div>
        <div className="stat-value floor">{widgets.targetMetDays}/{widgets.workDays}</div>
        <div className="stat-label">8hr Target Met</div>
      </div>
      <div className={`stat-card ${s['widget-card']} ${s['animated-widget']}`}>
        <div className={`${s['widget-icon-bg']} ${s['leave-bg']}`}><span className="page-icon">🏖</span></div>
        <div className="stat-value break">{widgets.leaveCount}</div>
        <div className="stat-label">Leaves (Month)</div>
      </div>
      <div className={`stat-card ${s['widget-card']} ${s['animated-widget']}`}>
        <div className={`${s['widget-icon-bg']} ${s['mode-bg']}`}><span className="page-icon">🏢</span></div>
        <div className={s['mode-split']}>
          <span className={s['mode-office']}>{widgets.officeDays || 0}</span>
          <span className={s['mode-divider']}>/</span>
          <span className={s['mode-remote']}>{widgets.remoteDays || 0}</span>
        </div>
        <div className="stat-label">Office / Remote</div>
      </div>
    </div>
  );
});

export default WidgetsGrid;

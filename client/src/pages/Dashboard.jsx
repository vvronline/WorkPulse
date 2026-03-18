import React from 'react';
import { useDashboardData, CONFETTI_PIECES, TARGET_HOURS, MANDATORY_HOURS } from '../hooks/useDashboardData';
import WidgetsGrid from '../components/WidgetsGrid';
import WeeklyChart from '../components/WeeklyChart';
import TodayEventsCard from '../components/TodayEventsCard';
import EventReminderToast from '../components/EventReminderToast';
import TasksSummary from '../components/TasksSummary';
import ConfirmDialog from '../components/ConfirmDialog';
import { formatTime, formatTimeSec } from '../utils/time';
import s from './Dashboard.module.css';

function getGreeting() {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good Morning';
  if (hour < 17) return 'Good Afternoon';
  return 'Good Evening';
}

function getStateLabel(state, mode) {
  if (state === 'on_floor') return mode === 'remote' ? '● Working Remotely' : '● Working';
  if (state === 'on_break') return '● On Break';
  return 'Logged Out';
}

export default function Dashboard() {
  const {
    user, state, loading, actionLoading, error,
    workMode, setWorkMode,
    widgets, weeklyData, taskSummary, todayEvents,
    liveFloorSec, liveBreakSec, showConfetti,
    reminders, dismissReminder,
    floorMinutes, progressPercent, progressColor,
    completedTarget, completedMandatory,
    remaining, mandatoryRemaining,
    breakCount, estimatedClockOut, overtimeMinutes,
    isWeekend, clockInTime,
    quote, quoteIndex,
    showClockOutConfirm, setShowClockOutConfirm,
    handleClockIn, handleBreakStart, handleBreakEnd, handleConfirmClockOut,
    radius, circumference, strokeDashoffset,
    displayFloorSec, displayBreakSec,
  } = useDashboardData();

  if (loading) {
    return (
      <div className={s.dashboard}>
        <div className={s['skeleton-banner']} />
        <div className={s['dashboard-row-1']}>
          <div className={s['skeleton-timer-card']}>
            <div className={s['skeleton-circle']} />
            <div className={`${s['skeleton-line']} ${s['skeleton-bar-60']}`} />
            <div className={`${s['skeleton-line']} ${s['skeleton-bar-80']}`} />
            <div className={`${s['skeleton-line']} ${s['skeleton-bar-40']}`} />
          </div>
          <div className={s['skeleton-right']}>
            <div className={s['skeleton-card']} />
            <div className={s['skeleton-card']} />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={s.dashboard}>
      {/* Confetti Animation */}
      {showConfetti && (
        <div className={s['confetti-container']}>
          {CONFETTI_PIECES.map((style, i) => (
            <div key={i} className={s['confetti-piece']} style={style} />
          ))}
        </div>
      )}

      {/* Greeting Banner */}
      <div className={s['greeting-banner']}>
        <div className={s['greeting-left']}>
          <h2 className={s['greeting-text']}>{getGreeting()}, {user?.full_name || 'there'}!</h2>
          <p className={s['greeting-date']}>
            {new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}
          </p>
          {clockInTime && state !== 'logged_out' && (
            <p className={s['greeting-clockin']}>Logged in at <strong>{clockInTime}</strong></p>
          )}
        </div>
        <div className={s['greeting-quote']} key={quoteIndex}>
          <p className={s['quote-text']}>"{quote.text}"</p>
          <p className={s['quote-author']}>— {quote.author}</p>
        </div>
      </div>

      {/* ====== ROW 1: Main 2-column layout ====== */}
      <div className={s['dashboard-row-1']}>
        {/* Left: Timer + Actions */}
        <div className={`status-card ${s['dash-timer-card']}`}>
          <div className={s['dash-badges-row']}>
            <span className={`${s['status-badge']} ${s[isWeekend && state === 'logged_out' ? 'weekend' : state]}`}>
              {isWeekend && state === 'logged_out' ? '🏖 Weekend Holiday' : getStateLabel(state, workMode)}
            </span>
            {state !== 'logged_out' && (
              <span className={`${s['work-mode-badge']} ${s[workMode]}`}>
                {workMode === 'office' ? '🏢 Office' : '🏠 Remote'}
              </span>
            )}
          </div>

          <div className={s['timer-and-progress']}>

            {/* Left Col: Timer + Badges */}
            <div className={s['timer-left-col']}>
              {/* Circular Progress + Timer */}
              <div className={s['circular-progress-wrapper']}>
                <svg className={s['circular-progress']} viewBox="0 0 200 200">
                  <circle className={s['circular-bg']} cx="100" cy="100" r={radius} />
                  <circle
                    className={s['circular-fill']}
                    cx="100" cy="100" r={radius}
                    style={{
                      '--circ-dasharray': circumference,
                      '--circ-dashoffset': strokeDashoffset,
                      '--circ-stroke': progressColor.color,
                      '--circ-glow': progressColor.glow
                    }}
                  />
                </svg>
                <div className={s['circular-inner']}>
                  {state === 'on_floor' && (
                    <>
                      <div className={`${s['circular-time']} ${s['floor-timer']}`}>{formatTimeSec(liveFloorSec)}</div>
                      <div className={s['circular-label']}>Working</div>
                    </>
                  )}
                  {state === 'on_break' && (
                    <>
                      <div className={`${s['circular-time']} ${s['break-timer-text']}`}>{formatTimeSec(liveBreakSec)}</div>
                      <div className={s['circular-label']}>On Break</div>
                      <div className={s['circular-sub']}>{formatTime(floorMinutes)} worked</div>
                    </>
                  )}
                  {state === 'logged_out' && !isWeekend && (
                    <>
                      <div className={s['circular-time']}>{formatTime(0)}</div>
                      <div className={s['circular-label']}>Ready</div>
                    </>
                  )}
                  {state === 'logged_out' && isWeekend && (
                    <>
                      <div className={`${s['circular-time']} ${s['weekend-text']}`}>🌴</div>
                      <div className={s['circular-label']}>Weekend</div>
                    </>
                  )}
                </div>
              </div>

              {/* ETA / Overtime info under timer */}
              <div className={s['timer-under-badges']}>
                {estimatedClockOut && (
                  <div className={s['eta-banner']}>
                    <span className="page-icon">🕐</span> 9hrs by <strong>{estimatedClockOut}</strong>
                  </div>
                )}
                {overtimeMinutes > 0 && (
                  <div className={s['overtime-banner']}>
                    <span className={s['overtime-icon']}>⚡</span>
                    <span>Overtime: <strong>{formatTime(overtimeMinutes)}</strong></span>
                  </div>
                )}
              </div>
            </div>

            {/* Right side info next to ring */}
            <div className={s['timer-info-side']}>
              {/* Today's Stats - inline */}
              {state !== 'logged_out' && (
                <div className={s['inline-stats']}>
                  <div className={s['inline-stat']}>
                    <span className={`${s['inline-stat-icon']} ${s['work-icon']}`}>⏱</span>
                    <div>
                      <div className={s['inline-stat-label']}>Work</div>
                      <div className={`${s['inline-stat-value']} ${s.floor}`}>{formatTime(floorMinutes)}</div>
                    </div>
                  </div>
                  <div className={s['inline-stat']}>
                    <span className={`${s['inline-stat-icon']} ${s['break-icon']}`}>
                      ☕
                      {breakCount > 0 && <span className={s['break-count-badge']}>{breakCount}</span>}
                    </span>
                    <div>
                      <div className={s['inline-stat-label']}>Break</div>
                      <div className={`${s['inline-stat-value']} ${s.break}`}>{formatTime(Math.floor(liveBreakSec / 60))}</div>
                    </div>
                  </div>
                  <div className={s['inline-stat']}>
                    <span className={`${s['inline-stat-icon']} ${s['total-icon']}`}>⏳</span>
                    <div>
                      <div className={s['inline-stat-label']}>Total</div>
                      <div className={`${s['inline-stat-value']} ${s.total}`}>{formatTime(Math.floor(liveFloorSec / 60) + Math.floor(liveBreakSec / 60))}</div>
                    </div>
                  </div>
                </div>
              )}

              <WeeklyChart weeklyData={weeklyData} />
            </div>
          </div>

          {/* Progress Bar */}
          {state !== 'logged_out' && (
            <div className={s['progress-section']}>
              <div className={s['progress-text']}>
                <span>{formatTime(floorMinutes)} of {formatTime(TARGET_HOURS)}</span>
                <span>{Math.round(progressPercent)}%{!completedTarget ? ` • ${formatTime(remaining)} left` : ''}</span>
              </div>
              <div className={s['progress-bar-container']}>
                <div
                  className={s['progress-bar-fill']}
                  style={{ '--progress-width': `${progressPercent}%`, '--progress-bg': `linear-gradient(90deg, ${progressColor.color}, ${progressColor.color}dd)` }}
                />
                {/* 8hr mandatory marker */}
                <div className={s['mandatory-marker']} style={{ '--marker-left': `${(MANDATORY_HOURS / TARGET_HOURS) * 100}%` }} title="8hr mandatory">
                  <span className={s['mandatory-marker-label']}>8h</span>
                </div>
              </div>
            </div>
          )}

          {completedMandatory && !completedTarget && (
            <div className={s['mandatory-complete-banner']}>
              ✅ 8hr mandatory complete! {formatTime(remaining)} to full 9hr target.
            </div>
          )}

          {completedTarget && (
            <div className={s['go-home-banner']}>
              🎉 9 hours complete! Great work today.
            </div>
          )}

          {error && <div className="error-msg error-msg-mt">{error}</div>}

          {/* Action Buttons */}
          <div className={s['action-buttons']}>
            {state === 'logged_out' && !isWeekend && (
              <>
                <div className={s['work-mode-toggle']}>
                  <button
                    className={`${s['mode-btn']} ${workMode === 'office' ? s.active : ''}`}
                    onClick={() => setWorkMode('office')}
                  >
                    🏢 Office
                  </button>
                  <button
                    className={`${s['mode-btn']} ${workMode === 'remote' ? s.active : ''}`}
                    onClick={() => setWorkMode('remote')}
                  >
                    🏠 Remote
                  </button>
                </div>
                <button className="btn btn-success" onClick={handleClockIn} disabled={!!actionLoading}>
                  {actionLoading === 'clockIn' ? 'Clocking in...' : '▶ Clock In'}
                </button>
              </>
            )}
            {state === 'on_floor' && (
              <>
                <button className="btn btn-warning" onClick={handleBreakStart} disabled={!!actionLoading}>
                  {actionLoading === 'breakStart' ? 'Starting...' : '☕ Break'}
                </button>
                <button className="btn btn-danger" onClick={() => setShowClockOutConfirm(true)} disabled={!!actionLoading}>
                  ⏹ Clock Out
                </button>
              </>
            )}
            {state === 'on_break' && (
              <>
                <button className="btn btn-success" onClick={handleBreakEnd} disabled={!!actionLoading}>
                  {actionLoading === 'breakEnd' ? 'Resuming...' : '▶ Resume'}
                </button>
                <button className="btn btn-danger" onClick={() => setShowClockOutConfirm(true)} disabled={!!actionLoading}>
                  ⏹ Clock Out
                </button>
              </>
            )}
          </div>
        </div>

        {/* Right: Today's Events + Tasks */}
        <div className={s['dash-right-col']}>
          <TodayEventsCard events={todayEvents} />
          <TasksSummary taskSummary={taskSummary} />
        </div>
      </div>

      {/* ====== ROW 2: Widgets ====== */}
      <div className={s['dashboard-row-2']}>
        <WidgetsGrid widgets={widgets} />
      </div>

      {/* Clock Out Confirmation */}
      <ConfirmDialog
        isOpen={showClockOutConfirm}
        title="Clock Out"
        message={`You've worked ${formatTime(floorMinutes)} today${!completedMandatory ? ` (${formatTime(mandatoryRemaining)} short of 8hr minimum)` : ''}. Are you sure you want to clock out?`}
        confirmText={actionLoading === 'clockOut' ? 'Clocking out...' : 'Clock Out'}
        onConfirm={handleConfirmClockOut}
        onCancel={() => setShowClockOutConfirm(false)}
      />

      <EventReminderToast reminders={reminders} onDismiss={dismissReminder} />
    </div>
  );
}

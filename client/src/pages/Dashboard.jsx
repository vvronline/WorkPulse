import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useAuth } from '../AuthContext';
import { getStatus, clockIn, breakStart, breakEnd, clockOut, getWidgets, getWeeklyChart, getTaskSummary } from '../api';
import { useWorkState } from '../WorkStateContext';
import WidgetsGrid from '../components/WidgetsGrid';
import WeeklyChart from '../components/WeeklyChart';
import TimelineCard from '../components/TimelineCard';
import TasksSummary from '../components/TasksSummary';
import ConfirmDialog from '../components/ConfirmDialog';
import { useAutoDismiss } from '../hooks/useAutoDismiss';
import { useLiveTimer } from '../hooks/useLiveTimer';
import s from './Dashboard.module.css';

const TARGET_HOURS = 9 * 60; // 9 hours target in minutes
const MANDATORY_HOURS = 8 * 60; // 8 hours mandatory minimum

const QUOTES = [
  { text: "The secret of getting ahead is getting started.", author: "Mark Twain" },
  { text: "Focus on being productive instead of busy.", author: "Tim Ferriss" },
  { text: "Productivity is never an accident.", author: "Paul J. Meyer" },
  { text: "Do the hard jobs first. The easy ones will take care of themselves.", author: "Dale Carnegie" },
  { text: "Amateurs sit and wait for inspiration. The rest of us just get up and go to work.", author: "Stephen King" },
  { text: "Your work is going to fill a large part of your life. Love what you do.", author: "Steve Jobs" },
  { text: "The way to get started is to quit talking and begin doing.", author: "Walt Disney" },
  { text: "Don't count the days. Make the days count.", author: "Muhammad Ali" },
  { text: "Success is the sum of small efforts repeated day in and day out.", author: "Robert Collier" },
  { text: "It's not about having time. It's about making time.", author: "Unknown" },
];

function formatTime(totalMinutes) {
  const hrs = Math.floor(Math.abs(totalMinutes) / 60);
  const mins = Math.abs(totalMinutes) % 60;
  return `${String(hrs).padStart(2, '0')}h ${String(mins).padStart(2, '0')}m`;
}

function formatTimeSec(totalSeconds) {
  const hrs = Math.floor(totalSeconds / 3600);
  const mins = Math.floor((totalSeconds % 3600) / 60);
  const secs = totalSeconds % 60;
  return `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

function getGreeting() {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good Morning';
  if (hour < 17) return 'Good Afternoon';
  return 'Good Evening';
}

function getStateLabel(state, mode) {
  if (state === 'on_floor') return mode === 'remote' ? '● Working' : '● On Floor';
  if (state === 'on_break') return '● On Break';
  return 'Logged Out';
}

function requestNotificationPermission() {
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission();
  }
}

export default function Dashboard() {
  const { user } = useAuth();
  const { setWorkState, setWorkMode: setContextWorkMode } = useWorkState();
  const [status, setStatus] = useState(null);
  const [widgets, setWidgets] = useState(null);
  const [weeklyData, setWeeklyData] = useState(null);
  const [taskSummary, setTaskSummary] = useState(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState('');
  const [error, setError] = useAutoDismiss('');
  const [currentTime, setCurrentTime] = useState(new Date());
  const [workMode, setWorkMode] = useState('office');
  const [showClockOutConfirm, setShowClockOutConfirm] = useState(false);
  const [quoteIndex, setQuoteIndex] = useState(() => Math.floor(Math.random() * QUOTES.length));
  const quoteTimerRef = useRef(null);
  const clockRef = useRef(null);

  // Live timer hook
  const { liveFloorSec, liveBreakSec, showConfetti, reset: resetTimer } = useLiveTimer(status);

  // Rotate quotes every 20 seconds
  useEffect(() => {
    if (quoteTimerRef.current) clearInterval(quoteTimerRef.current);
    quoteTimerRef.current = setInterval(() => {
      setQuoteIndex(prev => (prev + 1) % QUOTES.length);
    }, 20000);
    return () => {
      if (quoteTimerRef.current) clearInterval(quoteTimerRef.current);
    };
  }, []);

  const fetchStatus = useCallback(async () => {
    try {
      const [statusRes, widgetsRes, weeklyRes, taskRes] = await Promise.allSettled([
        getStatus(), getWidgets(), getWeeklyChart(), getTaskSummary()
      ]);
      if (statusRes.status === 'fulfilled') {
        setStatus(statusRes.value.data);
        if (statusRes.value.data.workMode) setWorkMode(statusRes.value.data.workMode);
      } else {
        console.error('Status fetch failed:', statusRes.reason);
        setError('Failed to fetch status');
      }
      if (widgetsRes.status === 'fulfilled') setWidgets(widgetsRes.value.data);
      if (weeklyRes.status === 'fulfilled') setWeeklyData(weeklyRes.value.data);
      if (taskRes.status === 'fulfilled') setTaskSummary(taskRes.value.data);
    } catch (err) {
      console.error('Dashboard fetch error:', err);
      setError('Failed to fetch status');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    fetchStatus();
    requestNotificationPermission();
    clockRef.current = setInterval(() => setCurrentTime(new Date()), 60000);

    const handleVisibility = () => {
      if (!document.hidden) {
        getTaskSummary().then(r => setTaskSummary(r.data)).catch(e => console.error(e));
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);

    return () => {
      controller.abort();
      if (clockRef.current) clearInterval(clockRef.current);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [fetchStatus]);

  const handleAction = async (actionFn, actionName) => {
    setActionLoading(actionName);
    setError('');
    try {
      await actionFn();
      await fetchStatus();
      if (actionName === 'clockOut') resetTimer();
    } catch (err) {
      setError(err.response?.data?.error || 'Action failed');
    } finally {
      setActionLoading('');
    }
  };

  // All useMemo hooks must be called before any early return
  const state = status?.state || 'logged_out';

  // Sync work state & mode to shared context so Navbar can read them
  useEffect(() => {
    setWorkState(state);
  }, [state, setWorkState]);
  useEffect(() => {
    setContextWorkMode(workMode);
  }, [workMode, setContextWorkMode]);

  const displayFloorSec = state === 'logged_out' ? 0 : liveFloorSec;
  const displayBreakSec = state === 'logged_out' ? 0 : liveBreakSec;
  const floorMinutes = Math.floor(displayFloorSec / 60);
  const progressPercent = Math.min((floorMinutes / TARGET_HOURS) * 100, 100);

  const clockInEntry = status?.entries?.find(e => e.entry_type === 'clock_in');
  const clockInTime = useMemo(() => clockInEntry
    ? new Date(clockInEntry.timestamp.replace(' ', 'T') + 'Z').toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : null, [clockInEntry?.timestamp]);

  const progressColor = useMemo(() => {
    if (progressPercent >= 90) return { color: 'var(--success)', glow: 'var(--success-glow)', label: 'progress-green' };
    if (progressPercent >= 60) return { color: 'var(--primary)', glow: 'var(--primary-glow)', label: 'progress-blue' };
    if (progressPercent >= 35) return { color: 'var(--warning)', glow: 'var(--warning-glow)', label: 'progress-yellow' };
    if (progressPercent >= 10) return { color: 'var(--warning)', glow: 'var(--warning-glow)', label: 'progress-orange' };
    return { color: 'var(--danger)', glow: 'var(--danger-glow)', label: 'progress-red' };
  }, [progressPercent]);

  const breakCount = useMemo(() => status?.entries?.filter(e => e.entry_type === 'break_start').length || 0, [status?.entries]);

  const completedTarget = floorMinutes >= TARGET_HOURS;

  const estimatedClockOut = useMemo(() => {
    if (state !== 'on_floor' || completedTarget) return null;
    const remainingSec = (TARGET_HOURS * 60) - liveFloorSec;
    if (remainingSec <= 0) return null;
    const est = new Date(Date.now() + remainingSec * 1000);
    return est.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }, [state, completedTarget, liveFloorSec]);

  const confettiPieces = useMemo(() => {
    const colors = ['#ef4444', '#f97316', '#eab308', '#22c55e', '#3b82f6', '#8b5cf6', '#ec4899'];
    return [...Array(50)].map((_, i) => ({
      '--confetti-left': `${Math.random() * 100}%`,
      '--confetti-delay': `${Math.random() * 2}s`,
      '--confetti-duration': `${2 + Math.random() * 3}s`,
      '--confetti-color': colors[Math.floor(Math.random() * 7)],
      '--confetti-width': `${6 + Math.random() * 6}px`,
      '--confetti-height': `${6 + Math.random() * 6}px`,
    }));
  }, []);

  if (loading) {
    return (
      <div className={s.dashboard}>
        <div className={s['skeleton-banner']} />
        <div className={s['dashboard-row-1']}>
          <div className={s['skeleton-timer-card']}>
            <div className={s['skeleton-circle']} />
            <div className={s['skeleton-line']} style={{ width: '60%', marginTop: '1rem' }} />
            <div className={s['skeleton-line']} style={{ width: '80%' }} />
            <div className={s['skeleton-line']} style={{ width: '40%' }} />
          </div>
          <div className={s['skeleton-right']}>
            <div className={s['skeleton-card']} />
            <div className={s['skeleton-card']} />
          </div>
        </div>
      </div>
    );
  }

  const completedMandatory = floorMinutes >= MANDATORY_HOURS;
  const remaining = Math.max(0, TARGET_HOURS - floorMinutes);
  const mandatoryRemaining = Math.max(0, MANDATORY_HOURS - floorMinutes);
  const isWeekend = status?.isWeekend;
  const quote = QUOTES[quoteIndex];

  // Circular progress values
  const radius = 90;
  const circumference = 2 * Math.PI * radius;
  const strokeDashoffset = circumference - (progressPercent / 100) * circumference;

  // Overtime calculation
  const overtimeMinutes = Math.max(0, floorMinutes - TARGET_HOURS);

  return (
    <div className={s.dashboard}>
      {/* Confetti Animation */}
      {showConfetti && (
        <div className={s['confetti-container']}>
          {confettiPieces.map((style, i) => (
            <div key={i} className={s['confetti-piece']} style={style} />
          ))}
        </div>
      )}

      {/* Greeting Banner */}
      <div className={s['greeting-banner']}>
        <div className={s['greeting-left']}>
          <h2 className={s['greeting-text']}>{getGreeting()}, {user?.full_name || 'there'}!</h2>
          <p className={s['greeting-date']}>
            {currentTime.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}
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
                <button className="btn btn-success" onClick={() => handleAction(() => clockIn(workMode), 'clockIn')} disabled={!!actionLoading}>
                  {actionLoading === 'clockIn' ? 'Clocking in...' : '▶ Clock In'}
                </button>
              </>
            )}
            {state === 'on_floor' && (
              <>
                <button className="btn btn-warning" onClick={() => handleAction(breakStart, 'breakStart')} disabled={!!actionLoading}>
                  {actionLoading === 'breakStart' ? 'Starting...' : '☕ Break'}
                </button>
                <button className="btn btn-danger" onClick={() => setShowClockOutConfirm(true)} disabled={!!actionLoading}>
                  ⏹ Clock Out
                </button>
              </>
            )}
            {state === 'on_break' && (
              <>
                <button className="btn btn-success" onClick={() => handleAction(breakEnd, 'breakEnd')} disabled={!!actionLoading}>
                  {actionLoading === 'breakEnd' ? 'Resuming...' : '▶ Resume'}
                </button>
                <button className="btn btn-danger" onClick={() => setShowClockOutConfirm(true)} disabled={!!actionLoading}>
                  ⏹ Clock Out
                </button>
              </>
            )}
          </div>
        </div>

        {/* Right: Timeline + Tasks */}
        <div className={s['dash-right-col']}>
          <TimelineCard entries={status?.entries} />
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
        confirmLabel={actionLoading === 'clockOut' ? 'Clocking out...' : 'Clock Out'}
        onConfirm={() => { setShowClockOutConfirm(false); handleAction(clockOut, 'clockOut'); }}
        onCancel={() => setShowClockOutConfirm(false)}
      />
    </div>
  );
}

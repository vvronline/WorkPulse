import React from 'react';
import { useDashboardData, CONFETTI_PIECES } from '../hooks/useDashboardData';
import TimerCard from './dashboard/TimerCard';
import DashboardSkeleton from './dashboard/DashboardSkeleton';
import WidgetsGrid from '../components/WidgetsGrid';
import TodayEventsCard from '../components/TodayEventsCard';
import EventReminderToast from '../components/EventReminderToast';
import TasksSummary from '../components/TasksSummary';
import ConfirmDialog from '../components/ConfirmDialog';
import { formatTime } from '../utils/time';
import s from './Dashboard.module.css';

function getGreeting() {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good Morning';
  if (hour < 17) return 'Good Afternoon';
  return 'Good Evening';
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
  } = useDashboardData();

  if (loading) return <DashboardSkeleton />;

  return (
    <div className={s.dashboard}>
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

      {/* Row 1: Timer card + events/tasks column */}
      <div className={s['dashboard-row-1']}>
        <TimerCard
          state={state}
          isWeekend={isWeekend}
          workMode={workMode}
          setWorkMode={setWorkMode}
          liveFloorSec={liveFloorSec}
          liveBreakSec={liveBreakSec}
          breakCount={breakCount}
          floorMinutes={floorMinutes}
          progressPercent={progressPercent}
          progressColor={progressColor}
          radius={radius}
          circumference={circumference}
          strokeDashoffset={strokeDashoffset}
          completedTarget={completedTarget}
          completedMandatory={completedMandatory}
          remaining={remaining}
          mandatoryRemaining={mandatoryRemaining}
          estimatedClockOut={estimatedClockOut}
          overtimeMinutes={overtimeMinutes}
          weeklyData={weeklyData}
          actionLoading={actionLoading}
          error={error}
          handleClockIn={handleClockIn}
          handleBreakStart={handleBreakStart}
          handleBreakEnd={handleBreakEnd}
          onClockOut={() => setShowClockOutConfirm(true)}
        />
        <div className={s['dash-right-col']}>
          <TodayEventsCard events={todayEvents} />
          <TasksSummary taskSummary={taskSummary} />
        </div>
      </div>

      {/* Row 2: Widgets */}
      <div className={s['dashboard-row-2']}>
        <WidgetsGrid widgets={widgets} />
      </div>

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

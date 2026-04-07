import React, { useState } from 'react';
import { useFloatingTimer } from '../../hooks/useFloatingTimer';
import { formatTimeSec, formatTime } from '../../utils/time';
import ConfirmDialog from '../common/ConfirmDialog';
import { Timer, Coffee, Pause, Play, Square, Building2, House, Clock, Zap } from 'lucide-react';
import s from './WorkTimerCard.module.css';

export default function WorkTimerCard() {
    const {
        state, isWeekend, dailyTargetMet,
        workMode, setWorkMode,
        actionLoading, error,
        liveFloorSec, liveBreakSec,
        floorMinutes, progressPercent, progressColor,
        completedTarget, remaining, overtimeMinutes,
        breakCount, estimatedClockOut, targetMinutes,
        showClockOutConfirm, setShowClockOutConfirm,
        handleClockIn, handleBreakStart, handleBreakEnd, handleConfirmClockOut,
        radius, circumference, strokeDashoffset,
    } = useFloatingTimer();

    return (
        <>
            <div className={s.card}>
                {/* Header */}
                <div className={s.header}>
                    <div className={s['header-left']}>
                        <Timer size={14} />
                        <span className={s['header-title']}>Work Timer</span>
                    </div>
                    <span className={`${s['status-dot']} ${s[state]}`} />
                </div>

                {/* Main content — two columns */}
                <div className={s.body}>
                    {/* Left: Ring */}
                    <div className={s['ring-col']}>
                        <div className={s['ring-wrap']}>
                            <svg className={s.ring} viewBox="0 0 100 100">
                                <circle className={s['ring-bg']} cx="50" cy="50" r={radius} />
                                <circle
                                    className={s['ring-fill']}
                                    cx="50" cy="50" r={radius}
                                    style={{
                                        strokeDasharray: circumference,
                                        strokeDashoffset,
                                        stroke: progressColor.color,
                                        filter: `drop-shadow(0 0 4px ${progressColor.glow})`,
                                    }}
                                />
                            </svg>
                            <span className={s['ring-center']}>
                                <span className={`${s['ring-time']} ${s[state]}`}>
                                    {state === 'on_floor' && formatTimeSec(liveFloorSec)}
                                    {state === 'on_break' && formatTimeSec(liveBreakSec)}
                                    {state === 'logged_out' && (dailyTargetMet ? '✓' : '—')}
                                </span>
                            </span>
                        </div>
                        <span className={s.label}>
                            {state === 'on_floor' && 'Working'}
                            {state === 'on_break' && `Break${breakCount > 0 ? ` #${breakCount}` : ''}`}
                            {state === 'logged_out' && (dailyTargetMet ? 'Target Met' : 'Logged Out')}
                        </span>
                    </div>

                    {/* Right: Info + Actions */}
                    <div className={s['info-col']}>
                        {/* Stats */}
                        {state !== 'logged_out' && (
                            <div className={s.stats}>
                                <div className={s.stat}>
                                    <span className={s['stat-label']}>Work</span>
                                    <span className={s['stat-value']}>{formatTime(floorMinutes)}</span>
                                </div>
                                <div className={s['stat-divider']} />
                                <div className={s.stat}>
                                    <span className={s['stat-label']}>Break</span>
                                    <span className={s['stat-value']}>{formatTimeSec(liveBreakSec)}</span>
                                </div>
                                <div className={s['stat-divider']} />
                                <div className={s.stat}>
                                    <span className={s['stat-label']}>Remaining</span>
                                    <span className={s['stat-value']}>{completedTarget ? '—' : formatTime(remaining)}</span>
                                </div>
                                {breakCount > 0 && (
                                    <>
                                        <div className={s['stat-divider']} />
                                        <div className={s.stat}>
                                            <span className={s['stat-label']}>Breaks</span>
                                            <span className={s['stat-value']}>{breakCount}</span>
                                        </div>
                                    </>
                                )}
                            </div>
                        )}

                        {/* Progress bar */}
                        {state !== 'logged_out' && (
                            <div className={s.progress}>
                                <div className={s['progress-track']}>
                                    <div className={s['progress-fill']} style={{ width: `${progressPercent}%`, background: progressColor.color }} />
                                </div>
                                <div className={s['progress-meta']}>
                                    <span className={s['progress-pct']}>{Math.round(progressPercent)}%</span>
                                    <span className={s['progress-target']}>{Math.round(targetMinutes / 60)}hr target</span>
                                </div>
                            </div>
                        )}

                        {/* ETA / Overtime */}
                        {estimatedClockOut && (
                            <div className={s.eta}>
                                <Clock size={12} /> <span>{Math.round(targetMinutes / 60)}hr by <strong>{estimatedClockOut}</strong></span>
                            </div>
                        )}
                        {overtimeMinutes > 0 && (
                            <div className={s.overtime}>
                                <Zap size={12} /> <span>Overtime: <strong>{formatTime(overtimeMinutes)}</strong></span>
                            </div>
                        )}

                        {error && <div className={s.error}>{error}</div>}

                        {/* Actions */}
                        <div className={s.actions}>
                            {state === 'logged_out' && !dailyTargetMet && (
                                <>
                                    <div className={s['mode-toggle']}>
                                        <button
                                            className={`${s['mode-btn']} ${workMode === 'office' ? s.active : ''}`}
                                            onClick={() => setWorkMode('office')}
                                        >
                                            <Building2 size={13} /> Office
                                        </button>
                                        <button
                                            className={`${s['mode-btn']} ${workMode === 'remote' ? s.active : ''}`}
                                            onClick={() => setWorkMode('remote')}
                                        >
                                            <House size={13} /> Remote
                                        </button>
                                    </div>
                                    <button className={`${s.btn} ${s.success}`} onClick={handleClockIn} disabled={!!actionLoading}>
                                        {actionLoading === 'clockIn' ? 'Logging in...' : '▶ Login'}
                                    </button>
                                </>
                            )}

                            {state === 'logged_out' && dailyTargetMet && (
                                <div className={s['target-done']}>✅ Daily target complete!</div>
                            )}

                            {state === 'on_floor' && (
                                <div className={s['btn-row']}>
                                    <button className={`${s.btn} ${s.warning}`} onClick={handleBreakStart} disabled={!!actionLoading}>
                                        <Pause size={14} /> Break
                                    </button>
                                    <button className={`${s.btn} ${s.danger}`} onClick={() => setShowClockOutConfirm(true)} disabled={!!actionLoading}>
                                        <Square size={14} /> Logout
                                    </button>
                                </div>
                            )}

                            {state === 'on_break' && (
                                <div className={s['btn-row']}>
                                    <button className={`${s.btn} ${s.success}`} onClick={handleBreakEnd} disabled={!!actionLoading}>
                                        <Play size={14} /> Resume
                                    </button>
                                    <button className={`${s.btn} ${s.danger}`} onClick={() => setShowClockOutConfirm(true)} disabled={!!actionLoading}>
                                        <Square size={14} /> Logout
                                    </button>
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            </div>

            <ConfirmDialog
                isOpen={showClockOutConfirm}
                title="Logout"
                message={`You've worked ${formatTime(floorMinutes)} today. Are you sure you want to logout?`}
                confirmText={actionLoading === 'clockOut' ? 'Logging out...' : 'Logout'}
                onConfirm={handleConfirmClockOut}
                onCancel={() => setShowClockOutConfirm(false)}
            />
        </>
    );
}

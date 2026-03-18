import WeeklyChart from '../../components/WeeklyChart';
import { formatTime, formatTimeSec } from '../../utils/time';
import { TARGET_HOURS, MANDATORY_HOURS } from '../../hooks/useDashboardData';
import s from '../Dashboard.module.css';

function getStateLabel(state, mode) {
    if (state === 'on_floor') return mode === 'remote' ? '● Working Remotely' : '● Working';
    if (state === 'on_break') return '● On Break';
    return 'Logged Out';
}

/**
 * Timer card — displays the circular progress ring, live timer, stats,
 * progress bar, completion banners, and clock-in/out action buttons.
 *
 * All data comes from useDashboardData via Dashboard.jsx props.
 */
export default function TimerCard({
    state, isWeekend, workMode, setWorkMode,
    liveFloorSec, liveBreakSec, breakCount, floorMinutes,
    progressPercent, progressColor, radius, circumference, strokeDashoffset,
    completedTarget, completedMandatory, remaining, mandatoryRemaining,
    estimatedClockOut, overtimeMinutes,
    weeklyData,
    actionLoading, error,
    handleClockIn, handleBreakStart, handleBreakEnd, onClockOut,
}) {
    return (
        <div className={`status-card ${s['dash-timer-card']}`}>
            {/* Status + work-mode badges */}
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
                {/* Left: circular SVG ring + ETA/overtime banners */}
                <div className={s['timer-left-col']}>
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
                                    '--circ-glow': progressColor.glow,
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

                {/* Right: today's stats + weekly chart */}
                <div className={s['timer-info-side']}>
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

            {/* Linear progress bar (visible while clocked in) */}
            {state !== 'logged_out' && (
                <div className={s['progress-section']}>
                    <div className={s['progress-text']}>
                        <span>{formatTime(floorMinutes)} of {formatTime(TARGET_HOURS)}</span>
                        <span>{Math.round(progressPercent)}%{!completedTarget ? ` • ${formatTime(remaining)} left` : ''}</span>
                    </div>
                    <div className={s['progress-bar-container']}>
                        <div
                            className={s['progress-bar-fill']}
                            style={{
                                '--progress-width': `${progressPercent}%`,
                                '--progress-bg': `linear-gradient(90deg, ${progressColor.color}, ${progressColor.color}dd)`,
                            }}
                        />
                        <div
                            className={s['mandatory-marker']}
                            style={{ '--marker-left': `${(MANDATORY_HOURS / TARGET_HOURS) * 100}%` }}
                            title="8hr mandatory"
                        >
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

            {/* Clock in / break / clock out buttons */}
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
                        <button className="btn btn-danger" onClick={onClockOut} disabled={!!actionLoading}>
                            ⏹ Clock Out
                        </button>
                    </>
                )}
                {state === 'on_break' && (
                    <>
                        <button className="btn btn-success" onClick={handleBreakEnd} disabled={!!actionLoading}>
                            {actionLoading === 'breakEnd' ? 'Resuming...' : '▶ Resume'}
                        </button>
                        <button className="btn btn-danger" onClick={onClockOut} disabled={!!actionLoading}>
                            ⏹ Clock Out
                        </button>
                    </>
                )}
            </div>
        </div>
    );
}

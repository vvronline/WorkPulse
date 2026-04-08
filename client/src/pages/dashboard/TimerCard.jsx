import { Building2, House, Palmtree, Clock, Timer, Coffee, Hourglass, PartyPopper, Target, Zap, Play, CirclePause, LogOut } from 'lucide-react';
import WeeklyChart from '../../components/dashboard/WeeklyChart';
import { formatTime, formatTimeSec } from '../../utils/time';
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
    targetMinutes, dailyTargetMet, onOvertimeRequest,
    weeklyData,
    actionLoading, error,
    handleClockIn, handleBreakStart, handleBreakEnd, onClockOut,
}) {
    return (
        <div className={`status-card ${s['dash-timer-card']}`}>
            {/* Status + work-mode badges */}
            <div className={s['dash-badges-row']}>
                <span className={`${s['status-badge']} ${s[isWeekend && state === 'logged_out' ? 'weekend' : state]}`}>
                    {isWeekend && state === 'logged_out' ? <><Palmtree size={13} /> Weekend Holiday</> : getStateLabel(state, workMode)}
                </span>
                {state !== 'logged_out' && (
                    <span className={`${s['work-mode-badge']} ${s[workMode]}`} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.3rem' }}>
                        {workMode === 'office' ? <Building2 size={13} /> : <House size={13} />}
                        {workMode === 'office' ? 'Office' : 'Remote'}
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
                                    <div className={`${s['circular-time']} ${s['weekend-text']}`}><Palmtree size={36} /></div>
                                    <div className={s['circular-label']}>Weekend</div>
                                </>
                            )}
                        </div>
                    </div>

                    <div className={s['timer-under-badges']}>
                        {estimatedClockOut && (
                            <div className={s['eta-banner']}>
                                <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.3rem' }}><Clock size={14} /> {Math.round(targetMinutes / 60)}hr by <strong>{estimatedClockOut}</strong></span>
                            </div>
                        )}
                        {overtimeMinutes > 0 && (
                            <div className={s['overtime-banner']}>
                                <span className={s['overtime-icon']}><Zap size={14} /></span>
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
                                <span className={`${s['inline-stat-icon']} ${s['work-icon']}`}><Timer size={18} /></span>
                                <div>
                                    <div className={s['inline-stat-label']}>Work</div>
                                    <div className={`${s['inline-stat-value']} ${s.floor}`}>{formatTime(floorMinutes)}</div>
                                </div>
                            </div>
                            <div className={s['inline-stat']}>
                                <span className={`${s['inline-stat-icon']} ${s['break-icon']}`}>
                                    <Coffee size={18} />
                                    {breakCount > 0 && <span className={s['break-count-badge']}>{breakCount}</span>}
                                </span>
                                <div>
                                    <div className={s['inline-stat-label']}>Break</div>
                                    <div className={`${s['inline-stat-value']} ${s.break}`}>{formatTime(Math.floor(liveBreakSec / 60))}</div>
                                </div>
                            </div>
                            <div className={s['inline-stat']}>
                                <span className={`${s['inline-stat-icon']} ${s['total-icon']}`}><Hourglass size={18} /></span>
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



            {completedTarget && (
                <div className={s['go-home-banner']}>
                    <PartyPopper size={18} style={{ flexShrink: 0 }} /> Daily target complete! Great work today.
                </div>
            )}

            {error && <div className="error-msg error-msg-mt">{error}</div>}

            {/* Action buttons */}
            <div className={s['action-buttons']}>
                {state === 'logged_out' && !isWeekend && dailyTargetMet && (
                    <div className={s['daily-target-met-state']}>
                        <p className={s['daily-target-met-msg']}><Target size={16} style={{ display: 'inline', verticalAlign: 'middle' }} /> Daily target complete! Need to keep working?</p>
                        <button className="btn btn-warning" onClick={onOvertimeRequest}>
                            <Zap size={14} /> Apply for Overtime
                        </button>
                    </div>
                )}
                {state === 'logged_out' && !isWeekend && !dailyTargetMet && (
                    <>
                        <div className={s['work-mode-toggle']}>
                            <button
                                className={`${s['mode-btn']} ${workMode === 'office' ? s.active : ''}`}
                                onClick={() => setWorkMode('office')}
                            >
                                <Building2 size={15} /> Office
                            </button>
                            <button
                                className={`${s['mode-btn']} ${workMode === 'remote' ? s.active : ''}`}
                                onClick={() => setWorkMode('remote')}
                            >
                                <House size={15} /> Remote
                            </button>
                        </div>
                        <button className="btn btn-success" onClick={handleClockIn} disabled={!!actionLoading}>
                            {actionLoading === 'clockIn' ? 'Logging in...' : <><Play size={14} /> Login</>}
                        </button>
                    </>
                )}
                {state === 'on_floor' && (
                    <>
                        <button className="btn btn-warning" onClick={handleBreakStart} disabled={!!actionLoading}>
                            {actionLoading === 'breakStart' ? 'Starting...' : <><CirclePause size={14} /> Break</>}
                        </button>
                        <button className="btn btn-danger" onClick={onClockOut} disabled={!!actionLoading}>
                            <LogOut size={14} /> Logout
                        </button>
                    </>
                )}
                {state === 'on_break' && (
                    <>
                        <button className="btn btn-success" onClick={handleBreakEnd} disabled={!!actionLoading}>
                            {actionLoading === 'breakEnd' ? 'Resuming...' : <><Play size={14} /> Resume</>}
                        </button>
                        <button className="btn btn-danger" onClick={onClockOut} disabled={!!actionLoading}>
                            <LogOut size={14} /> Logout
                        </button>
                    </>
                )}
            </div>
        </div>
    );
}

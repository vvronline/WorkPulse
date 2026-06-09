import React, { useState, useRef, useEffect } from "react";
import { useAuth } from "../../AuthContext";
import { useFloatingTimer } from "../../hooks/useFloatingTimer";
import { formatTimeSec, formatTime } from "../../utils/time";
import ConfirmDialog from "../common/ConfirmDialog";
import ClockInVerifyModal from "../attendance/ClockInVerifyModal";
import { Timer, Coffee, Pause, Play, Square, ChevronUp, ChevronDown, X, Building2, House, Clock, Zap } from "lucide-react";
import s from "./FloatingTimer.module.css";

export default function FloatingTimer() {
    const { isAuthenticated } = useAuth();
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
        verificationRequired, submitVerifiedClockIn,
    } = useFloatingTimer();

    // Same flow as WorkTimerCard: if the tenant has attendance verification
    // enabled, open the face+location modal instead of the bare clock-in.
    const [verifyOpen, setVerifyOpen] = useState(false);
    const onLoginClick = () => {
        if (verificationRequired) setVerifyOpen(true);
        else handleClockIn();
    };

    const [expanded, setExpanded] = useState(false);
    const [minimized, setMinimized] = useState(false);
    const wrapperRef = useRef<HTMLDivElement | null>(null);

    // Click outside to collapse
    useEffect(() => {
        if (!expanded) return;
        const handler = (e: MouseEvent) => {
            if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) setExpanded(false);
        };
        document.addEventListener("mousedown", handler);
        return () => document.removeEventListener("mousedown", handler);
    }, [expanded]);

    if (!isAuthenticated) return null;

    // Minimized pill — tiny status dot + timer text
    if (minimized) {
        return (
            <button className={`${s.pill} ${s[state]}`} onClick={() => { setMinimized(false); setExpanded(false); }}>
                <span className={s["pill-dot"]} />
                {state === "on_floor" && <span className={s["pill-time"]}>{formatTimeSec(liveFloorSec)}</span>}
                {state === "on_break" && <span className={s["pill-time"]}>{formatTimeSec(liveBreakSec)}</span>}
                {state === "logged_out" && <span className={s["pill-time"]}>{dailyTargetMet ? "Done ✓" : "Offline"}</span>}
            </button>
        );
    }

    return (
        <>
            <div className={`${s.floating} ${expanded ? s.expanded : ""}`} ref={wrapperRef}>
                {/* Compact view — always visible */}
                <div className={s.compact} onClick={() => setExpanded((p) => !p)}>
                    {/* Mini progress ring */}
                    <div className={s["ring-wrap"]}>
                        <svg className={s.ring} viewBox="0 0 100 100">
                            <circle className={s["ring-bg"]} cx="50" cy="50" r={radius} />
                            <circle
                                className={s["ring-fill"]}
                                cx="50" cy="50" r={radius}
                                style={{
                                    strokeDasharray: circumference,
                                    strokeDashoffset,
                                    stroke: progressColor.color,
                                    filter: `drop-shadow(0 0 4px ${progressColor.glow})`,
                                }}
                            />
                        </svg>
                        <span className={s["ring-icon"]}>
                            {state === "on_floor" && <Timer size={16} />}
                            {state === "on_break" && <Coffee size={16} />}
                            {state === "logged_out" && <Timer size={16} />}
                        </span>
                    </div>

                    {/* Timer text */}
                    <div className={s.info}>
                        <span className={`${s.time} ${s[state]}`}>
                            {state === "on_floor" && formatTimeSec(liveFloorSec)}
                            {state === "on_break" && formatTimeSec(liveBreakSec)}
                            {state === "logged_out" && (dailyTargetMet ? "Done ✓" : "Ready")}
                        </span>
                        <span className={s.label}>
                            {state === "on_floor" && "Working"}
                            {state === "on_break" && `Break${breakCount > 0 ? ` #${breakCount}` : ""}`}
                            {state === "logged_out" && "Logged Out"}
                        </span>
                    </div>

                    {/* Quick action buttons (compact) */}
                    <div className={s["compact-actions"]}>
                        {state === "on_floor" && (
                            <>
                                <button className={`${s["icon-btn"]} ${s.warning}`} onClick={(e) => { e.stopPropagation(); handleBreakStart(); }} disabled={!!actionLoading} title="Start Break">
                                    <Pause size={14} />
                                </button>
                                <button className={`${s["icon-btn"]} ${s.danger}`} onClick={(e) => { e.stopPropagation(); setShowClockOutConfirm(true); }} disabled={!!actionLoading} title="Logout">
                                    <Square size={14} />
                                </button>
                            </>
                        )}
                        {state === "on_break" && (
                            <>
                                <button className={`${s["icon-btn"]} ${s.success}`} onClick={(e) => { e.stopPropagation(); handleBreakEnd(); }} disabled={!!actionLoading} title="Resume">
                                    <Play size={14} />
                                </button>
                                <button className={`${s["icon-btn"]} ${s.danger}`} onClick={(e) => { e.stopPropagation(); setShowClockOutConfirm(true); }} disabled={!!actionLoading} title="Logout">
                                    <Square size={14} />
                                </button>
                            </>
                        )}
                    </div>

                    {/* Expand/collapse toggle + minimize */}
                    <div className={s["toggle-btns"]}>
                        <button className={s["toggle-btn"]} onClick={(e) => { e.stopPropagation(); setExpanded((p) => !p); }} title={expanded ? "Collapse" : "Expand"}>
                            {expanded ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
                        </button>
                        <button className={s["toggle-btn"]} onClick={(e) => { e.stopPropagation(); setMinimized(true); setExpanded(false); }} title="Minimize">
                            <X size={12} />
                        </button>
                    </div>
                </div>

                {/* Expanded details panel */}
                {expanded && (
                    <div className={s.details}>
                        {error && <div className={s["detail-error"]}>{error}</div>}

                        {/* Work / Break stats */}
                        {state !== "logged_out" && (
                            <div className={s["detail-stats"]}>
                                <div className={s["detail-stat"]}>
                                    <span className={s["detail-stat-label"]}>Work</span>
                                    <span className={s["detail-stat-value"]}>{formatTime(floorMinutes)}</span>
                                </div>
                                <div className={s["detail-stat"]}>
                                    <span className={s["detail-stat-label"]}>Break</span>
                                    <span className={s["detail-stat-value"]}>{formatTimeSec(liveBreakSec)}</span>
                                </div>
                                {breakCount > 0 && (
                                    <div className={s["detail-stat"]}>
                                        <span className={s["detail-stat-label"]}>Breaks</span>
                                        <span className={s["detail-stat-value"]}>{breakCount}</span>
                                    </div>
                                )}
                            </div>
                        )}

                        {/* Progress bar */}
                        {state !== "logged_out" && (
                            <div className={s["detail-progress"]}>
                                <div className={s["progress-track"]}>
                                    <div className={s["progress-fill"]} style={{ width: `${progressPercent}%`, background: progressColor.color }} />
                                </div>
                                <span className={s["progress-label"]}>{Math.round(progressPercent)}% of {Math.round(targetMinutes / 60)}hr target</span>
                            </div>
                        )}

                        {/* ETA / Overtime */}
                        {estimatedClockOut && (
                            <div className={s["detail-eta"]}>
                                <Clock size={13} /> {Math.round(targetMinutes / 60)}hr by <strong>{estimatedClockOut}</strong>
                            </div>
                        )}
                        {overtimeMinutes > 0 && (
                            <div className={s["detail-overtime"]}>
                                <Zap size={13} /> Overtime: <strong>{formatTime(overtimeMinutes)}</strong>
                            </div>
                        )}

                        {/* Clock-in controls for logged-out state */}
                        {state === "logged_out" && !dailyTargetMet && (
                            <div className={s["login-section"]}>
                                <div className={s["mode-toggle"]}>
                                    <button
                                        className={`${s["mode-btn"]} ${workMode === "office" ? s.active : ""}`}
                                        onClick={() => setWorkMode("office")}
                                    >
                                        <Building2 size={13} /> Office
                                    </button>
                                    <button
                                        className={`${s["mode-btn"]} ${workMode === "remote" ? s.active : ""}`}
                                        onClick={() => setWorkMode("remote")}
                                    >
                                        <House size={13} /> Remote
                                    </button>
                                </div>
                                <button className={`${s["action-btn"]} ${s.success}`} onClick={onLoginClick} disabled={!!actionLoading}>
                                    {actionLoading === "clockIn" ? "Logging in..." : "▶ Login"}
                                </button>
                            </div>
                        )}

                        {state === "logged_out" && dailyTargetMet && (
                            <div className={s["target-done"]}>✅ Daily target complete!</div>
                        )}
                    </div>
                )}
            </div>

            <ConfirmDialog
                isOpen={showClockOutConfirm}
                title="Logout"
                message={`You've worked ${formatTime(floorMinutes)} today. Are you sure you want to logout?`}
                confirmText={actionLoading === "clockOut" ? "Logging out..." : "Logout"}
                onConfirm={handleConfirmClockOut}
                onCancel={() => setShowClockOutConfirm(false)}
            />

            {verifyOpen && (
                <ClockInVerifyModal
                    workMode={workMode as any}
                    submitClockIn={submitVerifiedClockIn}
                    onSuccess={() => setVerifyOpen(false)}
                    onClose={() => setVerifyOpen(false)}
                />
            )}
        </>
    );
}
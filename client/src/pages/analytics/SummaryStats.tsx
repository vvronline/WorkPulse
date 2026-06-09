import React from "react";
import { formatTime } from "../../utils/time";
import { Building2, House } from "lucide-react";
import s from "./Analytics.module.css";

interface AnalyticsDay {
    floorMinutes: number;
    breakMinutes: number;
    workMode?: string;
    [key: string]: any;
}

interface SummaryStatsProps {
    data: AnalyticsDay[];
}

export default function SummaryStats({ data }: SummaryStatsProps) {
    const totalFloor = data.reduce((sum, d) => sum + d.floorMinutes, 0);
    const totalBreak = data.reduce((sum, d) => sum + d.breakMinutes, 0);
    const workingDays = data.filter((d) => d.floorMinutes > 0).length;
    const avgFloor = workingDays > 0 ? Math.round(totalFloor / workingDays) : 0;
    const daysMetTarget = data.filter((d) => d.floorMinutes >= 480).length;
    const officeDays = data.filter((d) => d.floorMinutes > 0 && d.workMode !== "remote").length;
    const remoteDays = data.filter((d) => d.floorMinutes > 0 && d.workMode === "remote").length;

    return (
        <div className="stats-grid">
            <div className="stat-card">
                <div className="stat-label">Total Work Time</div>
                <div className="stat-value floor">{formatTime(totalFloor)}</div>
            </div>
            <div className="stat-card">
                <div className="stat-label">Total Break Time</div>
                <div className="stat-value break">{formatTime(totalBreak)}</div>
            </div>
            <div className="stat-card">
                <div className="stat-label">Avg Work / Day</div>
                <div className="stat-value floor">{formatTime(avgFloor)}</div>
            </div>
            <div className="stat-card">
                <div className="stat-label">Days Met 8hr Target</div>
                <div className="stat-value total">
                    {daysMetTarget} / {workingDays}
                </div>
            </div>
            <div className="stat-card">
                <div className="stat-label">Office Days</div>
                <div
                    className={`stat-value ${s["text-primary-fill"]}`}
                    style={{ display: "flex", alignItems: "center", gap: "0.35rem" }}
                >
                    <Building2 size={18} /> {officeDays}
                </div>
            </div>
            <div className="stat-card">
                <div className="stat-label">Remote Days</div>
                <div
                    className={`stat-value ${s["text-success-fill"]}`}
                    style={{ display: "flex", alignItems: "center", gap: "0.35rem" }}
                >
                    <House size={18} /> {remoteDays}
                </div>
            </div>
        </div>
    );
}
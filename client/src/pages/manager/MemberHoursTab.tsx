import React, { useState, useEffect } from "react";
import { getMemberHours } from "../../api";
import { House, Building2 } from "lucide-react";
import s from "../Admin.module.css";
import m from "../ManagerDashboard.module.css";

interface MemberHoursTabProps {
    userId: number | string;
}

interface HourRow {
    date: string;
    floorMinutes: number;
    breakMinutes: number;
    workMode?: string;
    [key: string]: any;
}

export default function MemberHoursTab({ userId }: MemberHoursTabProps) {
    const [hours, setHours] = useState<HourRow[]>([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        const now = new Date();
        const to = now.toISOString().split("T")[0];
        const from = new Date(now.getTime() - 30 * 86400000).toISOString().split("T")[0];
        getMemberHours(userId as any, from, to)
            .then((r) => {
                setHours(r.data as HourRow[]);
                setLoading(false);
            })
            .catch(() => setLoading(false));
    }, [userId]);

    if (loading) return <p>Loading...</p>;

    const totalHours = hours.reduce((acc, d) => acc + (d.floorMinutes || 0), 0) / 60;

    return (
        <>
            <h3 className={m["section-heading-mb"]}>
                Hours (Last 30 Days) — Total: {totalHours.toFixed(1)}h
            </h3>
            <table className={s.table}>
                <thead>
                    <tr>
                        <th>Date</th>
                        <th>Work Time</th>
                        <th>Break Time</th>
                        <th>Work Mode</th>
                    </tr>
                </thead>
                <tbody>
                    {hours.map((d) => (
                        <tr key={d.date}>
                            <td>
                                {new Date(d.date + "T00:00:00").toLocaleDateString("en-US", {
                                    weekday: "short",
                                    month: "short",
                                    day: "numeric",
                                })}
                            </td>
                            <td>
                                {Math.floor(d.floorMinutes / 60)}h {d.floorMinutes % 60}m
                            </td>
                            <td>
                                {Math.floor(d.breakMinutes / 60)}h {d.breakMinutes % 60}m
                            </td>
                            <td>
                                {d.workMode === "remote" ? (
                                    <>
                                        <House
                                            size={13}
                                            style={{ marginRight: 3, verticalAlign: "middle" }}
                                        />
                                        Remote
                                    </>
                                ) : (
                                    <>
                                        <Building2
                                            size={13}
                                            style={{ marginRight: 3, verticalAlign: "middle" }}
                                        />
                                        Office
                                    </>
                                )}
                            </td>
                        </tr>
                    ))}
                    {hours.length === 0 && (
                        <tr>
                            <td colSpan={4} className={m["empty-cell"]}>
                                No data found
                            </td>
                        </tr>
                    )}
                </tbody>
            </table>
        </>
    );
}
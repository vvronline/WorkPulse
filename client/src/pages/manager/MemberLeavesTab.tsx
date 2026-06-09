import React, { useState, useEffect } from "react";
import { getMemberLeaves } from "../../api";
import ApprovalBadge from "./ApprovalBadge";
import { LEAVE_ICONS } from "./constants";
import s from "../Admin.module.css";
import m from "../ManagerDashboard.module.css";

interface MemberLeavesTabProps {
    userId: number | string;
}

interface LeaveRow {
    id: number | string;
    date: string;
    leave_type: string;
    duration?: string;
    status?: string;
    reason?: string;
    [key: string]: any;
}

export default function MemberLeavesTab({ userId }: MemberLeavesTabProps) {
    const [leaves, setLeaves] = useState<LeaveRow[]>([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        const now = new Date();
        const from = `${now.getFullYear()}-01-01`;
        getMemberLeaves(userId as any, from)
            .then((r) => {
                setLeaves(r.data as LeaveRow[]);
                setLoading(false);
            })
            .catch(() => setLoading(false));
    }, [userId]);

    if (loading) return <p>Loading...</p>;

    return (
        <>
            <h3 className={m["section-heading-mb"]}>Leave History</h3>
            <table className={s.table}>
                <thead>
                    <tr>
                        <th>Date</th>
                        <th>Type</th>
                        <th>Duration</th>
                        <th>Status</th>
                        <th>Reason</th>
                    </tr>
                </thead>
                <tbody>
                    {leaves.map((l) => (
                        <tr key={l.id}>
                            <td>
                                {new Date(l.date + "T00:00:00").toLocaleDateString("en-US", {
                                    weekday: "short",
                                    month: "short",
                                    day: "numeric",
                                })}
                            </td>
                            <td style={{ display: "flex", alignItems: "center", gap: "0.35rem" }}>
                                {(() => {
                                    const Ic = LEAVE_ICONS[l.leave_type];
                                    return Ic ? <Ic size={14} /> : null;
                                })()}{" "}
                                {l.leave_type}
                            </td>
                            <td>{l.duration || "full"}</td>
                            <td>
                                <ApprovalBadge status={l.status} />
                            </td>
                            <td className={m["text-muted-sm"]}>{l.reason || "—"}</td>
                        </tr>
                    ))}
                    {leaves.length === 0 && (
                        <tr>
                            <td colSpan={5} className={m["empty-cell"]}>
                                No leaves found
                            </td>
                        </tr>
                    )}
                </tbody>
            </table>
        </>
    );
}
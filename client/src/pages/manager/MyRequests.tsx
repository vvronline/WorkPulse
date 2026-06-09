import React, { useState, useEffect } from "react";
import { getMyRequests } from "../../api";
import ApprovalBadge from "./ApprovalBadge";
import RequestDetails from "./RequestDetails";
import s from "../Admin.module.css";
import m from "../ManagerDashboard.module.css";

interface RequestRow {
    id: number | string;
    type?: string;
    status?: string;
    created_at: string;
    approver_name?: string;
    metadata?: Record<string, any> | null;
    [key: string]: any;
}

export default function MyRequests() {
    const [requests, setRequests] = useState<RequestRow[]>([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        getMyRequests({ status: "all" })
            .then((r) => {
                setRequests(r.data as RequestRow[]);
                setLoading(false);
            })
            .catch(() => setLoading(false));
    }, []);

    if (loading) return <p>Loading...</p>;

    return (
        <>
            <h3 className={m["section-heading-mb"]}>Your Submitted Requests</h3>
            <table className={s.table}>
                <thead>
                    <tr>
                        <th>Type</th>
                        <th>Details</th>
                        <th>Status</th>
                        <th>Submitted</th>
                        <th>Reviewed By</th>
                    </tr>
                </thead>
                <tbody>
                    {requests.map((r) => (
                        <tr key={r.id}>
                            <td>
                                <span className={s.badgeRole}>{r.type?.replace("_", " ")}</span>
                            </td>
                            <td className={m["cell-details"]}>
                                <RequestDetails request={r} />
                            </td>
                            <td>
                                <ApprovalBadge status={r.status} />
                            </td>
                            <td className={m["cell-sm"]}>
                                {new Date(r.created_at).toLocaleDateString()}
                            </td>
                            <td>{r.approver_name || "—"}</td>
                        </tr>
                    ))}
                    {requests.length === 0 && (
                        <tr>
                            <td colSpan={5} className={m["empty-cell"]}>
                                No requests submitted
                            </td>
                        </tr>
                    )}
                </tbody>
            </table>
        </>
    );
}
import React from "react";
import s from "../ManualEntry.module.css";

interface PendingRequestsListProps {
    requests: any[];
    keyField: string;
    statusField: string;
    renderTime: (meta: any) => React.ReactNode;
    showReason?: boolean;
    rejectLabel?: string;
    emptyText?: string;
}

/**
 * Reusable list of approval requests (manual entry or overtime).
 *
 * Props:
 *   requests    – array of request objects
 *   keyField    – property name to use as React key (e.g. "request_id" | "id")
 *   statusField – property name that holds the status string (e.g. "approval_status" | "status")
 *   renderTime  – (meta) => string — renders the secondary time/hours line
 *   showReason  – boolean — whether to display r.reason (overtime only)
 *   rejectLabel – prefix for the reject_reason line (default: "Rejected: ")
 *   emptyText   – fallback text when requests is empty
 */
export default function PendingRequestsList({
    requests,
    keyField,
    statusField,
    renderTime,
    showReason = false,
    rejectLabel = "Rejected: ",
    emptyText = "No requests yet.",
}: PendingRequestsListProps) {
    if (!requests || requests.length === 0) {
        return <p className={s["empty-state"]}>{emptyText}</p>;
    }

    return (
        <div className={s["pending-requests"]}>
            {requests.map((r) => {
                const meta = r.metadata || {};
                const status = r[statusField];
                return (
                    <div key={r[keyField]} className={s["pending-item"]}>
                        <div className={s["pending-item-date"]}>
                            {meta.date
                                ? new Date(meta.date + "T00:00:00").toLocaleDateString("en-US", {
                                      weekday: "short",
                                      month: "short",
                                      day: "numeric",
                                  })
                                : "—"}
                        </div>
                        <div className={s["pending-item-time"]}>{renderTime(meta)}</div>
                        <span className={s["pending-item-status"]} data-status={status}>
                            {status}
                        </span>
                        {showReason && r.reason && <div className={s["pending-item-reason"]}>{r.reason}</div>}
                        {r.reject_reason && (
                            <div className={`${s["pending-item-reason"]} ${s["text-danger"]}`}>
                                {rejectLabel}
                                {r.reject_reason}
                            </div>
                        )}
                    </div>
                );
            })}
        </div>
    );
}
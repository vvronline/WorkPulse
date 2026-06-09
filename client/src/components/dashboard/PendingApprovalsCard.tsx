import React, { memo, useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { ClipboardCheck, Check, X } from "lucide-react";
import { getApprovals, approveRequest, rejectRequest } from "../../api";
import s from "./PendingApprovalsCard.module.css";

interface Approval {
    id: number | string;
    type: string;
    requester_name?: string;
    requester_username?: string;
    [key: string]: unknown;
}

function formatType(type: string): string {
    switch (type) {
        case "leave": return "Leave";
        case "manual_entry": return "Manual Entry";
        case "overtime": return "Overtime";
        case "leave_withdraw": return "Leave Withdraw";
        default: return type;
    }
}

const PendingApprovalsCard = memo(function PendingApprovalsCard() {
    const navigate = useNavigate();
    const [approvals, setApprovals] = useState<Approval[]>([]);
    const [loading, setLoading] = useState(true);
    const [actioning, setActioning] = useState<number | string>("");

    const fetch = useCallback(async () => {
        try {
            const res = await getApprovals({ status: "pending" });
            setApprovals((res.data as Approval[]) || []);
        } catch {
            /* silent */
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => { fetch(); }, [fetch]);

    const handleApprove = async (id: number | string) => {
        setActioning(id);
        try { await approveRequest(id); await fetch(); } catch { /* */ }
        finally { setActioning(""); }
    };

    const handleReject = async (id: number | string) => {
        setActioning(id);
        try { await rejectRequest(id); await fetch(); } catch { /* */ }
        finally { setActioning(""); }
    };

    if (loading || approvals.length === 0) return null;

    // Count by type
    const counts: Record<string, number> = {};
    approvals.forEach((a) => { counts[a.type] = (counts[a.type] || 0) + 1; });
    const countParts = Object.entries(counts).map(([t, c]) => `${c} ${formatType(t)}`);

    const preview = approvals.slice(0, 3);

    return (
        <div
            className={`status-card ${s.card}`}
            role="button"
            tabIndex={0}
            onClick={() => navigate("/manager")}
            onKeyDown={(e) => e.key === "Enter" && navigate("/manager")}
        >
            <h3 className={s.title}>
                <span className="page-icon"><ClipboardCheck size={18} /></span> Pending Approvals
                <span className={s.count}>{approvals.length}</span>
            </h3>

            <p className={s.breakdown}>{countParts.join(" · ")}</p>

            <div className={s.list}>
                {preview.map((a) => (
                    <div key={a.id} className={s.item} onClick={(e) => e.stopPropagation()}>
                        <div className={s.itemInfo}>
                            <span className={s.itemName}>{a.requester_name || a.requester_username}</span>
                            <span className={s.itemType}>{formatType(a.type)}</span>
                        </div>
                        <div className={s.actions}>
                            <button
                                className={`${s.actionBtn} ${s.approve}`}
                                onClick={() => handleApprove(a.id)}
                                disabled={!!actioning}
                                title="Approve"
                            >
                                <Check size={13} />
                            </button>
                            <button
                                className={`${s.actionBtn} ${s.reject}`}
                                onClick={() => handleReject(a.id)}
                                disabled={!!actioning}
                                title="Reject"
                            >
                                <X size={13} />
                            </button>
                        </div>
                    </div>
                ))}
            </div>

            {approvals.length > 3 && (
                <p className={s.viewAll}>View All →</p>
            )}
        </div>
    );
});

export default PendingApprovalsCard;
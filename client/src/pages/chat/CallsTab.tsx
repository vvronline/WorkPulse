import { useCallback, useEffect, useState } from "react";
import {
    Check,
    CheckSquare2,
    Phone,
    PhoneIncoming,
    PhoneMissed,
    PhoneOutgoing,
    Square,
    Trash2,
    Video,
    X,
} from "lucide-react";
import { ChatAvatar } from "../../components/chat";
import ConfirmDialog from "../../components/common/ConfirmDialog";
import { deleteCalls, getAllCallHistory } from "../../api";
import s from "./ChatSidebar.module.css";

type CallEntry = {
    id: number;
    caller_id: number | string;
    caller_name?: string | null;
    caller_avatar?: string | null;
    other_name?: string | null;
    other_avatar?: string | null;
    group_name?: string | null;
    is_group?: boolean;
    status?: string;
    call_type?: string;
    duration?: number;
    created_at: string;
};

function formatCallDuration(secs: number): string | null {
    if (!secs) return null;
    const m = Math.floor(secs / 60);
    const sec = secs % 60;
    return m === 0 ? `${sec}s` : `${m}m${sec > 0 ? ` ${sec}s` : ""}`;
}

function formatCallTime(iso: string): string {
    const d = new Date(iso);
    const now = new Date();
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    if (d.toDateString() === now.toDateString()) return time;
    if (d.toDateString() === yesterday.toDateString()) return `Yesterday, ${time}`;
    if (now.getTime() - d.getTime() < 7 * 86400000)
        return `${d.toLocaleDateString([], { weekday: "short" })}, ${time}`;
    return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

interface CallsTabProps {
    userId: number | string;
}

export default function CallsTab({ userId }: CallsTabProps) {
    const [calls, setCalls] = useState<CallEntry[]>([]);
    const [total, setTotal] = useState(0);
    const [loading, setLoading] = useState(true);
    const [selectionMode, setSelectionMode] = useState(false);
    const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
    const [allSelected, setAllSelected] = useState(false);
    const [confirmDelete, setConfirmDelete] = useState(false);
    const [deleting, setDeleting] = useState(false);
    const [error, setError] = useState("");

    const loadCalls = useCallback(async () => {
        setLoading(true);
        setError("");
        try {
            const response = await getAllCallHistory();
            const rows: CallEntry[] = response.data || [];
            const headerTotal = Number(response.headers?.["x-total-count"]);
            setCalls(rows);
            setTotal(Number.isFinite(headerTotal) ? headerTotal : rows.length);
        } catch {
            setCalls([]);
            setTotal(0);
            setError("Could not load call history.");
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        loadCalls();
    }, [loadCalls]);

    const exitSelection = () => {
        setSelectionMode(false);
        setSelectedIds(new Set());
        setAllSelected(false);
        setConfirmDelete(false);
        setError("");
    };

    const toggleCall = (id: number) => {
        setSelectionMode(true);
        setAllSelected(false);
        setSelectedIds((current) => {
            // A row toggle after global Select all converts the selection to an
            // explicit subset of the 100 currently loaded rows.
            const next = allSelected ? new Set(calls.map((call) => call.id)) : new Set(current);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    };

    const enterSelection = (id?: number) => {
        setSelectionMode(true);
        setAllSelected(false);
        setSelectedIds(id == null ? new Set() : new Set([id]));
        setError("");
    };

    const toggleAll = () => {
        if (allSelected) {
            setAllSelected(false);
            setSelectedIds(new Set());
            return;
        }
        setAllSelected(true);
        setSelectedIds(new Set(calls.map((call) => call.id)));
    };

    const selectedCount = allSelected ? total : selectedIds.size;

    const performDelete = async () => {
        if (selectedCount === 0 || deleting) return;
        setDeleting(true);
        setError("");
        try {
            await deleteCalls(allSelected ? { all: true } : [...selectedIds]);
            if (allSelected) {
                setCalls([]);
                setTotal(0);
            } else {
                setCalls((current) => current.filter((call) => !selectedIds.has(call.id)));
                setTotal((current) => Math.max(0, current - selectedIds.size));
            }
            exitSelection();
        } catch {
            setConfirmDelete(false);
            setError("Calls could not be deleted. Please try again.");
        } finally {
            setDeleting(false);
        }
    };

    if (loading)
        return (
            <div className={s.callsEmpty}>
                <div className={s.callsSpinner} />
                <span>Loading…</span>
            </div>
        );

    return (
        <div className={s.callsPanel}>
            {calls.length > 0 && (
                <div className={s.callSelectionBar}>
                    {selectionMode ? (
                        <>
                            <button
                                type="button"
                                className={s.callIconButton}
                                onClick={exitSelection}
                                aria-label="Cancel selection"
                                title="Cancel selection"
                            >
                                <X size={16} />
                            </button>
                            <strong className={s.callSelectionCount}>
                                {selectedCount.toLocaleString()} selected
                            </strong>
                            <button
                                type="button"
                                className={`${s.callActionButton} ${allSelected ? s.callActionButtonActive : ""}`}
                                onClick={toggleAll}
                                aria-pressed={allSelected}
                            >
                                {allSelected ? <Check size={15} /> : <CheckSquare2 size={15} />}
                                {allSelected ? "Clear all" : `Select all ${total.toLocaleString()}`}
                            </button>
                            <button
                                type="button"
                                className={s.callDeleteButton}
                                onClick={() => selectedCount > 0 && setConfirmDelete(true)}
                                disabled={selectedCount === 0 || deleting}
                            >
                                <Trash2 size={15} />
                                Delete
                            </button>
                        </>
                    ) : (
                        <>
                            <span className={s.callHistoryCount}>
                                {total.toLocaleString()} call{total === 1 ? "" : "s"}
                            </span>
                            <button
                                type="button"
                                className={s.callActionButton}
                                onClick={() => enterSelection()}
                            >
                                <CheckSquare2 size={15} />
                                Select
                            </button>
                        </>
                    )}
                </div>
            )}

            {error && (
                <div className={s.callError} role="alert">
                    {error}
                </div>
            )}

            {calls.length === 0 ? (
                <div className={s.callsEmpty}>
                    <Phone size={32} strokeWidth={1.2} />
                    <p>No calls yet</p>
                </div>
            ) : (
                <div className={s.callsList}>
                    {calls.map((call) => {
                        const isOutgoing = Number(call.caller_id) === Number(userId);
                        const isMissed = call.status === "missed" && !isOutgoing;
                        const otherName = isOutgoing
                            ? call.other_name || "Unknown"
                            : call.caller_name || "Unknown";
                        const otherAvatar = isOutgoing ? call.other_avatar : call.caller_avatar;
                        const displayName = call.is_group ? call.group_name || "Group" : otherName;
                        const selected = selectedIds.has(call.id);

                        return (
                            <div
                                key={call.id}
                                className={`${s.callItem} ${isMissed ? s.callItemMissed : ""} ${
                                    selected ? s.callItemSelected : ""
                                } ${selectionMode ? s.callItemSelectable : ""}`}
                                onClick={() => selectionMode && toggleCall(call.id)}
                                onContextMenu={(event) => {
                                    event.preventDefault();
                                    if (!selectionMode) enterSelection(call.id);
                                }}
                            >
                                {selectionMode && (
                                    <span className={s.callCheckbox} aria-hidden="true">
                                        {selected ? <CheckSquare2 size={19} /> : <Square size={19} />}
                                    </span>
                                )}
                                <div className={s.callAvatar}>
                                    <ChatAvatar name={displayName} avatar={otherAvatar} size="md" />
                                </div>
                                <div className={s.callInfo}>
                                    <div className={s.callName}>{displayName}</div>
                                    <div className={s.callMeta}>
                                        {isMissed ? (
                                            <PhoneMissed size={13} className={s.iconMissed} />
                                        ) : isOutgoing ? (
                                            <PhoneOutgoing size={13} className={s.iconOutgoing} />
                                        ) : (
                                            <PhoneIncoming size={13} className={s.iconIncoming} />
                                        )}
                                        <span className={isMissed ? s.callMetaMissed : s.callMetaText}>
                                            {isMissed ? "Missed" : isOutgoing ? "Outgoing" : "Incoming"}
                                            {call.call_type === "video" ? " video" : ""}
                                        </span>
                                        {!!call.duration && (
                                            <span className={s.callDuration}>
                                                · {formatCallDuration(call.duration)}
                                            </span>
                                        )}
                                    </div>
                                </div>
                                <div className={s.callRight}>
                                    <span className={s.callTime}>{formatCallTime(call.created_at)}</span>
                                    <span className={s.callTypeIcon}>
                                        {call.call_type === "video" ? (
                                            <Video size={13} />
                                        ) : (
                                            <Phone size={13} />
                                        )}
                                    </span>
                                </div>
                            </div>
                        );
                    })}
                </div>
            )}

            <ConfirmDialog
                isOpen={confirmDelete}
                title="Delete selected calls?"
                message={`Delete ${selectedCount.toLocaleString()} call${
                    selectedCount === 1 ? "" : "s"
                } from your history? This cannot be undone.`}
                confirmText={deleting ? "Deleting…" : "Delete"}
                onConfirm={performDelete}
                onCancel={() => !deleting && setConfirmDelete(false)}
                isDanger
            />
        </div>
    );
}
import React, { useState, useEffect, useCallback } from "react";
import ReactQuill from "react-quill-new";
import "react-quill-new/dist/quill.snow.css";
import {
    Bug,
    Sparkles,
    ShieldAlert,
    HelpCircle,
    Plus,
    X,
    ChevronDown,
    ChevronUp,
    Trash2,
    Tag,
} from "lucide-react";
import {
    getServiceDeskTickets,
    createServiceDeskTicket,
    getServiceDeskStats,
    deleteServiceDeskTicket,
} from "../../api";
import { useAuth } from "../../AuthContext";
import s from "./ServiceDeskTab.module.css";
import b from "./BacklogTab.module.css";

interface TicketTypeOption {
    value: string;
    label: string;
    icon: React.ReactNode;
    color: string;
}

const TICKET_TYPES: TicketTypeOption[] = [
    { value: "bug", label: "Bug Report", icon: <Bug size={14} />, color: "#ef4444" },
    {
        value: "feature_request",
        label: "Feature Request",
        icon: <Sparkles size={14} />,
        color: "#8b5cf6",
    },
    {
        value: "access_issue",
        label: "Access Issue",
        icon: <ShieldAlert size={14} />,
        color: "#f59e0b",
    },
    { value: "other", label: "Other", icon: <HelpCircle size={14} />, color: "#6b7280" },
];

interface StatusOption {
    value: string;
    label: string;
    color: string;
}

const PRIORITIES: StatusOption[] = [
    { value: "low", label: "Low", color: "#22c55e" },
    { value: "medium", label: "Medium", color: "#f59e0b" },
    { value: "high", label: "High", color: "#ef4444" },
    { value: "critical", label: "Critical", color: "#dc2626" },
];

const STATUSES: StatusOption[] = [
    { value: "open", label: "Open", color: "#3b82f6" },
    { value: "acknowledged", label: "Acknowledged", color: "#8b5cf6" },
    { value: "in_progress", label: "In Progress", color: "#f59e0b" },
    { value: "resolved", label: "Resolved", color: "#22c55e" },
    { value: "closed", label: "Closed", color: "#6b7280" },
];

function getTicketType(type: string): TicketTypeOption {
    return TICKET_TYPES.find((t) => t.value === type) || TICKET_TYPES[3];
}
function getPriority(p: string): StatusOption {
    return PRIORITIES.find((pr) => pr.value === p) || PRIORITIES[1];
}
function getStatus(st: string): StatusOption {
    return STATUSES.find((s) => s.value === st) || STATUSES[0];
}

export default function ServiceDeskTab() {
    const { user } = useAuth() as any;
    const [tickets, setTickets] = useState<any[]>([]);
    const [stats, setStats] = useState<any>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");
    const [formOpen, setFormOpen] = useState(false);
    const [submitting, setSubmitting] = useState(false);
    const [filterStatus, setFilterStatus] = useState("");
    const [filterType, setFilterType] = useState("");
    const [expandedTicket, setExpandedTicket] = useState<number | string | null>(
        null,
    );
    const [deletingId, setDeletingId] = useState<number | string | null>(null);

    // Form fields
    const [title, setTitle] = useState("");
    const [description, setDescription] = useState("");
    const [ticketType, setTicketType] = useState("bug");
    const [priority, setPriority] = useState("medium");

    const fetchTickets = useCallback(async () => {
        try {
            setLoading(true);
            const params: Record<string, string> = {};
            if (filterStatus) params.status = filterStatus;
            if (filterType) params.ticket_type = filterType;
            const res = await getServiceDeskTickets(params);
            setTickets((res.data as any).tickets);
        } catch {
            setError("Failed to load tickets");
        } finally {
            setLoading(false);
        }
    }, [filterStatus, filterType]);

    const fetchStats = useCallback(async () => {
        try {
            const res = await getServiceDeskStats();
            setStats(res.data);
        } catch {
            /* ignore */
        }
    }, []);

    useEffect(() => {
        fetchTickets();
        fetchStats();
    }, [fetchTickets, fetchStats]);

    const handleDelete = async (ticket: any, e: React.MouseEvent) => {
        e.stopPropagation();
        const isOwn = ticket.submitted_by_user_id === user?.id;
        const msg =
            isOwn && ticket.status === "open"
                ? `Cancel ticket "${ticket.title}"? This will also remove it from the platform team's backlog.`
                : `Delete ticket "${ticket.title}"? This cannot be undone.`;
        if (!window.confirm(msg)) return;
        setDeletingId(ticket.id);
        setError("");
        try {
            await deleteServiceDeskTicket(ticket.id);
            setTickets((prev) => prev.filter((t) => t.id !== ticket.id));
            fetchStats();
        } catch (err: any) {
            setError(err.response?.data?.error || "Failed to delete ticket");
        } finally {
            setDeletingId(null);
        }
    };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!title.trim()) return;
        setSubmitting(true);
        setError("");
        try {
            await createServiceDeskTicket({
                title: title.trim(),
                description: description.trim(),
                ticket_type: ticketType,
                priority,
            });
            setTitle("");
            setDescription("");
            setTicketType("bug");
            setPriority("medium");
            setFormOpen(false);
            fetchTickets();
            fetchStats();
        } catch (err: any) {
            setError(err.response?.data?.error || "Failed to submit ticket");
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <div className={s["service-desk"]}>
            {error && <div className="error-msg error-msg-mb">{error}</div>}

            {/* Stats Bar */}
            {stats && (
                <div className={s["stats-bar"]}>
                    <button
                        type="button"
                        className={`${s["stat-chip"]} ${!filterStatus ? s["stat-active"] : ""}`}
                        onClick={() => setFilterStatus("")}
                    >
                        <span className={s["stat-value"]}>{stats.total}</span>
                        <span className={s["stat-label"]}>Total</span>
                    </button>
                    {STATUSES.filter(
                        (st) => stats[st.value] > 0 || st.value === "open",
                    ).map((st) => (
                        <button
                            key={st.value}
                            type="button"
                            className={`${s["stat-chip"]} ${filterStatus === st.value ? s["stat-active"] : ""}`}
                            style={{ "--chip-color": st.color } as React.CSSProperties}
                            onClick={() =>
                                setFilterStatus((prev) =>
                                    prev === st.value ? "" : st.value,
                                )
                            }
                        >
                            <span className={s["stat-value"]}>{stats[st.value] || 0}</span>
                            <span className={s["stat-label"]}>{st.label}</span>
                        </button>
                    ))}
                </div>
            )}

            {/* Toolbar */}
            <div className={s["toolbar"]}>
                <div className={s["filter-row"]}>
                    <select
                        className={s["filter-select"]}
                        value={filterType}
                        onChange={(e) => setFilterType(e.target.value)}
                    >
                        <option value="">All Types</option>
                        {TICKET_TYPES.map((t) => (
                            <option key={t.value} value={t.value}>
                                {t.label}
                            </option>
                        ))}
                    </select>
                </div>
                <button
                    className={`btn btn-primary ${s["new-ticket-btn"]}`}
                    onClick={() => setFormOpen((o) => !o)}
                >
                    {formOpen ? (
                        <>
                            <X size={14} /> Cancel
                        </>
                    ) : (
                        <>
                            <Plus size={14} /> New Ticket
                        </>
                    )}
                </button>
            </div>

            {/* New Ticket Form — mirrors the "New Backlog Ticket" model with an extra Type field */}
            {formOpen && (
                <div className={b["tasks-form-card"]}>
                    <div className={b["form-card-header"]}>
                        <h3>
                            <Plus
                                size={16}
                                style={{ marginRight: 5, verticalAlign: "middle" }}
                            />
                            New Service Desk Ticket
                        </h3>
                        <button
                            className={b["close-form-btn"]}
                            onClick={() => setFormOpen(false)}
                            title="Close"
                            type="button"
                        >
                            <X size={14} />
                        </button>
                    </div>
                    <form onSubmit={handleSubmit} className={b["add-form"]}>
                        <div className="form-group">
                            <input
                                type="text"
                                value={title}
                                onChange={(e) => setTitle(e.target.value)}
                                placeholder="Ticket title..."
                                maxLength={200}
                                required
                                autoFocus
                            />
                        </div>
                        <div className={`form-group ${b["quill-wrapper"]}`}>
                            <ReactQuill
                                theme="snow"
                                value={description}
                                onChange={setDescription}
                                placeholder="Provide details: steps to reproduce (for bugs), expected behavior, etc."
                            />
                        </div>
                        <div className={b["form-extras"]}>
                            <div className={b["form-extra-group"]}>
                                <label>
                                    <Tag
                                        size={13}
                                        style={{ marginRight: 4, verticalAlign: "middle" }}
                                    />
                                    Type
                                </label>
                                <select
                                    value={ticketType}
                                    onChange={(e) => setTicketType(e.target.value)}
                                >
                                    {TICKET_TYPES.map((t) => (
                                        <option key={t.value} value={t.value}>
                                            {t.label}
                                        </option>
                                    ))}
                                </select>
                            </div>
                        </div>
                        <div className={b["form-bottom"]}>
                            <div className={b["priority-selector"]}>
                                {PRIORITIES.map((p) => (
                                    <button
                                        key={p.value}
                                        type="button"
                                        className={`${b["priority-btn"]} ${priority === p.value ? b.active : ""}`}
                                        style={
                                            { "--pri-color": p.color } as React.CSSProperties
                                        }
                                        onClick={() => setPriority(p.value)}
                                    >
                                        {p.label}
                                    </button>
                                ))}
                            </div>
                            <button
                                type="submit"
                                className="btn btn-primary btn-fullwidth"
                                disabled={submitting || !title.trim()}
                            >
                                {submitting ? "Submitting..." : "Create Ticket"}
                            </button>
                        </div>
                    </form>
                </div>
            )}

            {/* Tickets List */}
            {loading ? (
                <div className="loading-spinner">
                    <div className="spinner" />
                </div>
            ) : tickets.length === 0 ? (
                <div className={s["empty-state"]}>
                    <div className={s["empty-icon"]}>🎫</div>
                    <p>No tickets found</p>
                    <span>
                        Submit a ticket to report bugs, request features, or get help with
                        access issues.
                    </span>
                </div>
            ) : (
                <div className={s["tickets-list"]}>
                    {tickets.map((ticket) => {
                        const type = getTicketType(ticket.ticket_type);
                        const pri = getPriority(ticket.priority);
                        const st = getStatus(ticket.status);
                        const isExpanded = expandedTicket === ticket.id;
                        const isOwner = ticket.submitted_by_user_id === user?.id;
                        const canDelete = isOwner && ticket.status === "open";
                        return (
                            <div key={ticket.id} className={s["ticket-card"]}>
                                <div
                                    className={s["ticket-header"]}
                                    onClick={() =>
                                        setExpandedTicket(isExpanded ? null : ticket.id)
                                    }
                                >
                                    <div className={s["ticket-left"]}>
                                        <span
                                            className={s["ticket-type-badge"]}
                                            style={
                                                { "--type-color": type.color } as React.CSSProperties
                                            }
                                        >
                                            {type.icon} {type.label}
                                        </span>
                                        <span className={s["ticket-title"]}>
                                            {ticket.title}
                                        </span>
                                    </div>
                                    <div className={s["ticket-right"]}>
                                        <span
                                            className={s["ticket-priority"]}
                                            style={{ color: pri.color }}
                                        >
                                            {pri.label}
                                        </span>
                                        <span
                                            className={s["ticket-status-badge"]}
                                            style={
                                                {
                                                    "--status-color": st.color,
                                                } as React.CSSProperties
                                            }
                                        >
                                            {st.label}
                                        </span>
                                        <span className={s["ticket-date"]}>
                                            {new Date(ticket.created_at).toLocaleDateString()}
                                        </span>
                                        {canDelete && (
                                            <button
                                                type="button"
                                                className={s["ticket-delete-btn"]}
                                                title="Cancel this ticket"
                                                disabled={deletingId === ticket.id}
                                                onClick={(e) => handleDelete(ticket, e)}
                                            >
                                                <Trash2 size={14} />
                                            </button>
                                        )}
                                        {isExpanded ? (
                                            <ChevronUp size={16} />
                                        ) : (
                                            <ChevronDown size={16} />
                                        )}
                                    </div>
                                </div>
                                {isExpanded && (
                                    <div className={s["ticket-details"]}>
                                        {ticket.description && (
                                            <div className={s["ticket-desc"]}>
                                                {ticket.description}
                                            </div>
                                        )}
                                        <div className={s["ticket-meta"]}>
                                            <span>
                                                Submitted by:{" "}
                                                <strong>{ticket.submitted_by_name}</strong>
                                            </span>
                                            {ticket.tenant_name && (
                                                <span>
                                                    Organization:{" "}
                                                    <strong>{ticket.tenant_name}</strong>
                                                </span>
                                            )}
                                            {ticket.assigned_to && (
                                                <span>
                                                    Assigned to:{" "}
                                                    <strong>{ticket.assigned_to}</strong>
                                                </span>
                                            )}
                                            {ticket.admin_notes && (
                                                <div className={s["admin-notes"]}>
                                                    <strong>Admin Notes:</strong>{" "}
                                                    {ticket.admin_notes}
                                                </div>
                                            )}
                                            {ticket.resolved_at && (
                                                <span>
                                                    Resolved:{" "}
                                                    {new Date(
                                                        ticket.resolved_at,
                                                    ).toLocaleDateString()}
                                                </span>
                                            )}
                                        </div>
                                    </div>
                                )}
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
}
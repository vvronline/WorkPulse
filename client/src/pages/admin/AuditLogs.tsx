import React, { useState, useEffect, useCallback, useMemo } from "react";
import { Filter, X as XIcon, ChevronLeft, ChevronRight, Search, ShieldAlert } from "lucide-react";
import { getAuditLogs, getAdminUsers } from "../../api";
import s from "../Admin.module.css";
import al from "./AuditLogs.module.css";
import su from "./AdminUtils.module.css";

const ENTITY_TYPES = ["user", "leave", "time_entry", "task", "team", "department", "organization", "leave_policy", "holiday", "approval_request", "role_change_request"];
const ACTIONS = ["create", "update", "delete", "approve", "reject", "login", "update_role", "request_role_change", "approve_role_change", "reject_role_change", "deactivate", "reactivate", "admin_create", "admin_update", "admin_delete", "admin_reset_password", "invite", "remove_member"];

interface DateRange {
    key: string;
    label: string;
    days: number | null;
}

const DATE_RANGES: DateRange[] = [
    { key: "all",   label: "All time",   days: null },
    { key: "today", label: "Today",      days: 0 },
    { key: "7d",    label: "Last 7 days", days: 7 },
    { key: "30d",   label: "Last 30 days", days: 30 },
    { key: "90d",   label: "Last 90 days", days: 90 },
];

function rangeToDates(key: string): { from: string | null; to: string | null } {
    const r = DATE_RANGES.find(d => d.key === key);
    if (!r || r.days === null) return { from: null, to: null };
    const to = new Date();
    const from = new Date();
    if (r.days === 0) {
        from.setHours(0, 0, 0, 0);
    } else {
        from.setDate(from.getDate() - r.days);
        from.setHours(0, 0, 0, 0);
    }
    return { from: from.toISOString(), to: to.toISOString() };
}

interface Filters {
    entity_type: string;
    action: string;
    actor_id: string;
    range: string;
    custom_from: string;
    custom_to: string;
}

interface ActorOption {
    id: number;
    full_name: string;
    username: string;
    [key: string]: unknown;
}

interface AuditLog {
    id: number;
    created_at: string;
    action: string;
    entity_type: string;
    entity_id?: number | string | null;
    details?: unknown;
    ip_address?: string | null;
    actor_id?: number | string;
    actor_name?: string;
    actor_username?: string;
    actor_is_inspector?: boolean;
    actor_inspector_real_name?: string;
    actor_inspector_username?: string;
    [key: string]: unknown;
}

export default function AuditLogs() {
    const [logs, setLogs] = useState<AuditLog[]>([]);
    const [total, setTotal] = useState(0);
    const [page, setPage] = useState(0);
    const pageSize = 50;

    const [filters, setFilters] = useState<Filters>({
        entity_type: "",
        action: "",
        actor_id: "",
        range: "all",
        custom_from: "",
        custom_to: "",
    });

    const [actorSearch, setActorSearch] = useState("");
    const [actorOptions, setActorOptions] = useState<ActorOption[]>([]);
    const [actorOpen, setActorOpen] = useState(false);

    // Build server params from filters
    const serverParams = useMemo(() => {
        const p: Record<string, unknown> = { limit: pageSize, offset: page * pageSize };
        if (filters.entity_type) p.entity_type = filters.entity_type;
        if (filters.action) p.action = filters.action;
        if (filters.actor_id) p.actor_id = filters.actor_id;
        if (filters.range === "custom") {
            if (filters.custom_from) p.from = new Date(filters.custom_from).toISOString();
            if (filters.custom_to) p.to = new Date(filters.custom_to).toISOString();
        } else {
            const { from, to } = rangeToDates(filters.range);
            if (from) p.from = from;
            if (to) p.to = to;
        }
        return p;
    }, [filters, page]);

    const fetchLogs = useCallback(() => {
        getAuditLogs(serverParams)
            .then(r => { setLogs((r.data as any)?.logs || []); setTotal((r.data as any)?.total || 0); })
            .catch(e => console.error("audit logs", e));
    }, [serverParams]);

    useEffect(() => { fetchLogs(); }, [fetchLogs]);

    // Reset to page 0 when any filter changes
    useEffect(() => { setPage(0); }, [
        filters.entity_type, filters.action, filters.actor_id,
        filters.range, filters.custom_from, filters.custom_to,
    ]);

    // Actor search (debounced)
    useEffect(() => {
        const t = setTimeout(() => {
            if (actorSearch.length < 2) { setActorOptions([]); return; }
            getAdminUsers({ search: actorSearch, per_page: 8 })
                .then(r => setActorOptions((r.data as any)?.data || r.data || []))
                .catch(() => setActorOptions([]));
        }, 250);
        return () => clearTimeout(t);
    }, [actorSearch]);

    const totalPages = Math.ceil(total / pageSize);
    const activeChipCount = [
        filters.entity_type, filters.action, filters.actor_id,
        filters.range !== "all" ? filters.range : "",
    ].filter(Boolean).length;

    const clearAll = () => {
        setFilters({ entity_type: "", action: "", actor_id: "", range: "all", custom_from: "", custom_to: "" });
        setActorSearch("");
    };

    const setActor = (u: ActorOption) => {
        setFilters(f => ({ ...f, actor_id: String(u.id) }));
        setActorSearch(u.full_name);
        setActorOpen(false);
    };

    const clearActor = () => {
        setFilters(f => ({ ...f, actor_id: "" }));
        setActorSearch("");
        setActorOpen(false);
    };

    return (
        <div style={{ display: "flex", flexDirection: "column", gap: "0.85rem" }}>
            <p className={su["section-desc"]} style={{ margin: 0 }}>
                Track all administrative actions and system events.
            </p>

            {/* Filter chips row */}
            <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem", alignItems: "center" }}>
                <span style={{
                    fontSize: "0.7rem", textTransform: "uppercase", letterSpacing: "0.08em",
                    color: "var(--text-secondary)", fontWeight: 700, opacity: 0.7,
                    display: "inline-flex", alignItems: "center", gap: 4,
                }}>
                    <Filter size={11} />Filter
                </span>

                {/* Date range chips */}
                {DATE_RANGES.map(r => (
                    <button
                        key={r.key}
                        type="button"
                        onClick={() => setFilters(f => ({ ...f, range: r.key }))}
                        style={chipStyle(filters.range === r.key)}
                    >{r.label}</button>
                ))}

                {/* Entity-type select chip */}
                <select
                    value={filters.entity_type}
                    onChange={e => setFilters(f => ({ ...f, entity_type: e.target.value }))}
                    style={selectChipStyle(!!filters.entity_type)}
                    aria-label="Entity filter"
                >
                    <option value="">All entities</option>
                    {ENTITY_TYPES.map(t => <option key={t} value={t}>{t.replace(/_/g, " ")}</option>)}
                </select>

                {/* Action select chip */}
                <select
                    value={filters.action}
                    onChange={e => setFilters(f => ({ ...f, action: e.target.value }))}
                    style={selectChipStyle(!!filters.action)}
                    aria-label="Action filter"
                >
                    <option value="">All actions</option>
                    {ACTIONS.map(a => <option key={a} value={a}>{a.replace(/_/g, " ")}</option>)}
                </select>

                {/* Actor combobox */}
                <div style={{ position: "relative" }}>
                    <div style={{
                        display: "inline-flex", alignItems: "center", gap: 4,
                        border: `1px solid ${filters.actor_id ? "var(--accent)" : "var(--border)"}`,
                        background: filters.actor_id ? "color-mix(in srgb, var(--accent) 16%, transparent)" : "transparent",
                        borderRadius: 999, padding: "0 0.5rem 0 0.65rem", height: 30,
                    }}>
                        <Search size={11} color="var(--text-secondary)" />
                        <input
                            value={actorSearch}
                            onChange={e => { setActorSearch(e.target.value); setActorOpen(true); if (filters.actor_id) setFilters(f => ({ ...f, actor_id: "" })); }}
                            onFocus={() => setActorOpen(true)}
                            onBlur={() => setTimeout(() => setActorOpen(false), 150)}
                            placeholder="Actor..."
                            aria-label="Filter by actor"
                            style={{
                                background: "transparent", border: "none", outline: "none",
                                color: filters.actor_id ? "var(--accent)" : "var(--text-primary)",
                                font: "inherit", fontSize: "0.8rem", fontWeight: filters.actor_id ? 600 : 500,
                                width: 130,
                            }}
                        />
                        {filters.actor_id && (
                            <button
                                type="button"
                                onClick={clearActor}
                                style={{ background: "none", border: "none", color: "var(--accent)", cursor: "pointer", display: "inline-flex" }}
                                aria-label="Clear actor"
                            ><XIcon size={12} /></button>
                        )}
                    </div>
                    {actorOpen && actorOptions.length > 0 && (
                        <div style={{
                            position: "absolute", top: "calc(100% + 4px)", left: 0,
                            background: "var(--bg-elevated, var(--bg, #252525))",
                            border: "1px solid var(--border)", borderRadius: 8,
                            minWidth: 220, maxWidth: 280, zIndex: 50,
                            boxShadow: "0 8px 28px rgba(0,0,0,0.35)",
                            maxHeight: 280, overflowY: "auto",
                        }}>
                            {actorOptions.map(u => (
                                <button
                                    key={u.id}
                                    onMouseDown={() => setActor(u)}
                                    style={{
                                        display: "block", width: "100%", textAlign: "left",
                                        padding: "0.5rem 0.75rem", background: "none", border: "none",
                                        color: "var(--text-primary)", cursor: "pointer",
                                        fontFamily: "inherit", fontSize: "0.85rem",
                                    }}
                                    onMouseEnter={e => e.currentTarget.style.background = "color-mix(in srgb, var(--accent) 12%, transparent)"}
                                    onMouseLeave={e => e.currentTarget.style.background = "transparent"}
                                >
                                    <div style={{ fontWeight: 600 }}>{u.full_name}</div>
                                    <div style={{ fontSize: "0.74rem", color: "var(--text-secondary)" }}>@{u.username}</div>
                                </button>
                            ))}
                        </div>
                    )}
                </div>

                {activeChipCount > 0 && (
                    <button type="button" onClick={clearAll} style={chipStyle(false, true)}>
                        <XIcon size={12} />Clear all
                    </button>
                )}

                <span style={{ marginLeft: "auto", fontSize: "0.78rem", color: "var(--text-secondary)" }}>
                    {total.toLocaleString()} log{total === 1 ? "" : "s"}
                </span>
            </div>

            {/* Custom date range pickers (shown only if range = custom; we add a chip for it) */}
            {(filters.range === "custom" || (filters.custom_from || filters.custom_to)) && (
                <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap", fontSize: "0.83rem" }}>
                    <span style={{ color: "var(--text-secondary)" }}>From</span>
                    <input
                        type="datetime-local"
                        value={filters.custom_from}
                        onChange={e => setFilters(f => ({ ...f, range: "custom", custom_from: e.target.value }))}
                        style={dateInputStyle}
                    />
                    <span style={{ color: "var(--text-secondary)" }}>to</span>
                    <input
                        type="datetime-local"
                        value={filters.custom_to}
                        onChange={e => setFilters(f => ({ ...f, range: "custom", custom_to: e.target.value }))}
                        style={dateInputStyle}
                    />
                </div>
            )}

            {/* Add a "Custom range" chip option (separate so we don't confuse with the preset chips) */}
            {filters.range !== "custom" && (
                <div style={{ marginTop: -4 }}>
                    <button
                        type="button"
                        onClick={() => setFilters(f => ({ ...f, range: "custom" }))}
                        style={{
                            background: "transparent", border: "none", color: "var(--text-secondary)",
                            cursor: "pointer", fontSize: "0.78rem", textDecoration: "underline",
                            font: "inherit", padding: 0,
                        }}
                    >Use custom date range…</button>
                </div>
            )}

            {/* Logs table */}
            <table className={s.table}>
                <thead>
                    <tr>
                        <th>Time</th><th>Actor</th><th>Action</th><th>Entity</th><th>Details</th><th>IP</th>
                    </tr>
                </thead>
                <tbody>
                    {logs.map(log => (
                        <tr key={log.id}>
                            <td className={al["audit-time"]}>{new Date(log.created_at).toLocaleString()}</td>
                            <td>{renderActor(log)}</td>
                            <td><span className={`${s.badge} ${al["badge-accent"]}`}>{log.action}</span></td>
                            <td>{log.entity_type}{log.entity_id ? ` #${log.entity_id}` : ""}</td>
                            <td className={al["audit-details"]}>
                                {log.details ? safeStringify(log.details) : "—"}
                            </td>
                            <td className={su["text-xs"]}>{log.ip_address || "—"}</td>
                        </tr>
                    ))}
                    {logs.length === 0 && (
                        <tr><td colSpan={6} className={s.emptyRow}>No logs match the current filters.</td></tr>
                    )}
                </tbody>
            </table>

            {totalPages > 1 && (
                <div className={s.pagination}>
                    <button disabled={page === 0} onClick={() => setPage(p => p - 1)}>
                        <ChevronLeft size={14} style={{ verticalAlign: "middle" }} /> Previous
                    </button>
                    <span className={su["text-muted-sm"]}>Page {page + 1} of {totalPages}</span>
                    <button disabled={page >= totalPages - 1} onClick={() => setPage(p => p + 1)}>
                        Next <ChevronRight size={14} style={{ verticalAlign: "middle" }} />
                    </button>
                </div>
            )}
        </div>
    );
}

/**
 * Render the "Actor" cell for an audit log row.
 *
 * Synthetic Platform Inspector rows are emitted when a platform admin enters
 * the tenant via consent-gated impersonation. The tenant `users` row that
 * the action is attributed to has username `platform_inspector_<adminId>`,
 * full_name "<Inspector Name> (Platform Support)". The server (audit.js
 * `annotateInspectorActors`) additionally resolves the real platform admin's
 * username/full_name from the master DB and attaches them as
 * `actor_inspector_real_name` / `actor_inspector_username` — surface that
 * here so tenant auditors can see *who* the human behind the support badge
 * was, not just that "Support" did it.
 */
function renderActor(log: AuditLog): React.ReactNode {
    const baseLabel = log.actor_name || log.actor_username || `User #${log.actor_id}`;
    if (!log.actor_is_inspector) return baseLabel;
    const realName = log.actor_inspector_real_name || log.actor_inspector_username;
    return (
        <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
            <ShieldAlert size={12} style={{ color: "var(--warning, #f59e0b)", flexShrink: 0 }} />
            <span>{baseLabel}</span>
            {realName && (
                <span style={{
                    fontSize: "0.72rem",
                    color: "var(--text-secondary)",
                    fontStyle: "italic",
                }}>
                    (real: {realName})
                </span>
            )}
        </span>
    );
}

function safeStringify(v: unknown): string {
    try {
        const obj = typeof v === "string" ? JSON.parse(v) : v;
        const str = JSON.stringify(obj);
        return str.length > 240 ? `${str.slice(0, 237)}…` : str;
    } catch {
        return String(v);
    }
}

const chipStyle = (active: boolean, danger?: boolean): React.CSSProperties => ({
    display: "inline-flex",
    alignItems: "center",
    gap: 4,
    border: `1px solid ${active ? "var(--accent)" : "var(--border)"}`,
    background: active ? "color-mix(in srgb, var(--accent) 16%, transparent)" : "transparent",
    color: active ? "var(--accent)" : (danger ? "var(--text-secondary)" : "var(--text-primary)"),
    padding: "0.3rem 0.7rem",
    borderRadius: 999,
    fontSize: "0.78rem",
    fontWeight: 600,
    cursor: "pointer",
    fontFamily: "inherit",
    height: 30,
});

const selectChipStyle = (active: boolean): React.CSSProperties => ({
    border: `1px solid ${active ? "var(--accent)" : "var(--border)"}`,
    background: active ? "color-mix(in srgb, var(--accent) 16%, transparent)" : "var(--input-bg, var(--bg-secondary))",
    color: active ? "var(--accent)" : "var(--text-primary)",
    fontWeight: active ? 600 : 500,
    padding: "0 0.6rem",
    borderRadius: 999,
    fontSize: "0.78rem",
    cursor: "pointer",
    fontFamily: "inherit",
    height: 30,
    minWidth: 120,
});

const dateInputStyle: React.CSSProperties = {
    padding: "0.4rem 0.55rem",
    border: "1px solid var(--border)",
    background: "var(--input-bg, var(--bg-secondary))",
    color: "var(--text-primary)",
    borderRadius: 8,
    fontFamily: "inherit",
    fontSize: "0.82rem",
};
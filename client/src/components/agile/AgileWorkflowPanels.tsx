/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * AgileWorkflowPanels — task & sprint workflow widgets shared across the
 * Tasks page and the task detail modal.
 *
 * Components exported:
 *   - <BlockerControl task onChanged />              inline toggle + reason
 *   - <DependenciesPanel task />                     list / add / remove links
 *   - <ParentChildPanel task />                      Epic ↔ children (parent link)
 *   - <BurndownChart sprintId height? />             SVG line chart
 *   - <VelocityChart limit? height? />               SVG bar chart
 *   - <SprintLifecycleControls sprint onChanged />   Start / Complete buttons
 *
 * Bundled in one file because they all share the same CSS module, the same
 * Agile-config context, and the same set of API wrappers — splitting them
 * would multiply the imports without any tree-shake benefit.
 *
 * Charts are drawn with bare SVG (no recharts dep) — keeps the bundle lean
 * and avoids another runtime dependency.
 */
import React, { useEffect, useMemo, useState, useCallback } from "react";
import {
    PlayCircle,
    CheckCircle,
    AlertCircle,
    Plus,
    X,
    Search,
    LineChart as LineIcon,
    BarChart3,
    Link as LinkIcon,
} from "lucide-react";
import {
    setTaskBlocker,
    getTaskDependencies,
    addTaskDependency,
    removeTaskDependency,
    quicksearchTasks,
    getSprintBurndown,
    getRecentVelocity,
    startSprint,
    completeSprint,
    getSprints,
    getTaskChildren,
    getTaskParent,
    setTaskParent,
} from "../../api";
import { useAgileConfig } from "../../AgileConfigContext";
import s from "./AgileWorkflowPanels.module.css";

type TaskLike = any;
type SprintLike = any;

// ────────────────────────────────────────────────────────────────────────────
// BlockerControl
// ────────────────────────────────────────────────────────────────────────────
interface BlockerControlProps {
    task: TaskLike;
    canEdit?: boolean;
    onChanged?: (data: any) => void;
}

export function BlockerControl({
    task,
    canEdit = true,
    onChanged,
}: BlockerControlProps) {
    const { features } = useAgileConfig();
    const [busy, setBusy] = useState(false);
    const [editing, setEditing] = useState(false);
    const [reason, setReason] = useState(task?.blocked_reason || "");
    if (!features.blockers || !task) return null;

    const toggle = async () => {
        if (!canEdit || busy) return;
        if (!task.is_blocked) {
            setEditing(true);
            return;
        }
        setBusy(true);
        try {
            const r = await setTaskBlocker(task.id, false, undefined);
            onChanged && onChanged(r.data);
        } finally {
            setBusy(false);
        }
    };

    const submitBlock = async () => {
        if (!canEdit || busy) return;
        setBusy(true);
        try {
            const r = await setTaskBlocker(task.id, true, reason);
            setEditing(false);
            onChanged && onChanged(r.data);
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className={s.blockerControl}>
            {!editing && (
                <button
                    type="button"
                    className={`${s.blockerBtn} ${task.is_blocked ? s.blocked : ""}`}
                    onClick={toggle}
                    disabled={!canEdit || busy}
                    title={
                        task.blocked_reason ||
                        (task.is_blocked ? "Blocked" : "Mark as blocked")
                    }
                >
                    <AlertCircle size={13} />
                    {task.is_blocked ? "Blocked" : "Mark blocked"}
                </button>
            )}
            {editing && (
                <div className={s.blockerForm}>
                    <input
                        autoFocus
                        value={reason}
                        onChange={(e) => setReason(e.target.value)}
                        placeholder="Why is this blocked?"
                        maxLength={500}
                        className={s.blockerInput}
                    />
                    <button
                        className="btn btn-danger btn-sm"
                        onClick={submitBlock}
                        disabled={busy}
                    >
                        Block
                    </button>
                    <button
                        className="btn btn-secondary btn-sm"
                        onClick={() => setEditing(false)}
                    >
                        Cancel
                    </button>
                </div>
            )}
            {task.is_blocked && task.blocked_reason && !editing && (
                <span className={s.blockerReason}>“{task.blocked_reason}”</span>
            )}
        </div>
    );
}

// ────────────────────────────────────────────────────────────────────────────
// DependenciesPanel
// ────────────────────────────────────────────────────────────────────────────
const DEP_TYPES = [
    { key: "blocks", label: "Blocks" },
    { key: "relates", label: "Relates to" },
    { key: "duplicates", label: "Duplicates" },
    { key: "clones", label: "Clones" },
];

interface DependenciesPanelProps {
    task: TaskLike;
    canEdit?: boolean;
}

export function DependenciesPanel({
    task,
    canEdit = true,
}: DependenciesPanelProps) {
    const { features } = useAgileConfig();
    const [data, setData] = useState<{ blocks: any[]; blockedBy: any[] }>({
        blocks: [],
        blockedBy: [],
    });
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");
    const [adding, setAdding] = useState(false);
    const [linkType, setLinkType] = useState("blocks");
    const [search, setSearch] = useState("");
    const [results, setResults] = useState<any[]>([]);
    const [searching, setSearching] = useState(false);

    const reload = useCallback(async () => {
        if (!task?.id) return;
        setLoading(true);
        try {
            const r = await getTaskDependencies(task.id);
            setData(r.data || { blocks: [], blockedBy: [] });
        } catch {
            setData({ blocks: [], blockedBy: [] });
        } finally {
            setLoading(false);
        }
    }, [task?.id]);

    useEffect(() => {
        reload();
    }, [reload]);

    // Debounced quicksearch
    useEffect(() => {
        if (!adding) return;
        if (!search.trim()) {
            setResults([]);
            return;
        }
        const handle = setTimeout(async () => {
            setSearching(true);
            try {
                const r = await quicksearchTasks(search.trim());
                setResults(
                    (r.data.tasks || []).filter((t: any) => t.id !== task?.id),
                );
            } catch {
                setResults([]);
            } finally {
                setSearching(false);
            }
        }, 200);
        return () => clearTimeout(handle);
    }, [search, adding, task?.id]);

    const link = async (otherId: number | string) => {
        try {
            await addTaskDependency(task.id, otherId, linkType);
            setAdding(false);
            setSearch("");
            setResults([]);
            reload();
        } catch (e) {
            const err = e as { response?: { data?: { error?: string } } };
            setError(err?.response?.data?.error || "Failed to add link");
        }
    };

    const unlink = async (linkId: number | string) => {
        try {
            await removeTaskDependency(task.id, linkId);
            reload();
        } catch (e) {
            const err = e as { response?: { data?: { error?: string } } };
            setError(err?.response?.data?.error || "Failed to remove link");
        }
    };

    if (!features.dependencies) return null;
    if (loading)
        return <div className={s.depLoading}>Loading dependencies…</div>;

    const sections = [
        { title: "Blocks", items: data.blocks, dirHint: "This task blocks…" },
        {
            title: "Blocked by",
            items: data.blockedBy,
            dirHint: "This task is blocked by…",
        },
    ];

    return (
        <div className={s.depWrap}>
            <div className={s.depHeader}>
                <div className={s.depTitle}>
                    <LinkIcon size={13} /> Dependencies
                </div>
                {canEdit && (
                    <button
                        className="btn btn-secondary btn-sm"
                        onClick={() => setAdding((v) => !v)}
                    >
                        <Plus size={12} /> {adding ? "Cancel" : "Add"}
                    </button>
                )}
            </div>

            {adding && canEdit && (
                <div className={s.depAddBox}>
                    <div className={s.depAddRow}>
                        <select
                            value={linkType}
                            onChange={(e) => setLinkType(e.target.value)}
                            className={s.depTypeSel}
                        >
                            {DEP_TYPES.map((t) => (
                                <option key={t.key} value={t.key}>
                                    {t.label}
                                </option>
                            ))}
                        </select>
                        <div className={s.depSearchWrap}>
                            <Search size={12} className={s.depSearchIcon} />
                            <input
                                autoFocus
                                value={search}
                                onChange={(e) => setSearch(e.target.value)}
                                placeholder="Search tasks by ID or title…"
                                className={s.depSearchInput}
                            />
                        </div>
                    </div>
                    {searching && <div className={s.depHint}>Searching…</div>}
                    {!searching && search.trim() && results.length === 0 && (
                        <div className={s.depHint}>No matching tasks</div>
                    )}
                    {results.length > 0 && (
                        <ul className={s.depResults}>
                            {results.map((r) => (
                                <li key={r.id} onClick={() => link(r.id)}>
                                    <span className={s.depResultId}>
                                        #{r.id}
                                    </span>{" "}
                                    {r.title}
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
            )}

            {sections.map((sec) => (
                <div key={sec.title} className={s.depSection}>
                    <div className={s.depSectionTitle}>{sec.title}</div>
                    {sec.items.length === 0 ? (
                        <div className={s.depEmpty}>{sec.dirHint || "None"}</div>
                    ) : (
                        <ul className={s.depList}>
                            {sec.items.map((it: any) => (
                                <li
                                    key={it.link_id}
                                    className={`${s.depItem} ${it.is_blocked ? s.itemBlocked : ""}`}
                                >
                                    <span
                                        className={s.depBadge}
                                        data-type={it.type}
                                    >
                                        {it.type}
                                    </span>
                                    <span className={s.depItemId}>#{it.id}</span>
                                    <span className={s.depItemTitle}>
                                        {it.title}
                                    </span>
                                    {canEdit && (
                                        <button
                                            className={s.depRemoveBtn}
                                            onClick={() => unlink(it.link_id)}
                                            title="Remove link"
                                        >
                                            <X size={12} />
                                        </button>
                                    )}
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
            ))}

            {error && <div className={s.depError}>{error}</div>}
        </div>
    );
}

// ────────────────────────────────────────────────────────────────────────────
// BurndownChart — small inline SVG line chart
// ────────────────────────────────────────────────────────────────────────────
interface BurndownChartProps {
    sprintId: number | string;
    height?: number;
}

export function BurndownChart({ sprintId, height = 200 }: BurndownChartProps) {
    const { unitLabel } = useAgileConfig();
    const [data, setData] = useState<any>(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        if (!sprintId) return;
        setLoading(true);
        getSprintBurndown(sprintId)
            .then((r) => setData(r.data))
            .catch(() => setData(null))
            .finally(() => setLoading(false));
    }, [sprintId]);

    const chart = useMemo(() => {
        if (!data) return null;
        const padL = 40,
            padR = 12,
            padT = 12,
            padB = 28;
        const w = 600,
            h = height;
        const innerW = w - padL - padR;
        const innerH = h - padT - padB;

        const idealPoints = (data.ideal || []).map(
            (p: any, i: number, arr: any[]) => ({
                x: padL + (innerW * i) / Math.max(1, arr.length - 1),
                y:
                    padT +
                    innerH -
                    innerH * (Number(p.remaining) / Math.max(1, data.startScope)),
                date: p.date,
                value: p.remaining,
            }),
        );

        const actualPoints = (data.snapshots || []).map((sn: any) => {
            // Position actual snapshots along the same horizontal axis as the ideal,
            // using their day-offset from sprint start.
            const start = new Date(data.sprint.start_date);
            const dayIdx = Math.round(
                (new Date(sn.snapshot_date).getTime() - start.getTime()) /
                    86400000,
            );
            const totalDays = Math.max(1, idealPoints.length - 1);
            const x =
                padL +
                (innerW * Math.max(0, Math.min(dayIdx, totalDays))) / totalDays;
            const y =
                padT +
                innerH -
                innerH *
                    (Number(sn.remaining_points) / Math.max(1, data.startScope));
            return { x, y, date: sn.snapshot_date, value: sn.remaining_points };
        });

        const path = (pts: any[]) =>
            pts.length === 0
                ? ""
                : `M ${pts[0].x.toFixed(1)} ${pts[0].y.toFixed(1)} ` +
                  pts
                      .slice(1)
                      .map((p) => `L ${p.x.toFixed(1)} ${p.y.toFixed(1)}`)
                      .join(" ");

        const yTicks = 4;
        const yLabels = Array.from({ length: yTicks + 1 }, (_, i) => {
            const v = data.startScope * (1 - i / yTicks);
            const y = padT + (innerH * i) / yTicks;
            return { y, value: Math.round(v) };
        });

        return {
            padL,
            padR,
            padT,
            padB,
            w,
            h,
            innerW,
            innerH,
            idealPoints,
            actualPoints,
            path,
            yLabels,
        };
    }, [data, height]);

    if (loading) return <div className={s.chartLoading}>Loading burndown…</div>;
    if (!data) return <div className={s.chartEmpty}>Burndown unavailable</div>;
    if (!chart) return null;
    if ((data.snapshots?.length || 0) === 0 && data.startScope === 0) {
        return (
            <div className={s.chartEmpty}>
                No data yet — add story points & start the sprint to see a
                burndown.
            </div>
        );
    }

    return (
        <div className={s.chartWrap}>
            <div className={s.chartHeader}>
                <span>
                    <LineIcon size={13} /> Burndown
                </span>
                <span className={s.chartLegend}>
                    <span className={s.legIdeal}></span> Ideal
                    <span className={s.legActual}></span> Actual
                </span>
            </div>
            <svg
                viewBox={`0 0 ${chart.w} ${chart.h}`}
                className={s.chartSvg}
                role="img"
                aria-label="Burndown chart"
            >
                {/* y-axis grid + labels */}
                {chart.yLabels.map((t, i) => (
                    <g key={i}>
                        <line
                            x1={chart.padL}
                            y1={t.y}
                            x2={chart.w - chart.padR}
                            y2={t.y}
                            className={s.gridLine}
                        />
                        <text
                            x={chart.padL - 6}
                            y={t.y + 3}
                            textAnchor="end"
                            className={s.axisLabel}
                        >
                            {t.value}
                        </text>
                    </g>
                ))}
                {/* x-axis */}
                <line
                    x1={chart.padL}
                    y1={chart.h - chart.padB}
                    x2={chart.w - chart.padR}
                    y2={chart.h - chart.padB}
                    className={s.axisLine}
                />
                <text
                    x={chart.padL}
                    y={chart.h - 6}
                    className={s.axisLabel}
                >
                    {data.sprint.start_date}
                </text>
                <text
                    x={chart.w - chart.padR}
                    y={chart.h - 6}
                    textAnchor="end"
                    className={s.axisLabel}
                >
                    {data.sprint.end_date}
                </text>

                {/* Ideal line */}
                <path
                    d={chart.path(chart.idealPoints)}
                    className={s.idealLine}
                    fill="none"
                />
                {/* Actual line */}
                <path
                    d={chart.path(chart.actualPoints)}
                    className={s.actualLine}
                    fill="none"
                />
                {chart.actualPoints.map((p: any, i: number) => (
                    <g key={i}>
                        <circle cx={p.x} cy={p.y} r={3} className={s.actualDot} />
                        <title>
                            {p.date}: {p.value} {unitLabel} remaining
                        </title>
                    </g>
                ))}
            </svg>
        </div>
    );
}

// ────────────────────────────────────────────────────────────────────────────
// VelocityChart — simple bar chart of last N completed sprints
// ────────────────────────────────────────────────────────────────────────────
interface VelocityChartProps {
    limit?: number;
    height?: number;
}

export function VelocityChart({ limit = 6, height = 180 }: VelocityChartProps) {
    const { unitLabel } = useAgileConfig();
    const [data, setData] = useState<any>(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        setLoading(true);
        getRecentVelocity(limit)
            .then((r) => setData(r.data))
            .catch(() => setData(null))
            .finally(() => setLoading(false));
    }, [limit]);

    if (loading) return <div className={s.chartLoading}>Loading velocity…</div>;
    if (!data || !data.sprints?.length) {
        return (
            <div className={s.chartEmpty}>
                No completed sprints yet — velocity will appear after the first
                sprint completes.
            </div>
        );
    }

    const padL = 36,
        padR = 12,
        padT = 12,
        padB = 36;
    const w = 600,
        h = height;
    const innerW = w - padL - padR;
    const innerH = h - padT - padB;
    const maxVal =
        Math.max(
            data.average,
            ...data.sprints.map((sp: any) => Number(sp.velocity_points) || 0),
        ) || 1;
    const barW = Math.max(8, innerW / data.sprints.length - 14);

    return (
        <div className={s.chartWrap}>
            <div className={s.chartHeader}>
                <span>
                    <BarChart3 size={13} /> Velocity
                </span>
                <span className={s.chartLegend}>
                    Avg: <strong>{data.average}</strong> {unitLabel}
                </span>
            </div>
            <svg
                viewBox={`0 0 ${w} ${h}`}
                className={s.chartSvg}
                role="img"
                aria-label="Velocity chart"
            >
                {/* Average line */}
                {data.average > 0 && (
                    <line
                        x1={padL}
                        x2={w - padR}
                        y1={padT + innerH - (innerH * data.average) / maxVal}
                        y2={padT + innerH - (innerH * data.average) / maxVal}
                        className={s.avgLine}
                    />
                )}
                {data.sprints.map((sp: any, i: number) => {
                    const cx =
                        padL +
                        (innerW / data.sprints.length) * i +
                        innerW / data.sprints.length / 2;
                    const v = Number(sp.velocity_points) || 0;
                    const bh = (innerH * v) / maxVal;
                    const x = cx - barW / 2;
                    const y = padT + innerH - bh;
                    return (
                        <g key={sp.id}>
                            <rect
                                x={x}
                                y={y}
                                width={barW}
                                height={bh}
                                className={s.bar}
                                rx={3}
                            >
                                <title>
                                    {sp.name}: {v} {unitLabel}
                                </title>
                            </rect>
                            <text
                                x={cx}
                                y={y - 4}
                                textAnchor="middle"
                                className={s.barLabel}
                            >
                                {v}
                            </text>
                            <text
                                x={cx}
                                y={h - 18}
                                textAnchor="middle"
                                className={s.barAxis}
                            >
                                {sp.name.replace("Sprint ", "S")}
                            </text>
                            {sp.completed_at && (
                                <text
                                    x={cx}
                                    y={h - 6}
                                    textAnchor="middle"
                                    className={s.barSubAxis}
                                >
                                    {new Date(
                                        sp.completed_at,
                                    ).toLocaleDateString()}
                                </text>
                            )}
                        </g>
                    );
                })}
            </svg>
        </div>
    );
}

// ────────────────────────────────────────────────────────────────────────────
// SprintLifecycleControls — Start / Complete with rollover target picker
// ────────────────────────────────────────────────────────────────────────────
interface SprintLifecycleControlsProps {
    sprint: SprintLike;
    canEdit?: boolean;
    onChanged?: (sprint: any, extra?: any) => void;
}

export function SprintLifecycleControls({
    sprint,
    canEdit = true,
    onChanged,
}: SprintLifecycleControlsProps) {
    const [busy, setBusy] = useState(false);
    const [completing, setCompleting] = useState(false);
    const [available, setAvailable] = useState<any[]>([]);
    const [rolloverTo, setRolloverTo] = useState("backlog");
    const [error, setError] = useState("");

    useEffect(() => {
        if (!completing) return;
        getSprints().then((r) => {
            const list = (r.data?.sprints || []).filter(
                (sp: any) =>
                    sp.id !== sprint.id && sp.status !== "completed",
            );
            setAvailable(list);
        });
    }, [completing, sprint?.id]);

    const start = async () => {
        if (!canEdit || busy) return;
        setBusy(true);
        setError("");
        try {
            const r = await startSprint(sprint.id);
            onChanged && onChanged(r.data?.sprint);
        } catch (e) {
            const err = e as { response?: { data?: { error?: string } } };
            setError(err?.response?.data?.error || "Failed to start sprint");
        } finally {
            setBusy(false);
        }
    };

    const complete = async () => {
        if (!canEdit || busy) return;
        setBusy(true);
        setError("");
        try {
            const r = await completeSprint(sprint.id, rolloverTo);
            setCompleting(false);
            onChanged && onChanged(r.data?.sprint, r.data);
        } catch (e) {
            const err = e as { response?: { data?: { error?: string } } };
            setError(err?.response?.data?.error || "Failed to complete sprint");
        } finally {
            setBusy(false);
        }
    };

    if (!sprint) return null;

    return (
        <div className={s.lifecycleWrap}>
            {sprint.status === "planned" && (
                <button
                    className="btn btn-primary btn-sm"
                    onClick={start}
                    disabled={!canEdit || busy}
                    title="Start this sprint and set it as active"
                >
                    <PlayCircle size={13} /> Start Sprint
                </button>
            )}
            {sprint.status === "active" && !completing && (
                <button
                    className="btn btn-primary btn-sm"
                    onClick={() => setCompleting(true)}
                    disabled={!canEdit || busy}
                >
                    <CheckCircle size={13} /> Complete Sprint
                </button>
            )}
            {sprint.status === "active" && completing && (
                <div className={s.lifecycleForm}>
                    <label className={s.lifecycleLabel}>
                        Roll over incomplete tickets to:
                    </label>
                    <select
                        value={rolloverTo}
                        onChange={(e) => setRolloverTo(e.target.value)}
                        className={s.lifecycleSelect}
                    >
                        <option value="backlog">Backlog</option>
                        {available.map((sp) => (
                            <option key={sp.id} value={sp.id}>
                                {sp.name} ({sp.status})
                            </option>
                        ))}
                    </select>
                    <button
                        className="btn btn-primary btn-sm"
                        onClick={complete}
                        disabled={busy}
                    >
                        Complete
                    </button>
                    <button
                        className="btn btn-secondary btn-sm"
                        onClick={() => setCompleting(false)}
                        disabled={busy}
                    >
                        Cancel
                    </button>
                </div>
            )}
            {sprint.status === "completed" && (
                <span className={s.completedBadge}>
                    <CheckCircle size={13} /> Completed
                    {sprint.velocity_points != null && (
                        <span className={s.velocityChip}>
                            velocity {Number(sprint.velocity_points)}
                        </span>
                    )}
                </span>
            )}
            {error && <span className={s.lifecycleError}>{error}</span>}
        </div>
    );
}

// ────────────────────────────────────────────────────────────────────────────
// ParentChildPanel — Epic ↔ children relationship
// ────────────────────────────────────────────────────────────────────────────
interface ParentChildPanelProps {
    task: TaskLike;
    canEdit?: boolean;
    onOpenTask?: (taskId: number | string) => void;
    onChanged?: () => void;
}

export function ParentChildPanel({
    task,
    canEdit = true,
    onOpenTask,
    onChanged,
}: ParentChildPanelProps) {
    const { features, typeById } = useAgileConfig();
    const [children, setChildren] = useState<any[]>([]);
    const [rollup, setRollup] = useState<any>(null);
    const [parent, setParent] = useState<any>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");
    const [picking, setPicking] = useState(false);
    const [search, setSearch] = useState("");
    const [results, setResults] = useState<any[]>([]);
    const [searching, setSearching] = useState(false);

    const isEpic = !!(
        task?.work_item_type_id &&
        typeById[task.work_item_type_id]?.is_epic
    );

    const reload = useCallback(async () => {
        if (!task?.id) return;
        setLoading(true);
        try {
            if (isEpic) {
                const r = await getTaskChildren(task.id);
                setChildren(r.data?.children || []);
                setRollup(r.data?.rollup || null);
                setParent(null);
            } else {
                const r = await getTaskParent(task.id);
                setParent(r.data?.parent || null);
                setChildren([]);
                setRollup(null);
            }
        } catch {
            setChildren([]);
            setRollup(null);
            setParent(null);
        } finally {
            setLoading(false);
        }
    }, [task?.id, isEpic]);

    useEffect(() => {
        reload();
    }, [reload]);

    // Debounced quicksearch for the parent picker (non-epics only).
    useEffect(() => {
        if (!picking) return;
        if (!search.trim()) {
            setResults([]);
            return;
        }
        const handle = setTimeout(async () => {
            setSearching(true);
            try {
                const r = await quicksearchTasks(search.trim());
                const epicTypeIds = new Set(
                    Object.values(typeById)
                        .filter((t: any) => t.is_epic)
                        .map((t: any) => t.id),
                );
                const all = (r.data?.tasks || []).filter(
                    (t: any) => t.id !== task?.id,
                );
                // Sort epics to the top, then everything else alphabetically by id.
                all.sort((a: any, b: any) => {
                    const ae = epicTypeIds.has(a.work_item_type_id) ? 0 : 1;
                    const be = epicTypeIds.has(b.work_item_type_id) ? 0 : 1;
                    if (ae !== be) return ae - be;
                    return b.id - a.id;
                });
                setResults(all);
            } catch {
                setResults([]);
            } finally {
                setSearching(false);
            }
        }, 200);
        return () => clearTimeout(handle);
    }, [search, picking, task?.id, typeById]);

    const openTask = (id: number | string) => {
        if (onOpenTask) onOpenTask(id);
        else window.location.href = `/tasks?task=${id}`;
    };

    const setParentTask = async (parentId: number | string | null) => {
        try {
            await setTaskParent(task.id, parentId);
            setPicking(false);
            setSearch("");
            setResults([]);
            await reload();
            onChanged && onChanged();
        } catch (e) {
            const err = e as { response?: { data?: { error?: string } } };
            setError(err?.response?.data?.error || "Failed to set parent");
        }
    };

    if (!features.epics) return null;
    if (loading) return <div className={s.depLoading}>Loading…</div>;

    if (isEpic) {
        // ── Epic view: list of children + rollup ─────────────────────────
        return (
            <div className={s.depWrap}>
                <div className={s.depHeader}>
                    <div className={s.depTitle}>
                        <LinkIcon size={13} /> Child tickets
                        {rollup && rollup.totalChildren > 0 && (
                            <span className={s.depRollup}>
                                {rollup.doneChildren}/{rollup.totalChildren} done
                                {rollup.totalPoints > 0 && (
                                    <>
                                        {" "}
                                        · {rollup.donePoints}/{rollup.totalPoints}{" "}
                                        pts ({rollup.percentByPoints}%)
                                    </>
                                )}
                            </span>
                        )}
                    </div>
                </div>
                {children.length === 0 ? (
                    <div className={s.depEmpty}>
                        No child tickets yet. Open any ticket → Edit → set this
                        Epic as its <em>Parent</em>.
                    </div>
                ) : (
                    <ul className={s.depList}>
                        {children.map((c) => (
                            <li
                                key={c.id}
                                className={`${s.depItem} ${c.is_blocked ? s.itemBlocked : ""}`}
                            >
                                {c.type_name && (
                                    <span
                                        className={s.depBadge}
                                        style={{
                                            color: c.type_color || undefined,
                                            background: c.type_color
                                                ? `color-mix(in srgb, ${c.type_color} 12%, transparent)`
                                                : undefined,
                                        }}
                                    >
                                        {c.type_name}
                                    </span>
                                )}
                                <span className={s.depItemId}>#{c.id}</span>
                                <a
                                    href={`/tasks?task=${c.id}`}
                                    onClick={(e) => {
                                        e.preventDefault();
                                        openTask(c.id);
                                    }}
                                    className={s.depItemLink}
                                >
                                    {c.title}
                                </a>
                                {c.state_name && (
                                    <span
                                        className={s.depStatePill}
                                        style={
                                            {
                                                "--state-color":
                                                    c.state_color || "#6b7280",
                                            } as React.CSSProperties
                                        }
                                    >
                                        {c.state_name}
                                    </span>
                                )}
                                {c.story_points != null &&
                                    c.story_points !== "" && (
                                        <span
                                            className={s.depPoints}
                                            title="Story points"
                                        >
                                            {Number(c.story_points)}
                                        </span>
                                    )}
                            </li>
                        ))}
                    </ul>
                )}
                {error && <div className={s.depError}>{error}</div>}
            </div>
        );
    }

    // ── Non-epic view: compact inline parent link + picker ─────────────────
    const epicTypeIds = new Set(
        Object.values(typeById)
            .filter((t: any) => t.is_epic)
            .map((t: any) => t.id),
    );
    return (
        <div className={s.parentInline}>
            {parent ? (
                <span className={s.parentChip}>
                    <LinkIcon size={11} className={s.parentChipIcon} />
                    <span className={s.parentChipLead}>Part of</span>
                    <a
                        href={`/tasks?task=${parent.id}`}
                        onClick={(e) => {
                            e.preventDefault();
                            openTask(parent.id);
                        }}
                        className={s.parentChipLink}
                        title={parent.title}
                    >
                        #{parent.id} {parent.title}
                    </a>
                    {canEdit && (
                        <button
                            className={s.parentChipDetach}
                            onClick={() => setParentTask(null)}
                            title="Detach from parent"
                        >
                            <X size={11} />
                        </button>
                    )}
                </span>
            ) : (
                canEdit &&
                !picking && (
                    <button
                        className={s.parentLinkBtn}
                        onClick={() => setPicking(true)}
                    >
                        <LinkIcon size={11} /> Link to parent…
                    </button>
                )
            )}
            {parent && canEdit && !picking && (
                <button
                    className={s.parentLinkBtn}
                    onClick={() => setPicking(true)}
                >
                    Change parent
                </button>
            )}

            {picking && canEdit && (
                <div
                    className={s.depAddBox}
                    style={{ marginTop: 6, width: "100%" }}
                >
                    <div className={s.depAddRow}>
                        <div className={s.depSearchWrap} style={{ flex: 1 }}>
                            <Search size={12} className={s.depSearchIcon} />
                            <input
                                autoFocus
                                value={search}
                                onChange={(e) => setSearch(e.target.value)}
                                placeholder="Search by ID or title (Epics shown first)…"
                                className={s.depSearchInput}
                            />
                        </div>
                        <button
                            className="btn btn-secondary btn-sm"
                            onClick={() => {
                                setPicking(false);
                                setSearch("");
                                setResults([]);
                            }}
                        >
                            Cancel
                        </button>
                    </div>
                    {searching && <div className={s.depHint}>Searching…</div>}
                    {!searching && search.trim() && results.length === 0 && (
                        <div className={s.depHint}>No matching tasks</div>
                    )}
                    {results.length > 0 && (
                        <ul className={s.depResults}>
                            {results.map((r) => {
                                const isEpicType = epicTypeIds.has(
                                    r.work_item_type_id,
                                );
                                return (
                                    <li
                                        key={r.id}
                                        onClick={() => setParentTask(r.id)}
                                    >
                                        {isEpicType && (
                                            <span className={s.depResultEpic}>
                                                Epic
                                            </span>
                                        )}
                                        <span className={s.depResultId}>
                                            #{r.id}
                                        </span>{" "}
                                        {r.title}
                                    </li>
                                );
                            })}
                        </ul>
                    )}
                </div>
            )}

            {error && <div className={s.depError}>{error}</div>}
        </div>
    );
}
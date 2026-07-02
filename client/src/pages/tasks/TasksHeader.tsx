import React from "react";
import { PRIORITIES, COLUMNS } from "./constants";
import { formatDate } from "./utils";
import { getLocalToday } from "../../api";
import { useTaskCtx } from "./TaskContext";
import { useFeatures } from "../../FeaturesContext";
import { CalendarDays, Package, Search, Headset, BarChart3 } from "lucide-react";
import { Link } from "react-router-dom";
import s from "./TasksHeader.module.css";

interface TasksHeaderProps {
    activeTab: string;
    setActiveTab: (tab: string) => void;
    date?: string;
    setDate?: (d: string) => void;
    isToday?: boolean;
    selectedSprintId: number | null;
    setSelectedSprintId: (id: number | null) => void;
    backlogTasks: any[];
    filterCount: number;
    filtersOpen: boolean;
    setFiltersOpen: (value: boolean | ((o: boolean) => boolean)) => void;
    filterAssignee: string;
    setFilterAssignee: (v: string) => void;
    filterLabel: string;
    setFilterLabel: (v: string) => void;
    filterPriority: string;
    setFilterPriority: (v: string) => void;
    filterStatus: string;
    setFilterStatus: (v: string) => void;
    filterSearch?: string;
    setFilterSearch?: (v: string) => void;
    globalSearch: string;
    globalResults: any[];
    globalSearching: boolean;
    globalSearchOpen: boolean;
    globalSearchRef: React.RefObject<HTMLDivElement>;
    onGlobalSearch: (v: string) => void;
    setGlobalSearchOpen: (v: boolean) => void;
    onOpenDetail: (task: any) => void;
    setBacklogFormOpen: (value: boolean | ((o: boolean) => boolean)) => void;
    setSprintImportOpen: (value: boolean | ((o: boolean) => boolean)) => void;
    fetchBacklog: () => void;
    clearFilters: () => void;
}

export default function TasksHeader({
    activeTab,
    setActiveTab,
    date,
    setDate,
    isToday,
    selectedSprintId,
    setSelectedSprintId,
    backlogTasks,
    filterCount,
    filtersOpen,
    setFiltersOpen,
    filterAssignee,
    setFilterAssignee,
    filterLabel,
    setFilterLabel,
    filterPriority,
    setFilterPriority,
    filterStatus,
    setFilterStatus,
    filterSearch,
    setFilterSearch,
    globalSearch,
    globalResults,
    globalSearching,
    globalSearchOpen,
    globalSearchRef,
    onGlobalSearch,
    setGlobalSearchOpen,
    onOpenDetail,
    setBacklogFormOpen,
    setSprintImportOpen,
    fetchBacklog,
    clearFilters,
}: TasksHeaderProps) {
    const { assignableUsers, orgLabels, availableSprints, currentUser } =
        useTaskCtx() as any;
    const { hasFeature } = useFeatures() as any;
    const currentSprint = availableSprints.find(
        (sp: any) => sp.id === selectedSprintId,
    );
    const teamName = currentUser?.team_name || "Team";
    const daysLeft = currentSprint
        ? Math.max(
              0,
              Math.ceil(
                  ((Date.UTC as any)(
                      ...currentSprint.end_date
                          .split("-")
                          .map((v: string, i: number) => (i === 1 ? +v - 1 : +v)),
                  ) -
                      (Date.UTC as any)(
                          ...getLocalToday()
                              .split("-")
                              .map((v: string, i: number) => (i === 1 ? +v - 1 : +v)),
                      )) /
                      86400000,
              ),
          )
        : 0;

    return (
        <>
            {/* Page header */}
            <div className={s["tasks-header"]}>
                <div>
                    {activeTab === "sprint" ? (
                        <>
                            <h2>
                                <span className="page-icon">🏃</span> {teamName} —{" "}
                                {currentSprint ? currentSprint.name : "Sprint"}
                                {currentSprint?.status === "active" && (
                                    <span className={s["sprint-status-pill"]} data-status="active">
                                        Active
                                    </span>
                                )}
                                {currentSprint?.status === "paused" && (
                                    <span className={s["sprint-status-pill"]} data-status="paused">
                                        Paused
                                    </span>
                                )}
                            </h2>
                            <p>
                                {currentSprint
                                    ? currentSprint.status === "paused"
                                        ? `${currentSprint.start_date} → ${currentSprint.end_date} • Paused`
                                        : `${currentSprint.start_date} → ${currentSprint.end_date} • ${daysLeft}d remaining`
                                    : "Loading sprint…"}
                            </p>
                        </>
                    ) : (
                        <>
                            <h2>
                                <span className="page-icon">
                                    {activeTab === "service-desk" ? (
                                        <Headset size={18} style={{ verticalAlign: "middle" }} />
                                    ) : (
                                        <Package size={18} style={{ verticalAlign: "middle" }} />
                                    )}
                                </span>{" "}
                                {activeTab === "service-desk" ? "Service Desk" : "Backlog"}
                            </h2>
                            <p>
                                {activeTab === "service-desk"
                                    ? "Report bugs, request features, or raise access issues"
                                    : "Unscheduled items waiting to be planned"}
                            </p>
                        </>
                    )}
                </div>

                <div className={s["tasks-header-actions"]}>
                    {/* Tab switcher */}
                    <div className={s["tab-switcher"]}>
                        {/* Sprint tab is part of the Agile feature bundle — explicitly
                            gated on hasFeature("agile") instead of relying on the
                            sprint list happening to be empty when the feature is off. */}
                        {hasFeature("agile") && availableSprints.length > 0 && (
                            <button
                                className={`${s["tab-btn"]} ${activeTab === "sprint" ? s["tab-active"] : ""}`}
                                onClick={() => {
                                    setActiveTab("sprint");
                                    if (!selectedSprintId) {
                                        const active = availableSprints.find(
                                            (sp: any) => sp.status === "active",
                                        );
                                        setSelectedSprintId(
                                            active ? active.id : (availableSprints[0]?.id ?? null),
                                        );
                                    }
                                }}
                            >
                                Sprint
                            </button>
                        )}
                        <button
                            className={`${s["tab-btn"]} ${activeTab === "backlog" ? s["tab-active"] : ""}`}
                            onClick={() => setActiveTab("backlog")}
                        >
                            <Package
                                size={14}
                                style={{ verticalAlign: "middle", marginRight: 4 }}
                            />
                            Backlog{" "}
                            {backlogTasks.length > 0 && (
                                <span className={s["tab-badge"]}>{backlogTasks.length}</span>
                            )}
                        </button>
                        <button
                            className={`${s["tab-btn"]} ${activeTab === "service-desk" ? s["tab-active"] : ""}`}
                            onClick={() => setActiveTab("service-desk")}
                        >
                            <Headset
                                size={14}
                                style={{ verticalAlign: "middle", marginRight: 4 }}
                            />
                            Service Desk
                        </button>
                    </div>

                    {/* Sprint Insights stays visible to all team members so anyone can
              read burndown / velocity / retro charts. The Agile Config editor
              is intentionally NOT linked from here — it lives only inside
              Admin → Structure → Agile Config so it doesn't leak through to
              team members from the tasks page. */}
                    {hasFeature("agile") && (
                        <Link
                            to="/sprint-insights"
                            className={`btn btn-secondary btn-sm ${s["add-task-toggle"]}`}
                            title="Sprint insights — burndown, velocity, cumulative flow, cycle time and retrospectives"
                            style={{ textDecoration: "none" }}
                        >
                            <BarChart3
                                size={14}
                                style={{ verticalAlign: "middle", marginRight: 4 }}
                            />
                            Insights
                        </Link>
                    )}

                    {/* Sprint select (when multiple sprints) */}
                    {hasFeature("agile") && activeTab === "sprint" && availableSprints.length > 1 && (
                        <select
                            value={selectedSprintId || ""}
                            onChange={(e) => setSelectedSprintId(Number(e.target.value))}
                            className={s["date-input"]}
                        >
                            {availableSprints.map((sp: any) => (
                                <option key={sp.id} value={sp.id}>
                                    {sp.name} {sp.status === "active" ? "(Active)" : ""}
                                </option>
                            ))}
                        </select>
                    )}

                    {activeTab !== "service-desk" && (
                        <button
                            className={`btn btn-secondary ${s["filter-toggle-btn"]} ${filterCount > 0 ? s["has-filters"] : ""}`}
                            onClick={() => setFiltersOpen((o) => !o)}
                        >
                            <Search
                                size={14}
                                style={{ verticalAlign: "middle", marginRight: 4 }}
                            />
                            {filterCount > 0 ? `Filters (${filterCount})` : "Filters"}
                        </button>
                    )}

                    {activeTab === "backlog" && (
                        <button
                            className={`btn btn-secondary ${s["add-task-toggle"]}`}
                            onClick={() => setBacklogFormOpen((o) => !o)}
                        >
                            ➕ New Ticket
                        </button>
                    )}

                    {hasFeature("agile") && activeTab === "sprint" && selectedSprintId && (
                        <button
                            className={`btn btn-secondary ${s["add-task-toggle"]} ${s[""]}`}
                            onClick={() => {
                                setSprintImportOpen((o) => !o);
                                if (!backlogTasks.length) fetchBacklog();
                            }}
                        >
                            <Package
                                size={14}
                                style={{ verticalAlign: "middle", marginRight: 4 }}
                            />
                            Import from Backlog
                        </button>
                    )}
                </div>
            </div>

            {/* Global Search */}
            {activeTab !== "service-desk" && (
                <div className={s["global-search-wrapper"]} ref={globalSearchRef}>
                    <div className={s["global-search-input-row"]}>
                        <span className={s["global-search-icon"]}>
                            <Search size={15} />
                        </span>
                        <input
                            type="text"
                            value={globalSearch}
                            onChange={(e) => onGlobalSearch(e.target.value)}
                            onFocus={() => {
                                if (globalResults.length > 0 || globalSearch.trim().length >= 2)
                                    setGlobalSearchOpen(true);
                            }}
                            placeholder="Search all tasks..."
                            className={s["global-search-input"]}
                        />
                        {globalSearch && (
                            <button
                                className={s["global-search-clear"]}
                                onClick={() => {
                                    onGlobalSearch("");
                                    setGlobalSearchOpen(false);
                                }}
                            >
                                ✕
                            </button>
                        )}
                    </div>
                    {globalSearchOpen && (
                        <div className={s["global-search-results"]}>
                            {globalSearching ? (
                                <div className={s["global-search-status"]}>Searching...</div>
                            ) : globalResults.length === 0 ? (
                                <div className={s["global-search-status"]}>No results found</div>
                            ) : (
                                globalResults.map((task: any) => {
                                    const pri =
                                        PRIORITIES.find((pr) => pr.value === task.priority) ||
                                        PRIORITIES[1];
                                    const colInfo =
                                        COLUMNS.find((c) => c.id === task.status) || COLUMNS[0];
                                    return (
                                        <div
                                            key={task.id}
                                            className={s["global-search-item"]}
                                            onClick={() => {
                                                onOpenDetail(task);
                                                setGlobalSearchOpen(false);
                                            }}
                                        >
                                            <div className={s["global-search-item-top"]}>
                                                <span className={s["backlog-ticket-id"]}>
                                                    #{task.id}
                                                </span>
                                                <span className={s["global-search-item-title"]}>
                                                    {task.title}
                                                </span>
                                            </div>
                                            <div className={s["global-search-item-meta"]}>
                                                <span
                                                    className={s["backlog-status-badge"]}
                                                    style={
                                                        {
                                                            "--badge-bg": colInfo.color + "20",
                                                            "--badge-color": colInfo.color,
                                                        } as React.CSSProperties
                                                    }
                                                >
                                                    {colInfo.icon} {colInfo.label}
                                                </span>
                                                <span
                                                    className={s["task-priority-badge"]}
                                                    style={
                                                        {
                                                            "--badge-bg": pri.color + "20",
                                                            "--badge-color": pri.color,
                                                        } as React.CSSProperties
                                                    }
                                                >
                                                    {pri.icon} {pri.label}
                                                </span>
                                                {task.date ? (
                                                    <span className={s["global-search-date"]}>
                                                        <CalendarDays
                                                            size={11}
                                                            style={{
                                                                marginRight: 3,
                                                                verticalAlign: "middle",
                                                            }}
                                                        />
                                                        {task.date}
                                                    </span>
                                                ) : (
                                                    <span className={s["global-search-date"]}>
                                                        <Package
                                                            size={11}
                                                            style={{
                                                                marginRight: 3,
                                                                verticalAlign: "middle",
                                                            }}
                                                        />
                                                        Backlog
                                                    </span>
                                                )}
                                                {task.labels &&
                                                    task.labels.map((l: any) => (
                                                        <span
                                                            key={l.id}
                                                            className={s["label-pill"]}
                                                            style={
                                                                {
                                                                    "--label-color": l.color,
                                                                } as React.CSSProperties
                                                            }
                                                        >
                                                            {l.name}
                                                        </span>
                                                    ))}
                                            </div>
                                        </div>
                                    );
                                })
                            )}
                        </div>
                    )}
                </div>
            )}

            {/* Filter Bar */}
            {filtersOpen && activeTab !== "service-desk" && (
                <div className={s["filter-bar"]}>
                    <div className={s["filter-row"]}>
                        <div className={s["filter-group"]}>
                            <label>Assignee</label>
                            <select
                                value={filterAssignee}
                                onChange={(e) => setFilterAssignee(e.target.value)}
                                className={s["filter-select"]}
                            >
                                <option value="">All</option>
                                <option value="me">My Tasks</option>
                                {assignableUsers.map((u: any) => (
                                    <option key={u.id} value={u.id}>
                                        {u.full_name || u.username}
                                    </option>
                                ))}
                            </select>
                        </div>
                        <div className={s["filter-group"]}>
                            <label>Label</label>
                            <select
                                value={filterLabel}
                                onChange={(e) => setFilterLabel(e.target.value)}
                                className={s["filter-select"]}
                            >
                                <option value="">All</option>
                                {orgLabels.map((l: any) => (
                                    <option key={l.id} value={l.id}>
                                        {l.name}
                                    </option>
                                ))}
                            </select>
                        </div>
                        <div className={s["filter-group"]}>
                            <label>Priority</label>
                            <select
                                value={filterPriority}
                                onChange={(e) => setFilterPriority(e.target.value)}
                                className={s["filter-select"]}
                            >
                                <option value="">All</option>
                                {PRIORITIES.map((p) => (
                                    <option key={p.value} value={p.value}>
                                        {p.icon} {p.label}
                                    </option>
                                ))}
                            </select>
                        </div>
                        {activeTab === "sprint" && (
                            <div className={s["filter-group"]}>
                                <label>Status</label>
                                <select
                                    value={filterStatus}
                                    onChange={(e) => setFilterStatus(e.target.value)}
                                    className={s["filter-select"]}
                                >
                                    <option value="">All</option>
                                    {COLUMNS.map((c) => (
                                        <option key={c.id} value={c.id}>
                                            {c.icon} {c.label}
                                        </option>
                                    ))}
                                </select>
                            </div>
                        )}
                        {filterCount > 0 && (
                            <button
                                className={`btn btn-secondary btn-sm ${s["clear-filters-btn"]}`}
                                onClick={clearFilters}
                            >
                                ✕ Clear
                            </button>
                        )}
                    </div>
                </div>
            )}
        </>
    );
}
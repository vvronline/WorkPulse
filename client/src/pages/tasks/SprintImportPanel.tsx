import React from "react";
import { PRIORITIES, type PriorityOption } from "./constants";
import { User, CalendarDays, Check, X, Package } from "lucide-react";
import s from "./SprintImportPanel.module.css";

function getPriority(p: string | undefined): PriorityOption {
    return PRIORITIES.find((pr) => pr.value === p) || PRIORITIES[1];
}

interface SprintImportPanelProps {
    backlogTasks: any[];
    backlogLoading: boolean;
    selectedSprintId: number | null;
    availableSprints: any[];
    assignableUsers: any[];
    importConfigTask: any;
    importAssignedTo: string;
    importDueDate: string;
    onSetImportConfigTask: (task: any) => void;
    onSetImportAssignedTo: (v: string) => void;
    onSetImportDueDate: (v: string) => void;
    onImportToSprint: () => void;
    onClose: () => void;
}

/**
 * The collapsible "Import from Backlog" panel shown above the sprint kanban board.
 */
export default function SprintImportPanel({
    backlogTasks,
    backlogLoading,
    selectedSprintId,
    availableSprints,
    assignableUsers,
    importConfigTask,
    importAssignedTo,
    importDueDate,
    onSetImportConfigTask,
    onSetImportAssignedTo,
    onSetImportDueDate,
    onImportToSprint,
    onClose,
}: SprintImportPanelProps) {
    return (
        <div className={s["sprint-import-panel"]}>
            <div className={s["sprint-import-header"]}>
                <span>
                    <Package
                        size={14}
                        style={{ marginRight: 4, verticalAlign: "middle" }}
                    />
                    Import tickets from Backlog into this sprint
                </span>
                <button className={s["close-form-btn"]} onClick={onClose}>
                    <X size={14} />
                </button>
            </div>

            {backlogLoading ? (
                <div className="loading-spinner">
                    <div className="spinner" />
                </div>
            ) : (
                (() => {
                    const importable = backlogTasks.filter(
                        (t) => t.sprint_id !== selectedSprintId && t.status !== "done",
                    );

                    if (importable.length === 0) {
                        return (
                            <p className={s["sprint-import-empty"]}>
                                No backlog tickets available to import.
                            </p>
                        );
                    }

                    return (
                        <div className={s["sprint-import-list"]}>
                            {importable.map((task) => {
                                const pri = getPriority(task.priority);
                                const configuring = importConfigTask?.id === task.id;
                                return (
                                    <div
                                        key={task.id}
                                        className={`${s["sprint-import-item"]} ${configuring ? s["sprint-import-item-active"] : ""}`}
                                    >
                                        <div className={s["sprint-import-item-top"]}>
                                            <span className={s["backlog-ticket-id"]}>
                                                #{task.id}
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
                                            <span className={s["sprint-import-title"]}>
                                                {task.title}
                                            </span>
                                            {!configuring && (
                                                <button
                                                    className="btn btn-primary btn-sm"
                                                    onClick={() => {
                                                        onSetImportConfigTask(task);
                                                        onSetImportAssignedTo(
                                                            task.assigned_to
                                                                ? String(task.assigned_to)
                                                                : "",
                                                        );
                                                        const sprint = availableSprints.find(
                                                            (sp) => sp.id === selectedSprintId,
                                                        );
                                                        onSetImportDueDate(
                                                            sprint?.end_date || task.due_date || "",
                                                        );
                                                    }}
                                                >
                                                    Import
                                                </button>
                                            )}
                                        </div>

                                        {configuring && (
                                            <div className={s["sprint-import-config"]}>
                                                <div className={s["sprint-import-config-row"]}>
                                                    <label>
                                                        <User
                                                            size={13}
                                                            style={{
                                                                marginRight: 4,
                                                                verticalAlign: "middle",
                                                            }}
                                                        />
                                                        Assign to
                                                    </label>
                                                    <select
                                                        value={importAssignedTo}
                                                        onChange={(e) =>
                                                            onSetImportAssignedTo(e.target.value)
                                                        }
                                                        className={s["sprint-import-select"]}
                                                    >
                                                        <option value="">Unassigned</option>
                                                        {assignableUsers.map((u) => (
                                                            <option key={u.id} value={u.id}>
                                                                {u.full_name || u.username}
                                                            </option>
                                                        ))}
                                                    </select>
                                                    <label>
                                                        <CalendarDays
                                                            size={13}
                                                            style={{
                                                                marginRight: 4,
                                                                verticalAlign: "middle",
                                                            }}
                                                        />
                                                        Due date
                                                    </label>
                                                    <input
                                                        type="date"
                                                        value={importDueDate}
                                                        onChange={(e) =>
                                                            onSetImportDueDate(e.target.value)
                                                        }
                                                        className={s["date-input"]}
                                                    />
                                                </div>
                                                <div className={s["sprint-import-config-actions"]}>
                                                    <button
                                                        className="btn btn-primary btn-sm"
                                                        onClick={onImportToSprint}
                                                    >
                                                        <Check
                                                            size={14}
                                                            style={{
                                                                marginRight: 4,
                                                                verticalAlign: "middle",
                                                            }}
                                                        />
                                                        Confirm Import
                                                    </button>
                                                    <button
                                                        className="btn btn-secondary btn-sm"
                                                        onClick={() => {
                                                            onSetImportConfigTask(null);
                                                            onSetImportAssignedTo("");
                                                            onSetImportDueDate("");
                                                        }}
                                                    >
                                                        Cancel
                                                    </button>
                                                </div>
                                            </div>
                                        )}
                                    </div>
                                );
                            })}
                        </div>
                    );
                })()
            )}
        </div>
    );
}
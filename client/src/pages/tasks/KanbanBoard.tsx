import React from "react";
import TaskCard from "./TaskCard";
import { useAgileConfig } from "../../AgileConfigContext";
import s from "./KanbanBoard.module.css";

interface KanbanBoardProps {
    tasks: any[];
    dragOverCol: number | string | null;
    sprintMode?: boolean;
    onDragOver: (e: React.DragEvent, colId: number | string, col: any) => void;
    onDragLeave: (e: React.DragEvent) => void;
    onDrop: (e: React.DragEvent, colId: number | string, col: any) => void;
    onDragStart: (e: React.DragEvent, id: number | string) => void;
    onDragEnd: (e: React.DragEvent, id: number | string) => void;
    onOpenDetail: (task: any) => void;
    onOpenComments: (id: number | string) => void;
}

export default function KanbanBoard({
    tasks,
    dragOverCol,
    sprintMode,
    onDragOver,
    onDragLeave,
    onDrop,
    onDragStart,
    onDragEnd,
    onOpenDetail,
    onOpenComments,
}: KanbanBoardProps) {
    const { workflowStates, features } = useAgileConfig() as any;
    // Match a task to a column either by workflow_state_id (preferred) or by the
    // legacy `status` key (back-compat for tasks created pre-migration).
    const getColTasks = (col: any) =>
        tasks.filter(
            (t) =>
                (t.workflow_state_id &&
                    col.id &&
                    t.workflow_state_id === col.id) ||
                (t.status && col.key && t.status === col.key),
        );

    return (
        <div className={s["kanban-board"]}>
            {workflowStates.map((col: any) => {
                const colTasks = getColTasks(col);
                // Drag-over compares against either id or key — useDragDrop passes whichever it has
                const isDragOver =
                    dragOverCol === col.id || dragOverCol === col.key;
                const wipExceeded =
                    features.wipLimits &&
                    col.wip_limit &&
                    colTasks.length > col.wip_limit;

                return (
                    <div
                        key={col.id || col.key}
                        className={`${s["kanban-column"]} ${isDragOver ? s["drag-over"] : ""} ${wipExceeded ? s["wip-exceeded"] : ""}`}
                        style={{ "--col-color": col.color } as React.CSSProperties}
                        onDragOver={(e) => onDragOver(e, col.id || col.key, col)}
                        onDragLeave={onDragLeave}
                        onDrop={(e) => onDrop(e, col.id || col.key, col)}
                    >
                        <div className={s["column-header"]}>
                            <div className={s["column-header-left"]}>
                                <span
                                    className={s["column-dot"]}
                                    style={{ background: col.color }}
                                />
                                <span className={s["column-label"]}>
                                    {sprintMode && col.is_initial ? "New" : col.name}
                                </span>
                            </div>
                            <span className={s["column-count"]}>
                                {colTasks.length}
                                {features.wipLimits && col.wip_limit
                                    ? ` / ${col.wip_limit}`
                                    : ""}
                            </span>
                        </div>

                        {isDragOver && (
                            <div className={s["drop-indicator"]}>Drop here</div>
                        )}

                        <div className={s["column-tasks"]}>
                            {colTasks.length === 0 && !isDragOver && (
                                <div className={s["column-empty"]}>
                                    <span>No items</span>
                                </div>
                            )}
                            {colTasks.map((task) => (
                                <TaskCard
                                    key={task.id}
                                    task={task}
                                    sprintMode={sprintMode}
                                    onOpenDetail={onOpenDetail}
                                    onOpenComments={onOpenComments}
                                    onDragStart={onDragStart}
                                    onDragEnd={onDragEnd}
                                />
                            ))}
                        </div>
                    </div>
                );
            })}
        </div>
    );
}
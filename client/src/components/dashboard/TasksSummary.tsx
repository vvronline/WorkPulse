import React, { memo, useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { ClipboardList } from "lucide-react";
import s from "./TasksSummary.module.css";

interface TaskItem {
    title: string;
    priority: string;
    status?: string;
    [key: string]: unknown;
}

interface TaskSummaryData {
    total: number;
    done: number;
    inProgress: number;
    inReview?: number;
    pending: number;
    nextTask?: TaskItem;
    activeTasks?: TaskItem[];
    [key: string]: unknown;
}

const TasksSummary = memo(function TasksSummary({ taskSummary }: { taskSummary?: TaskSummaryData | null }) {
    const navigate = useNavigate();
    const [slideIndex, setSlideIndex] = useState(0);

    // Setup auto-slide if there are multiple active tasks
    useEffect(() => {
        if (!taskSummary?.activeTasks || taskSummary.activeTasks.length <= 1) return;

        // reset slide index if data changes length
        setSlideIndex((prev) => (prev >= taskSummary.activeTasks!.length ? 0 : prev));

        const interval = setInterval(() => {
            setSlideIndex((prev) => (prev + 1) % taskSummary.activeTasks!.length);
        }, 4000); // Slide every 4 seconds

        return () => clearInterval(interval);
    }, [taskSummary?.activeTasks?.length]);

    if (!taskSummary || taskSummary.total === 0) return null;

    return (
        <div
            className={`status-card ${s["tasks-summary-card"]} ${s["clickable"]}`}
            onClick={() => navigate("/tasks")}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => e.key === "Enter" && navigate("/tasks")}
        >
            <h3 className={s["timeline-title"]}>
                <span className="page-icon"><ClipboardList size={18} /></span> Today's Planner
                <span className={s["title-arrow"]}>›</span>
            </h3>
            <div className={s["tasks-summary-stats"]}>
                <div className={`${s["task-stat"]} ${s["done-stat"]}`}>
                    <span className={s["task-stat-num"]}>{taskSummary.done}</span>
                    <span className={s["task-stat-label"]}>Done</span>
                </div>
                <div className={`${s["task-stat"]} ${s["progress-stat"]}`}>
                    <span className={s["task-stat-num"]}>{taskSummary.inProgress}</span>
                    <span className={s["task-stat-label"]}>In Progress</span>
                </div>
                <div className={`${s["task-stat"]} ${s["review-stat"]}`}>
                    <span className={s["task-stat-num"]}>{taskSummary.inReview ?? 0}</span>
                    <span className={s["task-stat-label"]}>In Review</span>
                </div>
                <div className={`${s["task-stat"]} ${s["pending-stat"]}`}>
                    <span className={s["task-stat-num"]}>{taskSummary.pending}</span>
                    <span className={s["task-stat-label"]}>Pending</span>
                </div>
            </div>
            <div className={s["task-progress-bar"]}>
                <div className={`${s["task-progress-fill"]} ${s["done-fill"]}`} style={{ "--fill-width": `${(taskSummary.done / taskSummary.total) * 100}%` } as React.CSSProperties} />
                <div className={`${s["task-progress-fill"]} ${s["progress-fill"]}`} style={{ "--fill-width": `${(taskSummary.inProgress / taskSummary.total) * 100}%` } as React.CSSProperties} />
            </div>
            {/* Single next task (fallback for backward compatibility) */}
            {taskSummary.nextTask && !taskSummary.activeTasks && (
                <div className={s["next-task"]}>
                    <span className={s["next-task-label"]}>Next:</span>
                    <span className={s["next-task-title"]}>{taskSummary.nextTask.title}</span>
                    <span className={`${s["next-task-priority"]} ${s[taskSummary.nextTask.priority]}`}>{taskSummary.nextTask.priority}</span>
                </div>
            )}

            {/* Multiple active tasks rotating carousel */}
            {taskSummary.activeTasks && taskSummary.activeTasks.length > 0 && (
                <div className={s["tasks-carousel-container"]}>
                    <div
                        className={s["tasks-carousel"]}
                        style={{ transform: `translateY(-${slideIndex * 38}px)` }}
                    >
                        {taskSummary.activeTasks.map((task, i) => (
                            <div key={i} className={s["carousel-item"]}>
                                <span className={s["next-task-label"]}>
                                    {task.status === "in_progress" ? "Doing:" : task.status === "in_review" ? "Review:" : "Next:"}
                                </span>
                                <span className={s["next-task-title"]}>{task.title}</span>
                                <span className={`${s["next-task-priority"]} ${s[task.priority]}`}>{task.priority}</span>
                            </div>
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
});

export default TasksSummary;
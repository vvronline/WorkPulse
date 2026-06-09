import React, { useState } from "react";
import { HighlightedHtml, formatDueDate, isDueOverdue } from "./utils";
import { PRIORITIES, type PriorityOption } from "./constants";
import { User, CalendarDays, PenLine, Check, Copy } from "lucide-react";
import {
    StoryPointBadge,
    WorkItemTypeBadge,
    BlockerBadge,
} from "../../components/agile/AgilePickers";
import { useToast } from "../../components/common/Toast";
import s from "./TaskCard.module.css";
import type { Task } from "../../types";

function getPriority(p: string | undefined): PriorityOption {
    return PRIORITIES.find((pr) => pr.value === p) || PRIORITIES[1];
}

// Copy a string to the clipboard. Uses the modern async API when available,
// and falls back to a hidden <textarea> + execCommand for older browsers
// and non-secure contexts (e.g. plain-HTTP dev environments where
// navigator.clipboard is unavailable).
async function copyToClipboard(text: string): Promise<boolean> {
    try {
        if (navigator.clipboard && window.isSecureContext) {
            await navigator.clipboard.writeText(text);
            return true;
        }
    } catch {
        /* fall through */
    }
    try {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.setAttribute("readonly", "");
        ta.style.position = "absolute";
        ta.style.left = "-9999px";
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand("copy");
        document.body.removeChild(ta);
        return ok;
    } catch {
        return false;
    }
}

interface TaskCardProps {
    task: any;
    sprintMode?: boolean;
    onOpenDetail: (task: Task) => void;
    onOpenComments: (id: number | string) => void;
    onDragStart: (e: React.DragEvent, id: number | string) => void;
    onDragEnd: (e: React.DragEvent, id: number | string) => void;
}

export default function TaskCard({
    task,
    sprintMode,
    onOpenDetail,
    onOpenComments,
    onDragStart,
    onDragEnd,
}: TaskCardProps) {
    const pri = getPriority(task.priority);
    const dueFmt = formatDueDate(task.due_date);
    const overdue = isDueOverdue(task.due_date) && task.status !== "done";
    const toast = useToast() as any;
    const [copied, setCopied] = useState(false);

    // Issue key (e.g. WEB-123) only exists once a task is assigned to a project;
    // legacy / unkeyed tickets fall back to "#<id>" so the chip is always
    // present and consistently placed.
    const issueKey = task.issue_key || `#${task.id}`;

    const onCopyKey = async (e: React.MouseEvent) => {
        e.stopPropagation();
        const ok = await copyToClipboard(issueKey);
        if (ok) {
            setCopied(true);
            try {
                toast.success(`Copied ${issueKey}`);
            } catch {
                /* toast optional */
            }
            setTimeout(() => setCopied(false), 1500);
        } else {
            try {
                toast.error("Copy failed");
            } catch {
                /* ignore */
            }
        }
    };

    return (
        <div
            key={task.id}
            id={`task-${task.id}`}
            className={`${s["task-card"]} ${s.clickable} ${task.status === "done" ? s["task-done"] : ""}`}
            draggable
            onDragStart={(e) => onDragStart(e, task.id)}
            onDragEnd={(e) => onDragEnd(e, task.id)}
            onClick={(e) => {
                const target = e.target as HTMLElement;
                if (
                    target.closest(`.${s["task-actions"]}`) ||
                    target.closest(`.${s["task-action-btn"]}`) ||
                    target.closest(`.${s["comment-icon"]}`)
                )
                    return;
                onOpenDetail(task);
            }}
        >
            <div className={s["task-card-top"]}>
                <div className={s["task-card-top-left"]}>
                    <WorkItemTypeBadge
                        value={task.work_item_type_id || task.work_item_type_key}
                    />
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
                    <StoryPointBadge value={task.story_points} />
                    <BlockerBadge task={task} />
                </div>
                <div className={s["task-actions"]}>
                    {/* Issue key chip — click to copy. Coloured with the project's
              accent when known so it visually ties cards to their project. */}
                    <button
                        type="button"
                        className={s["issue-key-chip"]}
                        onClick={onCopyKey}
                        title={`Click to copy ${issueKey}`}
                        style={
                            task.project?.color
                                ? {
                                      background: `${task.project.color}22`,
                                      color: task.project.color,
                                      borderColor: `${task.project.color}55`,
                                  }
                                : undefined
                        }
                    >
                        {copied ? <Check size={11} /> : <Copy size={11} />}
                        <span className={s["issue-key-text"]}>{issueKey}</span>
                    </button>
                    <span
                        className={s["comment-icon"]}
                        onClick={() => onOpenComments(task.id)}
                        title="Comments"
                    >
                        💬
                        {task.comment_count > 0 && (
                            <span className={s["comment-badge"]}>{task.comment_count}</span>
                        )}
                    </span>
                </div>
            </div>

            <div className={s["task-title-row"]}>
                <div className={s["task-title"]}>{task.title}</div>
                {task.labels && task.labels.length > 0 && (
                    <div className={s["task-labels"]}>
                        {task.labels.map((l: any) => (
                            <span
                                key={l.id}
                                className={s["label-pill"]}
                                style={{ "--label-color": l.color } as React.CSSProperties}
                            >
                                {l.name}
                            </span>
                        ))}
                    </div>
                )}
            </div>

            {task.description && (
                <HighlightedHtml html={task.description} className={s["task-desc"]} />
            )}

            <div className={s["task-card-footer"]}>
                <div className={s["task-meta"]}>
                    {task.assignee && (
                        <span
                            className={s["task-assignee"]}
                            title={`Assigned to ${task.assignee.full_name || task.assignee.username}`}
                        >
                            <User
                                size={12}
                                style={{ marginRight: 3, verticalAlign: "middle" }}
                            />
                            {task.assignee.full_name || task.assignee.username}
                        </span>
                    )}
                    {task.creator &&
                        task.assigned_to &&
                        task.user_id !== task.assigned_to && (
                            <span
                                className={s["task-creator"]}
                                title={`Created by ${task.creator.full_name || task.creator.username}`}
                            >
                                <PenLine
                                    size={12}
                                    style={{ marginRight: 3, verticalAlign: "middle" }}
                                />
                                {task.creator.full_name || task.creator.username}
                            </span>
                        )}
                    {dueFmt && (
                        <span className={`${s["task-due"]} ${overdue ? s["overdue"] : ""}`}>
                            <CalendarDays
                                size={12}
                                style={{ marginRight: 3, verticalAlign: "middle" }}
                            />
                            {dueFmt}
                        </span>
                    )}
                </div>
                <span className={s["drag-hint"]}>⠿ drag to move</span>
            </div>
        </div>
    );
}
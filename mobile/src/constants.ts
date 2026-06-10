/** Mirrors client/src/constants/leaves.ts metadata. */
export const LEAVE_TYPES: Record<
  string,
  { label: string; color: string; bg: string }
> = {
  sick: { label: "Sick Leave", color: "#ef4444", bg: "rgba(239,68,68,0.12)" },
  holiday: { label: "Holiday", color: "#f59e0b", bg: "rgba(245,158,11,0.12)" },
  planned: { label: "Planned Leave", color: "#0ea5e9", bg: "rgba(14,165,233,0.12)" },
  personal: { label: "Personal", color: "#10b981", bg: "rgba(16,185,129,0.12)" },
  other: { label: "Other", color: "#0ea5e9", bg: "rgba(14,165,233,0.12)" },
};

export function leaveTypeMeta(value: string) {
  return LEAVE_TYPES[value] ?? LEAVE_TYPES.other;
}

export const LEAVE_STATUS: Record<
  string,
  { label: string; color: string; bg: string }
> = {
  pending: { label: "Pending", color: "#f59e0b", bg: "rgba(245,158,11,0.12)" },
  approved: { label: "Approved", color: "#10b981", bg: "rgba(16,185,129,0.12)" },
  rejected: { label: "Rejected", color: "#ef4444", bg: "rgba(239,68,68,0.12)" },
  withdraw_pending: {
    label: "Withdrawal Pending",
    color: "#0ea5e9",
    bg: "rgba(14,165,233,0.12)",
  },
  withdrawn: { label: "Withdrawn", color: "#0ea5e9", bg: "rgba(14,165,233,0.12)" },
};

export function leaveStatusMeta(value: string) {
  return LEAVE_STATUS[value] ?? LEAVE_STATUS.pending;
}

/** Task status metadata. */
export const TASK_STATUS: Record<
  string,
  { label: string; color: string; bg: string }
> = {
  pending: { label: "To Do", color: "#94a3b8", bg: "rgba(148,163,184,0.12)" },
  in_progress: { label: "In Progress", color: "#2383e2", bg: "rgba(35,131,226,0.12)" },
  in_review: { label: "In Review", color: "#cb912f", bg: "rgba(203,145,47,0.12)" },
  done: { label: "Done", color: "#4daa57", bg: "rgba(77,170,87,0.12)" },
};

export function taskStatusMeta(value: string) {
  return TASK_STATUS[value] ?? TASK_STATUS.pending;
}

export const TASK_PRIORITY: Record<string, { label: string; color: string }> = {
  high: { label: "High", color: "#e03e3e" },
  medium: { label: "Medium", color: "#cb912f" },
  low: { label: "Low", color: "#4daa57" },
};

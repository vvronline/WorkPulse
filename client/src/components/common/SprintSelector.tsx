import React from "react";
import s from "./SprintSelector.module.css";
import type { Sprint } from "../../types";

interface SprintSelectorProps {
    sprints: Sprint[] | null | undefined;
    selected: number | string | "";
    onChange: (sprintId: number | "") => void;
    disabled?: boolean;
    showBadge?: boolean;
}

/**
 * Reusable sprint selector dropdown.
 */
export default function SprintSelector({ sprints, selected, onChange, disabled = false, showBadge = true }: SprintSelectorProps) {
    if (!sprints || sprints.length === 0) return null;

    return (
        <div className={s["form-extra-group"]}>
            <label>🏃 Sprint</label>
            <select
                value={selected || ""}
                onChange={(e) => onChange(e.target.value ? parseInt(e.target.value, 10) : "")}
                disabled={disabled}
            >
                <option value="">Backlog (no sprint)</option>
                {sprints.map((sp) => (
                    <option key={sp.id} value={sp.id}>
                        {sp.name} ({sp.start_date} → {sp.end_date})
                        {sp.status === "active" ? " ● Active" : ""}
                    </option>
                ))}
            </select>
        </div>
    );
}
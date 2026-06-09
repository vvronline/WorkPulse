import { Thermometer, Palmtree, CalendarDays, User, FileEdit } from "lucide-react";
import type { ComponentType } from "react";

export const ROLE_LABELS: Record<string, string> = {
    employee: "Employee",
    team_lead: "Team Lead",
    manager: "Manager",
    hr_admin: "HR Admin",
    super_admin: "Super Admin",
};

export const STATUS_COLORS: Record<string, string> = {
    pending: "var(--warning)",
    approved: "var(--success)",
    rejected: "var(--danger)",
};

export const LEAVE_ICONS: Record<string, ComponentType<{ size?: number | string }>> = {
    sick: Thermometer,
    holiday: Palmtree,
    planned: CalendarDays,
    personal: User,
    other: FileEdit,
};

export function formatMin(totalMin: number): string {
    if (!totalMin) return "0h 0m";
    const h = Math.floor(totalMin / 60);
    const mins = totalMin % 60;
    return `${h}h ${mins}m`;
}
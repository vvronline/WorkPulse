import { Thermometer, Palmtree, CalendarDays, User, FileEdit } from "lucide-react";
import type { ComponentType } from "react";

/** Metadata describing a leave type for rendering in pickers / chips. */
export interface LeaveTypeMeta {
    value: string;
    label?: string;
    Icon: ComponentType<{ size?: number | string; color?: string }>;
    color: string;
    bg: string;
}

/** A subset of an org leave policy used to build leave-type metadata. */
export interface LeavePolicyLike {
    leave_type: string;
    name?: string;
    color?: string;
}

/**
 * Built-in / "starter" leave-type defaults used as fallback when an organisation
 * has not yet configured its own custom leave policies. Once an admin defines
 * leave policies via the Policies tab, those custom types take precedence —
 * the UI dynamically merges org-defined types with these defaults via
 * `buildLeaveTypeMeta()`.
 */
export const LEAVE_TYPES: LeaveTypeMeta[] = [
    { value: "sick", label: "Sick Leave", Icon: Thermometer, color: "#ef4444", bg: "rgba(239,68,68,0.1)" },
    { value: "holiday", label: "Holiday", Icon: Palmtree, color: "#f59e0b", bg: "rgba(245,158,11,0.1)" },
    { value: "planned", label: "Planned Leave", Icon: CalendarDays, color: "#0ea5e9", bg: "rgba(14, 165, 233, 0.1)" },
    { value: "personal", label: "Personal", Icon: User, color: "#10b981", bg: "rgba(16,185,129,0.1)" },
    { value: "other", label: "Other", Icon: FileEdit, color: "#0ea5e9", bg: "rgba(14, 165, 233, 0.1)" },
];

export interface StatusMeta {
    label: string;
    color: string;
    bg: string;
}

export const STATUS_CONFIG: Record<string, StatusMeta> = {
    pending: { label: "Pending", color: "#f59e0b", bg: "rgba(245,158,11,0.12)" },
    approved: { label: "Approved", color: "#10b981", bg: "rgba(16,185,129,0.12)" },
    rejected: { label: "Rejected", color: "#ef4444", bg: "rgba(239,68,68,0.12)" },
    withdraw_pending: { label: "Withdrawal Pending", color: "#0ea5e9", bg: "rgba(14, 165, 233, 0.12)" },
    withdrawn: { label: "Withdrawn", color: "#0ea5e9", bg: "rgba(14, 165, 233, 0.12)" },
};

/** Returns the LEAVE_TYPES config object for a given value, defaulting to 'other'. */
export function getLeaveType(val: string): LeaveTypeMeta {
    return LEAVE_TYPES.find(t => t.value === val) ?? LEAVE_TYPES[4];
}

/** Object lookup version of LEAVE_TYPES (keyed by value). */
export const LEAVE_TYPE_MAP: Record<string, LeaveTypeMeta> =
    Object.fromEntries(LEAVE_TYPES.map(t => [t.value, t]));

/**
 * Build a complete leave-type metadata map from a list of org policies.
 * - Known types (sick / holiday / planned / personal / other) keep their built-in
 *   icon and colour (with overrides allowed from the policy's name/color fields).
 * - Custom types defined by the org are returned with the FileEdit icon and
 *   the policy's configured colour, so they render alongside built-ins.
 */
export function buildLeaveTypeMeta(policies: LeavePolicyLike[] = []): Record<string, LeaveTypeMeta> {
    const out: Record<string, LeaveTypeMeta> = { ...LEAVE_TYPE_MAP };
    for (const p of policies) {
        const base: LeaveTypeMeta = LEAVE_TYPE_MAP[p.leave_type] || {
            value: p.leave_type,
            Icon: FileEdit,
            color: p.color || "#6366f1",
            bg: hexToBg(p.color || "#6366f1"),
        };
        out[p.leave_type] = {
            ...base,
            value: p.leave_type,
            label: p.name || base.label || prettify(p.leave_type),
            color: p.color || base.color,
            bg: p.color ? hexToBg(p.color) : base.bg,
        };
    }
    return out;
}

/**
 * Build an array of leave-type options (suitable for select/chip pickers) from
 * the org's policies. Only shows types explicitly configured by the org — there
 * are no built-in defaults for non-holiday types. Holiday is auto-managed by HR
 * and is excluded from the picker by the consumer.
 * Returns an empty array when the org has not configured any leave policies yet.
 */
export function buildLeaveTypeOptions(policies: LeavePolicyLike[] = []): LeaveTypeMeta[] {
    if (!policies || policies.length === 0) return [];
    const meta = buildLeaveTypeMeta(policies);
    return policies.map(p => meta[p.leave_type]);
}

function prettify(slug: string): string {
    return String(slug || "").replace(/[_-]+/g, " ").replace(/\b\w/g, c => c.toUpperCase());
}

function hexToBg(hex: string): string {
    // Build a 10%-alpha background colour from a hex value (#rrggbb / #rgb).
    const h = String(hex || "").replace("#", "");
    if (!/^[0-9a-fA-F]{3}$|^[0-9a-fA-F]{6}$/.test(h)) return "rgba(99,102,241,0.1)";
    const expand = h.length === 3 ? h.split("").map(c => c + c).join("") : h;
    const r = parseInt(expand.slice(0, 2), 16);
    const g = parseInt(expand.slice(2, 4), 16);
    const b = parseInt(expand.slice(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, 0.1)`;
}
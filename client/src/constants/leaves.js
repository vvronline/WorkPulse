import { Thermometer, Palmtree, CalendarDays, User, FileEdit } from 'lucide-react';

export const LEAVE_TYPES = [
    { value: 'sick', label: 'Sick Leave', Icon: Thermometer, color: '#ef4444', bg: 'rgba(239,68,68,0.1)' },
    { value: 'holiday', label: 'Holiday', Icon: Palmtree, color: '#f59e0b', bg: 'rgba(245,158,11,0.1)' },
    { value: 'planned', label: 'Planned Leave', Icon: CalendarDays, color: '#6366f1', bg: 'rgba(99,102,241,0.1)' },
    { value: 'personal', label: 'Personal', Icon: User, color: '#10b981', bg: 'rgba(16,185,129,0.1)' },
    { value: 'other', label: 'Other', Icon: FileEdit, color: '#8b5cf6', bg: 'rgba(139,92,246,0.1)' },
];

export const STATUS_CONFIG = {
    pending: { label: 'Pending', color: '#f59e0b', bg: 'rgba(245,158,11,0.12)' },
    approved: { label: 'Approved', color: '#10b981', bg: 'rgba(16,185,129,0.12)' },
    rejected: { label: 'Rejected', color: '#ef4444', bg: 'rgba(239,68,68,0.12)' },
    withdraw_pending: { label: 'Withdrawal Pending', color: '#6366f1', bg: 'rgba(99,102,241,0.12)' },
    withdrawn: { label: 'Withdrawn', color: '#8b5cf6', bg: 'rgba(139,92,246,0.12)' },
};

/** Returns the LEAVE_TYPES config object for a given value, defaulting to 'other'. */
export function getLeaveType(val) {
    return LEAVE_TYPES.find(t => t.value === val) ?? LEAVE_TYPES[4];
}

/** Object lookup version of LEAVE_TYPES (keyed by value). */
export const LEAVE_TYPE_MAP = Object.fromEntries(LEAVE_TYPES.map(t => [t.value, t]));

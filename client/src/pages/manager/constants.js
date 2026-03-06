export const ROLE_LABELS = {
    employee: 'Employee',
    team_lead: 'Team Lead',
    manager: 'Manager',
    hr_admin: 'HR Admin',
    super_admin: 'Super Admin',
};

export const STATUS_COLORS = {
    pending: 'var(--warning)',
    approved: 'var(--success)',
    rejected: 'var(--danger)',
};

export const LEAVE_ICONS = {
    sick: '🤒',
    holiday: '🎉',
    planned: '📅',
    personal: '👤',
    other: '📝',
};

export function formatMin(totalMin) {
    if (!totalMin) return '0h 0m';
    const h = Math.floor(totalMin / 60);
    const mins = totalMin % 60;
    return `${h}h ${mins}m`;
}

export function fmtTime(ts) {
    if (!ts) return '';
    const dt = new Date(ts);
    const now = new Date();
    if (dt.toDateString() === now.toDateString())
        return dt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const yest = new Date(now);
    yest.setDate(yest.getDate() - 1);
    if (dt.toDateString() === yest.toDateString()) return 'Yesterday';
    return dt.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

export function getConvName(c) {
    if (c.is_group) return c.group_name || c.name || 'Group';
    if (c.is_self_chat) return `${c.other_full_name || 'You'} (You)`;
    return c.other_full_name || 'Unknown';
}

export function getConvAvatar(c) {
    if (c.is_group) return null;
    return c.other_avatar;
}

export function isUserOnline(c, onlineUsers) {
    if (c.is_group) return false;
    return onlineUsers.has(c.other_user_id);
}

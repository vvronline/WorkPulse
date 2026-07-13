import type { Conversation } from "../../types";

export function fmtTime(ts?: string | number | Date | null): string {
    if (!ts) return "";
    const dt = new Date(ts);
    const now = new Date();
    if (dt.toDateString() === now.toDateString())
        return dt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const yest = new Date(now);
    yest.setDate(yest.getDate() - 1);
    if (dt.toDateString() === yest.toDateString()) return "Yesterday";
    return dt.toLocaleDateString([], { month: "short", day: "numeric" });
}

export function getConvName(c: Conversation): string {
    if (c.is_group) return c.group_name || c.name || "Group";
    if (c.is_self_chat) return `${c.other_full_name || "You"} (You)`;
    return c.other_full_name || "Unknown";
}

export function getConvAvatar(c: Conversation): string | null {
    if (c.is_group) return null;
    return c.other_avatar ?? null;
}

export function isUserOnline(c: Conversation, onlineUsers: Set<unknown>): boolean {
    if (c.is_group) return false;
    return onlineUsers.has(c.other_user_id);
}

// Human label for whether the peer is currently logged in from the office or
// working remotely (from today's attendance clock-in). Shared with the mobile
// app's chatUtils WORK_MODE_LABEL.
export const WORK_MODE_LABEL: Record<string, string> = {
    office: "In office",
    remote: "Remote",
    hybrid: "Hybrid",
};

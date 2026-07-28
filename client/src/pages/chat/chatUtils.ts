import type { Conversation } from "../../types";

// Distance (px) from the bottom of the message list within which the thread is
// still considered "at the latest message". Shared by every scroll surface so
// they can't drift apart: the open-at-latest pin and the smart auto-scroll in
// useChatState, and the floating "scroll to latest" button in ChatMessages.
// These previously used 160 and 400 respectively, which left a dead zone where
// the view was parked off-bottom but the jump-to-latest button stayed hidden.
export const NEAR_BOTTOM_PX = 160;

// How long the open-at-latest pin keeps watching for late-expanding content
// (images, link previews) before releasing the thread to the user. Desktop
// (Electron) proxies every /uploads/* image to a remote origin, so attachments
// routinely settle well after the first frames.
export const PIN_SETTLE_MS = 3000;

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

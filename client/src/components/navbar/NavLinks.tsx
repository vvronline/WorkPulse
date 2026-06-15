import { useState, useRef } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { useAuth } from "../../AuthContext";
import { useFeatures } from "../../FeaturesContext";
import { useChatUnread } from "../../ChatContext";
import { useClickOutside } from "../../hooks/useClickOutside";
import { prefetchPage } from "../common/KeepAlive";
import { Building2, Users, Settings, Server } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import s from "./Navbar.module.css";

const ROLE_LEVELS: Record<string, number> = {
    employee: 1,
    team_lead: 2,
    manager: 3,
    hr_admin: 4,
    super_admin: 5,
    platform_admin: 6,
};

interface MoreItem {
    to: string;
    label: string;
    icon: LucideIcon;
}

export default function NavLinks() {
    const { user } = useAuth() as any;
    const { hasFeature } = useFeatures() as any;
    const location = useLocation();
    const { unreadCount: chatUnread } = useChatUnread() as any;
    const [moreOpen, setMoreOpen] = useState(false);
    const moreRef = useRef<HTMLDivElement | null>(null);

    useClickOutside(moreRef, () => setMoreOpen(false));

    const userLevel = ROLE_LEVELS[user?.role] || 1;
    const isTeamLead = userLevel >= 2 || user?.has_reports;
    const isHR = userLevel >= 4;

    const moreItems: MoreItem[] = [];
    if (user?.org_id || user?.role === "platform_admin")
        moreItems.push({ to: "/organization", label: "Organization", icon: Building2 });
    if (isTeamLead) moreItems.push({ to: "/manager", label: "My Team", icon: Users });
    if (isHR) moreItems.push({ to: "/admin", label: "Admin", icon: Settings });
    if (user?.role === "platform_admin")
        moreItems.push({ to: "/tenants", label: "Tenants", icon: Server });

    const moreIsActive = moreItems.some((item) => location.pathname === item.to);
    const p = location.pathname;

    return (
        <div className={`${s["nav-links"]} ${s["nav-links-desktop"]}`}>
            <NavLink
                to="/"
                className={p === "/" ? s.active : ""}
                onMouseEnter={() => prefetchPage("/")}
            >
                <svg
                    className={s["nav-link-icon"]}
                    width="15"
                    height="15"
                    viewBox="0 0 24 24"
                    fill="none"
                >
                    <path
                        d="M3 9.5L12 3l9 6.5V20a1 1 0 01-1 1H4a1 1 0 01-1-1V9.5z"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                    />
                </svg>
                Dashboard
            </NavLink>
            {hasFeature("calendar") && (
                <NavLink
                    to="/calendar"
                    className={p === "/calendar" ? s.active : ""}
                    onMouseEnter={() => prefetchPage("/calendar")}
                >
                    <svg
                        className={s["nav-link-icon"]}
                        width="15"
                        height="15"
                        viewBox="0 0 24 24"
                        fill="none"
                    >
                        <rect x="3" y="4" width="18" height="18" rx="2" stroke="currentColor" strokeWidth="2" />
                        <path d="M16 2v4M8 2v4M3 10h18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                    </svg>
                    Calendar
                </NavLink>
            )}
            {hasFeature("tasks") && (
                <NavLink
                    to="/tasks"
                    className={p === "/tasks" ? s.active : ""}
                    onMouseEnter={() => prefetchPage("/tasks")}
                >
                    <svg
                        className={s["nav-link-icon"]}
                        width="15"
                        height="15"
                        viewBox="0 0 24 24"
                        fill="none"
                    >
                        <path
                            d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                        />
                        <path
                            d="M9 14l2 2 4-4"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                        />
                    </svg>
                    Tasks
                </NavLink>
            )}
            {hasFeature("notes") && (
                <NavLink
                    to="/notes"
                    className={p === "/notes" ? s.active : ""}
                    onMouseEnter={() => prefetchPage("/notes")}
                >
                    <svg
                        className={s["nav-link-icon"]}
                        width="15"
                        height="15"
                        viewBox="0 0 24 24"
                        fill="none"
                    >
                        <path
                            d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                        />
                        <path
                            d="M14 2v6h6M16 13H8M16 17H8M10 9H8"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                        />
                    </svg>
                    Notes
                </NavLink>
            )}
            {hasFeature("chat") && (
                <NavLink
                    to="/chat"
                    className={`${p === "/chat" ? s.active : ""} ${s.chatLink}`}
                    onMouseEnter={() => prefetchPage("/chat")}
                >
                    <svg
                        className={s["nav-link-icon"]}
                        width="15"
                        height="15"
                        viewBox="0 0 24 24"
                        fill="none"
                    >
                        <path
                            d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2v10z"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                        />
                    </svg>
                    Chat
                    {chatUnread > 0 && (
                        <span className={s.chatBadge}>{chatUnread > 99 ? "99+" : chatUnread}</span>
                    )}
                </NavLink>
            )}
            {hasFeature("attendance") && (
                <NavLink
                    to="/attendance"
                    className={p.startsWith("/attendance") ? s.active : ""}
                    onMouseEnter={() => prefetchPage("/attendance")}
                >
                    <svg
                        className={s["nav-link-icon"]}
                        width="15"
                        height="15"
                        viewBox="0 0 24 24"
                        fill="none"
                    >
                        <rect x="3" y="4" width="18" height="18" rx="2" stroke="currentColor" strokeWidth="2" />
                        <path d="M16 2v4M8 2v4M3 10h18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                        <path
                            d="M8 14l2 2 4-4"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                        />
                    </svg>
                    Attendance
                </NavLink>
            )}
            {moreItems.length > 0 && (
                <div className={s["more-wrapper"]} ref={moreRef}>
                    <button
                        className={`${s["more-btn"]} ${moreIsActive ? s.active : ""}`}
                        onClick={() => setMoreOpen((prev) => !prev)}
                        title="More"
                    >
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
                            <path
                                d="M4 6h16M4 12h16M4 18h16"
                                stroke="currentColor"
                                strokeWidth="2"
                                strokeLinecap="round"
                            />
                        </svg>
                    </button>
                    {moreOpen && (
                        <div className={s["more-dropdown"]}>
                            {moreItems.map((item) => (
                                <NavLink
                                    key={item.to}
                                    to={item.to}
                                    className={p === item.to ? s.active : ""}
                                    onClick={() => setMoreOpen(false)}
                                    onMouseEnter={() => prefetchPage(item.to)}
                                >
                                    {item.icon && <item.icon size={15} />} {item.label}
                                </NavLink>
                            ))}
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}
import { useState, useRef } from "react";
import {
    Pin,
    FolderOpen,
    Star,
    Settings,
    ArrowLeft,
    Users,
    Phone,
    Video,
    MoreVertical,
    Search,
    Trash2,
    Ban,
    Info,
    Building2,
    House,
} from "lucide-react";
import { ChatAvatar } from "../../components/chat";
import { useClickOutside } from "../../hooks/useClickOutside";
import { getConvName, getConvAvatar, isUserOnline, WORK_MODE_LABEL } from "./chatUtils";
import s from "./ChatHeader.module.css";

const STATUS_LABEL: Record<string, string> = {
    available: "Available",
    busy: "Busy",
    dnd: "Do Not Disturb",
    away: "Away",
    offline: "Offline",
    in_call: "In a Call",
    in_meeting: "In a Meeting",
};

// Coloured dot next to the office/remote badge (green = office, blue = remote,
// amber = hybrid).
const WORK_MODE_COLOR: Record<string, string> = {
    office: "#16a34a",
    remote: "#2563eb",
    hybrid: "#d97706",
};

// Status-dot colour for the left (presence) zone of the unified pill.
const STATUS_DOT_COLOR: Record<string, string> = {
    available: "#22c55e",
    busy: "#ef4444",
    dnd: "#ef4444",
    away: "#f59e0b",
    offline: "#94a3b8",
    in_call: "#ef4444",
    in_meeting: "#f59e0b",
};

interface OverflowItem {
    label?: string;
    icon?: any;
    action?: () => void;
    mobileOnly?: boolean;
    danger?: boolean;
    divider?: boolean;
}

interface ChatHeaderProps {
    activeConv: any;
    onlineUsers: any;
    userStatusMap?: Record<string, string>;
    userWorkModeMap?: Record<string, string | null>;
    onBack: () => void;
    onGroupEdit: () => void;
    onToggleSearch: () => void;
    onTogglePinned: () => void;
    showPinned?: boolean;
    onToggleSharedFiles: () => void;
    showSharedFiles?: boolean;
    onToggleStarred: () => void;
    showStarred?: boolean;
    onVoiceCall: () => void;
    onVideoCall: () => void;
    onClearChat?: (id: number | string) => void;
    onToggleBlock?: (conv: any) => void;
    onOpenInfo?: () => void;
}

export default function ChatHeader({
    activeConv,
    onlineUsers,
    userStatusMap = {},
    userWorkModeMap = {},
    onBack,
    onGroupEdit,
    onToggleSearch,
    onTogglePinned,
    showPinned,
    onToggleSharedFiles,
    showSharedFiles,
    onToggleStarred,
    showStarred,
    onVoiceCall,
    onVideoCall,
    onClearChat,
    onToggleBlock,
    onOpenInfo,
}: ChatHeaderProps) {
    const [moreOpen, setMoreOpen] = useState(false);
    const moreRef = useRef<HTMLDivElement | null>(null);
    useClickOutside(moreRef, () => setMoreOpen(false), moreOpen);

    const handleMoreAction = (fn?: () => void) => () => {
        setMoreOpen(false);
        fn?.();
    };

    const overflowItems: OverflowItem[] = [
        // Search lives ONLY here (all screen sizes) — the duplicate inline
        // header search icon was removed to keep a single entry point.
        ...(onOpenInfo ? [{ label: "Conversation info", icon: Info, action: onOpenInfo }] : []),
        { label: "Search messages", icon: Search, action: onToggleSearch },
        { label: "Pinned messages", icon: Pin, action: onTogglePinned },
        { label: "Shared files", icon: FolderOpen, action: onToggleSharedFiles },
        { label: "Saved messages", icon: Star, action: onToggleStarred },
        ...(activeConv.is_group ? [{ label: "Group settings", icon: Settings, action: onGroupEdit }] : []),
        { divider: true },
        // Block/unblock (direct chats only — Signal parity; you can't block a group)
        ...(!activeConv.is_group && !activeConv.is_self_chat && activeConv.other_user_id && onToggleBlock
            ? [
                  {
                      label: activeConv.is_blocked ? "Unblock user" : "Block user",
                      icon: Ban,
                      action: () => onToggleBlock(activeConv),
                      danger: !activeConv.is_blocked,
                  },
              ]
            : []),
        { label: "Clear chat", icon: Trash2, action: () => onClearChat?.(activeConv.id), danger: true },
    ];

    const otherStatus =
        !activeConv.is_group && activeConv.other_user_id ? userStatusMap[activeConv.other_user_id] : undefined;
    // Whether the peer is currently logged in from the office or remotely
    // (direct chats only — a group has no single "other" user).
    const otherWorkMode =
        !activeConv.is_group && activeConv.other_user_id
            ? userWorkModeMap[activeConv.other_user_id]
            : undefined;
    const online = isUserOnline(activeConv, onlineUsers);

    // Unified presence pill data: left zone = live status, right zone = work
    // mode. The two were previously decoupled (plain text + a separate badge);
    // they're now a single cohesive pill.
    const statusText = activeConv.is_group
        ? `${activeConv.member_count || ""} members`
        : otherStatus && otherStatus !== "available"
          ? STATUS_LABEL[otherStatus] || otherStatus
          : online
            ? "Online"
            : activeConv.other_username
              ? `@${activeConv.other_username}`
              : "";
    const statusDotColor = activeConv.is_group
        ? null
        : online
          ? STATUS_DOT_COLOR[otherStatus || "available"] || STATUS_DOT_COLOR.available
          : STATUS_DOT_COLOR.offline;
    const hasWorkMode = Boolean(
        !activeConv.is_group && otherWorkMode && WORK_MODE_LABEL[otherWorkMode as string]
    );

    return (
        <div className={s.chatHeader}>
            <button className={s.backBtn} onClick={onBack} aria-label="Back">
                <ArrowLeft size={18} />
            </button>
            <ChatAvatar
                name={getConvName(activeConv)}
                avatar={getConvAvatar(activeConv)}
                size="md"
                online={isUserOnline(activeConv, onlineUsers)}
                userStatus={otherStatus}
            />
            <div
                className={s.chatHeaderInfo}
                onClick={onOpenInfo}
                style={onOpenInfo ? { cursor: "pointer" } : undefined}
            >
                <div className={s.chatHeaderName}>
                    {activeConv.is_group && (
                        <Users
                            size={14}
                            style={{ display: "inline", verticalAlign: "middle", marginRight: "3px" }}
                        />
                    )}
                    {getConvName(activeConv)}
                </div>
                <div className={s.chatHeaderMeta}>
                    {statusText || hasWorkMode ? (
                        <span className={s.presencePill}>
                            {statusText ? (
                                <span className={s.presenceStatus}>
                                    {statusDotColor ? (
                                        <span
                                            className={s.statusDot}
                                            style={{ background: statusDotColor }}
                                        />
                                    ) : null}
                                    {statusText}
                                </span>
                            ) : null}
                            {statusText && hasWorkMode ? (
                                <span className={s.presenceDivider} />
                            ) : null}
                            {hasWorkMode ? (
                                <span
                                    className={s.presenceWorkMode}
                                    style={{
                                        color: WORK_MODE_COLOR[otherWorkMode as string] || "#16a34a",
                                    }}
                                    title={WORK_MODE_LABEL[otherWorkMode as string]}
                                >
                                    {otherWorkMode === "remote" ? (
                                        <House size={12} />
                                    ) : (
                                        <Building2 size={12} />
                                    )}
                                    {WORK_MODE_LABEL[otherWorkMode as string]}
                                </span>
                            ) : null}
                        </span>
                    ) : null}
                </div>
            </div>
            <div className={s.headerActions}>
                {!activeConv.is_self_chat && (
                    <>
                        <button onClick={onVoiceCall} title="Voice call" className={s.callBtn}>
                            <Phone size={16} />
                        </button>
                        <button onClick={onVideoCall} title="Video call" className={s.callBtn}>
                            <Video size={16} />
                        </button>
                    </>
                )}
                {/* Desktop-only inline actions (search moved to the 3-dot menu) */}
                {activeConv.is_group && (
                    <span className={s.desktopActions}>
                        <button onClick={onGroupEdit} title="Group settings">
                            <Settings size={16} />
                        </button>
                    </span>
                )}
                {/* 3-dot menu: visible on all screen sizes */}
                <div className={s.moreWrapper} ref={moreRef}>
                    <button className={s.moreBtn} onClick={() => setMoreOpen((v) => !v)} aria-label="More options">
                        <MoreVertical size={18} />
                    </button>
                    {moreOpen && (
                        <div className={s.moreDropdown}>
                            {overflowItems.map((item, idx) =>
                                item.divider ? (
                                    <div key={`div-${idx}`} className={s.moreDivider} />
                                ) : (
                                    <button
                                        key={item.label}
                                        className={`${s.moreItem} ${item.mobileOnly ? s.mobileOnlyItem : ""} ${
                                            item.danger ? s.moreItemDanger : ""
                                        }`}
                                        onClick={handleMoreAction(item.action)}
                                    >
                                        {item.icon && <item.icon size={15} />}
                                        <span>{item.label}</span>
                                    </button>
                                )
                            )}
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
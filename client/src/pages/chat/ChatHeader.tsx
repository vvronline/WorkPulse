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
} from "lucide-react";
import { ChatAvatar } from "../../components/chat";
import { useClickOutside } from "../../hooks/useClickOutside";
import { getConvName, getConvAvatar, isUserOnline } from "./chatUtils";
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
}

export default function ChatHeader({
    activeConv,
    onlineUsers,
    userStatusMap = {},
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
        { label: "Search messages", icon: Search, action: onToggleSearch },
        { label: "Pinned messages", icon: Pin, action: onTogglePinned },
        { label: "Shared files", icon: FolderOpen, action: onToggleSharedFiles },
        { label: "Saved messages", icon: Star, action: onToggleStarred },
        ...(activeConv.is_group ? [{ label: "Group settings", icon: Settings, action: onGroupEdit }] : []),
        { divider: true },
        { label: "Clear chat", icon: Trash2, action: () => onClearChat?.(activeConv.id), danger: true },
    ];

    const otherStatus =
        !activeConv.is_group && activeConv.other_user_id ? userStatusMap[activeConv.other_user_id] : undefined;
    const online = isUserOnline(activeConv, onlineUsers);

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
                onClick={activeConv.is_group ? onGroupEdit : undefined}
                style={activeConv.is_group ? { cursor: "pointer" } : undefined}
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
                    {activeConv.is_group
                        ? `${activeConv.member_count || ""} members`
                        : otherStatus && otherStatus !== "available"
                          ? STATUS_LABEL[otherStatus] || otherStatus
                          : online
                            ? "Online"
                            : activeConv.other_username
                              ? `@${activeConv.other_username}`
                              : ""}
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
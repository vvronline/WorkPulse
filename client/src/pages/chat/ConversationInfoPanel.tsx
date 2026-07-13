import {
    X,
    Phone,
    Video,
    Search,
    Pin,
    FolderOpen,
    Star,
    Settings,
    Ban,
    Trash2,
    ChevronRight,
    Users,
} from "lucide-react";
import { ChatAvatar } from "../../components/chat";
import {
    getConvName,
    getConvAvatar,
    isUserOnline,
    WORK_MODE_LABEL,
} from "./chatUtils";
import s from "./ConversationInfoPanel.module.css";

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
// amber = hybrid). Mirrors the ChatHeader.
const WORK_MODE_COLOR: Record<string, string> = {
    office: "#16a34a",
    remote: "#2563eb",
    hybrid: "#d97706",
};

interface ConversationInfoPanelProps {
    activeConv: any;
    onlineUsers: Set<number | string>;
    userStatusMap?: Record<string, string>;
    userWorkModeMap?: Record<string, string | null>;
    onClose: () => void;
    onSearch: () => void;
    onPinned: () => void;
    onSharedFiles: () => void;
    onStarred: () => void;
    onGroupEdit: () => void;
    onVoiceCall: () => void;
    onVideoCall: () => void;
    onClearChat: (id: number | string) => void;
    onToggleBlock: (conv: any) => void;
}

/**
 * Conversation info / profile drawer (mirrors the mobile /chat/info screen).
 * Opened by clicking the chat header profile. Provides the large avatar + name,
 * quick call/search actions, and entry points to shared media, pinned & saved
 * messages, group settings, block/unblock and clear chat.
 */
export default function ConversationInfoPanel({
    activeConv,
    onlineUsers,
    userStatusMap = {},
    userWorkModeMap = {},
    onClose,
    onSearch,
    onPinned,
    onSharedFiles,
    onStarred,
    onGroupEdit,
    onVoiceCall,
    onVideoCall,
    onClearChat,
    onToggleBlock,
}: ConversationInfoPanelProps) {
    const isGroup = !!activeConv.is_group;
    const isSelf = !!activeConv.is_self_chat;
    const name = getConvName(activeConv);
    const avatar = getConvAvatar(activeConv);
    const online = isUserOnline(activeConv, onlineUsers);

    const otherStatus =
        !isGroup && activeConv.other_user_id
            ? userStatusMap[activeConv.other_user_id]
            : undefined;
    const otherWorkMode =
        !isGroup && activeConv.other_user_id
            ? userWorkModeMap[activeConv.other_user_id]
            : undefined;

    const subtitle = isGroup
        ? activeConv.member_count
            ? `${activeConv.member_count} members`
            : "Group"
        : otherStatus && otherStatus !== "available"
          ? STATUS_LABEL[otherStatus] || otherStatus
          : online
            ? "Online"
            : activeConv.other_username
              ? `@${activeConv.other_username}`
              : "";

    // Run an action then dismiss the drawer so the target panel/modal is
    // visible underneath.
    const run = (fn: () => void) => () => {
        onClose();
        fn();
    };

    return (
        <div className={s.overlay}>
            <div className={s.scrim} onClick={onClose} />
            <div className={s.drawer} role="dialog" aria-label="Conversation info">
                <div className={s.header}>
                    <span className={s.title}>Conversation info</span>
                    <button className={s.closeBtn} onClick={onClose} aria-label="Close">
                        <X size={18} />
                    </button>
                </div>

                <div className={s.body}>
                    {/* Profile header. */}
                    <div className={s.profile}>
                        <ChatAvatar
                            name={name}
                            avatar={avatar}
                            size="xl"
                            online={!isGroup ? online : undefined}
                            userStatus={otherStatus}
                        />
                        <div className={s.profileName}>
                            {isGroup && (
                                <Users
                                    size={16}
                                    style={{ display: "inline", verticalAlign: "middle", marginRight: 4 }}
                                />
                            )}
                            {name}
                        </div>
                        {subtitle ? <div className={s.profileSub}>{subtitle}</div> : null}
                        {!isGroup && otherWorkMode && WORK_MODE_LABEL[otherWorkMode] ? (
                            <span className={s.workModeBadge}>
                                <span
                                    className={s.workModeDot}
                                    style={{ background: WORK_MODE_COLOR[otherWorkMode] || "#16a34a" }}
                                />
                                {WORK_MODE_LABEL[otherWorkMode]}
                            </span>
                        ) : null}
                    </div>

                    {/* Quick actions. */}
                    {!isSelf && (
                        <div className={s.quickRow}>
                            <button className={s.quickAction} onClick={run(onVoiceCall)}>
                                <span className={s.quickIcon}><Phone size={20} /></span>
                                <span className={s.quickLabel}>Call</span>
                            </button>
                            <button className={s.quickAction} onClick={run(onVideoCall)}>
                                <span className={s.quickIcon}><Video size={20} /></span>
                                <span className={s.quickLabel}>Video</span>
                            </button>
                            <button className={s.quickAction} onClick={run(onSearch)}>
                                <span className={s.quickIcon}><Search size={20} /></span>
                                <span className={s.quickLabel}>Search</span>
                            </button>
                        </div>
                    )}
                    {isSelf && (
                        <div className={s.quickRow}>
                            <button className={s.quickAction} onClick={run(onSearch)}>
                                <span className={s.quickIcon}><Search size={20} /></span>
                                <span className={s.quickLabel}>Search</span>
                            </button>
                        </div>
                    )}

                    {/* Group management. */}
                    {isGroup && (
                        <div className={s.section}>
                            <InfoRow
                                icon={<Settings size={18} />}
                                label="Group settings & members"
                                onClick={run(onGroupEdit)}
                            />
                        </div>
                    )}

                    {/* Shared content. */}
                    <div className={s.section}>
                        <InfoRow
                            icon={<FolderOpen size={18} />}
                            label="Shared media, files & links"
                            onClick={run(onSharedFiles)}
                        />
                        <InfoRow
                            icon={<Pin size={18} />}
                            label="Pinned messages"
                            onClick={run(onPinned)}
                        />
                        <InfoRow
                            icon={<Star size={18} />}
                            label="Saved messages"
                            onClick={run(onStarred)}
                        />
                    </div>

                    {/* Privacy / destructive. */}
                    <div className={s.section}>
                        {!isGroup && !isSelf && activeConv.other_user_id ? (
                            <InfoRow
                                icon={<Ban size={18} />}
                                label={activeConv.is_blocked ? "Unblock user" : "Block user"}
                                danger={!activeConv.is_blocked}
                                onClick={run(() => onToggleBlock(activeConv))}
                            />
                        ) : null}
                        <InfoRow
                            icon={<Trash2 size={18} />}
                            label="Clear chat"
                            danger
                            onClick={run(() => onClearChat(activeConv.id))}
                        />
                    </div>
                </div>
            </div>
        </div>
    );
}

function InfoRow({
    icon,
    label,
    danger,
    onClick,
}: {
    icon: React.ReactNode;
    label: string;
    danger?: boolean;
    onClick: () => void;
}) {
    return (
        <button className={`${s.row} ${danger ? s.rowDanger : ""}`} onClick={onClick}>
            <span className={s.rowIcon}>{icon}</span>
            <span className={s.rowLabel}>{label}</span>
            <ChevronRight size={16} className={s.rowChevron} />
        </button>
    );
}

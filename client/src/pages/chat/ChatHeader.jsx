import { useState, useRef } from 'react';
import { Pin, FolderOpen, Star, Settings, ArrowLeft, Users, Phone, Video, MoreVertical, Search, Trash2 } from 'lucide-react';
import { ChatAvatar } from '../../components/chat';
import { useClickOutside } from '../../hooks/useClickOutside';
import { getConvName, getConvAvatar, isUserOnline } from './chatUtils';
import s from './ChatHeader.module.css';

export default function ChatHeader({ activeConv, onlineUsers, onBack, onGroupEdit, onToggleSearch, onTogglePinned, showPinned, onToggleSharedFiles, showSharedFiles, onToggleStarred, showStarred, onVoiceCall, onVideoCall, onClearChat }) {
    const [moreOpen, setMoreOpen] = useState(false);
    const moreRef = useRef(null);
    useClickOutside(moreRef, () => setMoreOpen(false), moreOpen);

    const handleMoreAction = (fn) => () => { setMoreOpen(false); fn(); };

    const overflowItems = [
        { label: 'Pinned messages', icon: Pin, action: onTogglePinned },
        { label: 'Shared files', icon: FolderOpen, action: onToggleSharedFiles },
        { label: 'Saved messages', icon: Star, action: onToggleStarred },
        ...(activeConv.is_group ? [{ label: 'Group settings', icon: Settings, action: onGroupEdit }] : []),
        { divider: true },
        { label: 'Clear chat', icon: Trash2, action: () => onClearChat?.(activeConv.id), danger: true },
    ];

    return (
        <div className={s.chatHeader}>
            <button className={s.backBtn} onClick={onBack} aria-label="Back"><ArrowLeft size={18} /></button>
            <ChatAvatar
                name={getConvName(activeConv)}
                avatar={getConvAvatar(activeConv)}
                size="md"
                online={isUserOnline(activeConv, onlineUsers)}
            />
            <div className={s.chatHeaderInfo} onClick={activeConv.is_group ? onGroupEdit : undefined}
                 style={activeConv.is_group ? { cursor: 'pointer' } : undefined}>
                <div className={s.chatHeaderName}>
                    {activeConv.is_group && <Users size={14} style={{ display: 'inline', verticalAlign: 'middle', marginRight: '3px' }} />}{getConvName(activeConv)}
                </div>
                <div className={s.chatHeaderMeta}>
                    {activeConv.is_group
                        ? `${activeConv.member_count || ''} members`
                        : isUserOnline(activeConv, onlineUsers) ? 'Online' : `@${activeConv.other_username}`}
                </div>
            </div>
            <div className={s.headerActions}>
                <button onClick={onVoiceCall} title="Voice call" className={s.callBtn}>
                    <Phone size={16} />
                </button>
                <button onClick={onVideoCall} title="Video call" className={s.callBtn}>
                    <Video size={16} />
                </button>
                {/* Desktop-only: search button inline */}
                <span className={s.desktopActions}>
                    <button onClick={onToggleSearch} title="Search messages">
                        <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="6.5" cy="6.5" r="4.5" stroke="currentColor" strokeWidth="1.5"/><path d="M11 11l3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
                    </button>
                    {activeConv.is_group && <button onClick={onGroupEdit} title="Group settings"><Settings size={16} /></button>}
                </span>
                {/* 3-dot menu: visible on all screen sizes */}
                <div className={s.moreWrapper} ref={moreRef}>
                    <button className={s.moreBtn} onClick={() => setMoreOpen(v => !v)} aria-label="More options">
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
                                        className={`${s.moreItem} ${item.danger ? s.moreItemDanger : ''}`}
                                        onClick={handleMoreAction(item.action)}
                                    >
                                        <item.icon size={15} />
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

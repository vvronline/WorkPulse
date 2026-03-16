import { ChatAvatar } from '../../components/chat';
import { getConvName, getConvAvatar, isUserOnline } from './chatUtils';
import s from './ChatHeader.module.css';

export default function ChatHeader({ activeConv, onlineUsers, onBack, onGroupEdit, onToggleSearch, onTogglePinned, showPinned, onToggleSharedFiles, showSharedFiles, onToggleStarred, showStarred }) {
    return (
        <div className={s.chatHeader}>
            <button className={s.backBtn} onClick={onBack}>←</button>
            <ChatAvatar
                name={getConvName(activeConv)}
                avatar={getConvAvatar(activeConv)}
                size="md"
                online={isUserOnline(activeConv, onlineUsers)}
            />
            <div className={s.chatHeaderInfo} onClick={activeConv.is_group ? onGroupEdit : undefined}
                 style={activeConv.is_group ? { cursor: 'pointer' } : undefined}>
                <div className={s.chatHeaderName}>
                    {activeConv.is_group && '👥 '}{getConvName(activeConv)}
                </div>
                <div className={s.chatHeaderMeta}>
                    {activeConv.is_group
                        ? `${activeConv.member_count || ''} members`
                        : isUserOnline(activeConv, onlineUsers) ? 'Online' : `@${activeConv.other_username}`}
                </div>
            </div>
            <div className={s.headerActions}>
                <button onClick={onToggleSearch} title="Search messages">
                    <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="6.5" cy="6.5" r="4.5" stroke="currentColor" strokeWidth="1.5"/><path d="M11 11l3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
                </button>
                <button onClick={onTogglePinned} title="Pinned messages">📌</button>
                <button onClick={onToggleSharedFiles} title="Shared files">📁</button>
                <button onClick={onToggleStarred} title="Saved messages">⭐</button>
                {activeConv.is_group && <button onClick={onGroupEdit} title="Group settings">⚙️</button>}
            </div>
        </div>
    );
}

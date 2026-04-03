import { ChatAvatar } from '../../components/chat';
import { getConvName, getConvAvatar, isUserOnline } from './chatUtils';
import s from './ChatHeader.module.css';

export default function ChatHeader({ activeConv, onlineUsers, onBack, onGroupEdit, onToggleSearch, onTogglePinned, showPinned, onToggleSharedFiles, showSharedFiles, onToggleStarred, showStarred, onToggleCallHistory, showCallHistory, onVoiceCall, onVideoCall }) {
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
                <button onClick={onVoiceCall} title="Voice call" className={s.callBtn}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M3.51 5.47a2.5 2.5 0 0 1 3.53 0l1.06 1.06a2.5 2.5 0 0 1 0 3.54l-.53.53a9 9 0 0 0 5.83 5.83l.53-.53a2.5 2.5 0 0 1 3.54 0l1.06 1.06a2.5 2.5 0 0 1 0 3.53l-.87.87a3 3 0 0 1-3.15.73C9.42 20.45 3.55 14.58 1.91 9.49a3 3 0 0 1 .73-3.15l.87-.87z" stroke="currentColor" strokeWidth="2" fill="none"/></svg>
                </button>
                <button onClick={onVideoCall} title="Video call" className={s.callBtn}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><rect x="2" y="7" width="14" height="10" rx="2" stroke="currentColor" strokeWidth="2"/><path d="M16 11l6-4v10l-6-4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
                </button>
                <button onClick={onToggleSearch} title="Search messages">
                    <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="6.5" cy="6.5" r="4.5" stroke="currentColor" strokeWidth="1.5"/><path d="M11 11l3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
                </button>
                <button onClick={onTogglePinned} title="Pinned messages">📌</button>
                <button onClick={onToggleSharedFiles} title="Shared files">📁</button>
                <button onClick={onToggleStarred} title="Saved messages">⭐</button>
                <button onClick={onToggleCallHistory} title="Call history" style={showCallHistory ? { color: 'var(--accent)' } : undefined}>📋</button>
                {activeConv.is_group && <button onClick={onGroupEdit} title="Group settings">⚙️</button>}
            </div>
        </div>
    );
}

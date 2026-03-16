import { ChatAvatar } from '../../components/chat';
import { fmtTime, getConvName, getConvAvatar, isUserOnline } from './chatUtils';
import s from './ChatSidebar.module.css';

function ConversationItem({ conv, activeConvId, typingUsers, onlineUsers, convMenu, onOpen, onMenuToggle, onPin, onFav, onDelete }) {
    const c = conv;
    return (
        <div
            className={`${s.convItem} ${activeConvId === c.id ? s.active : ''}`}
            onClick={() => onOpen(c)}
        >
            <ChatAvatar name={getConvName(c)} avatar={getConvAvatar(c)} size="md" online={isUserOnline(c, onlineUsers)} />
            <div className={s.convInfo}>
                <div className={s.convTop}>
                    <span className={s.convName}>
                        {c.is_pinned && '📌 '}{c.is_favourite && !c.is_pinned && '⭐ '}{c.is_group && '👥 '}{getConvName(c)}
                    </span>
                    <span className={s.convTime}>{fmtTime(c.last_message_at)}</span>
                </div>
                <div className={s.convPreview}>
                    {typingUsers[c.id]
                        ? <span className={s.typing}>typing...</span>
                        : <span className={c.unread_count > 0 ? s.unread : ''}>
                            {c.is_group && c.last_sender_name ? `${c.last_sender_name.split(' ')[0]}: ` : ''}
                            {c.last_deleted ? 'Message deleted'
                                : c.last_message ? c.last_message
                                : c.last_file_url?.includes('voice') ? '🎤 Voice message'
                                : c.last_file_url ? '📎 Attachment'
                                : 'No messages yet'}
                          </span>}
                    {c.unread_count > 0 && <span className={s.badge}>{c.unread_count}</span>}
                </div>
            </div>
            <div className={s.convMenuWrap}>
                <button
                    className={s.convMenuBtn}
                    title="More options"
                    onClick={(e) => { e.stopPropagation(); onMenuToggle(c.id); }}
                >⋮</button>
                {convMenu === c.id && (
                    <div className={s.convMenuDropdown} onClick={(e) => e.stopPropagation()}>
                        <button onClick={() => onPin(c.id)}>
                            {c.is_pinned ? '📌 Unpin' : '📌 Pin chat'}
                        </button>
                        <button onClick={() => onFav(c.id)}>
                            {c.is_favourite ? '⭐ Unfavourite' : '⭐ Favourite'}
                        </button>
                        <button className={s.menuDanger} onClick={() => onDelete(c)}>
                            🗑️ Delete
                        </button>
                    </div>
                )}
            </div>
        </div>
    );
}

export default function ChatSidebar({
    conversations, activeConvId, search, setSearch, searchResults, searching,
    typingUsers, onlineUsers, convMenu, mobileView,
    onSearchUser, onOpenConv, onMenuToggle, onPinConv, onFavConv, onDeleteConv,
    onNewGroup, searchInputRef
}) {
    const totalUnread = conversations.reduce((sum, c) => sum + (c.unread_count || 0), 0);

    const pinned = conversations.filter(c => c.is_pinned);
    const favourites = conversations.filter(c => c.is_favourite && !c.is_pinned);
    const others = conversations.filter(c => !c.is_pinned && !c.is_favourite);

    const convProps = { activeConvId, typingUsers, onlineUsers, convMenu, onMenuToggle, onPin: onPinConv, onFav: onFavConv, onDelete: onDeleteConv };

    return (
        <div className={`${s.sidebar} ${mobileView === 'chat' ? s.hideMobile : ''}`}>
            <div className={s.sidebarHeader}>
                <h2>💬 Messages{totalUnread > 0 && <span className={s.totalBadge}>{totalUnread}</span>}</h2>
                <button className={s.newGroupBtn} onClick={onNewGroup} title="New group">👥+</button>
            </div>
            <div className={s.searchBox}>
                <svg className={s.searchIcon} width="14" height="14" viewBox="0 0 14 14" fill="none"><circle cx="6" cy="6" r="4.5" stroke="currentColor" strokeWidth="1.4"/><path d="M10 10l2.5 2.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/></svg>
                <input
                    ref={searchInputRef}
                    type="text"
                    placeholder="Search..."
                    value={search}
                    onChange={e => setSearch(e.target.value)}
                    className={s.searchInput}
                />
                {search && (
                    <button className={s.clearBtn} onClick={() => { setSearch(''); }}>✕</button>
                )}
            </div>

            {search.trim().length >= 2 && (
                <div className={s.searchResults}>
                    {searching && <div className={s.hint}>Searching...</div>}
                    {!searching && searchResults.length === 0 && <div className={s.hint}>No users found</div>}
                    {searchResults.map(u => (
                        <div key={u.id} className={s.searchItem} onClick={() => onSearchUser(u)}>
                            <ChatAvatar name={u.full_name} avatar={u.avatar} size="md" online={onlineUsers.has(u.id)} />
                            <div className={s.userInfo}>
                                <div className={s.userName}>{u.full_name}</div>
                                <div className={s.userMeta}>@{u.username}{u.email ? ` · ${u.email}` : ''}</div>
                            </div>
                        </div>
                    ))}
                </div>
            )}

            {!search && (
                <div className={s.convList}>
                    {conversations.length === 0 && (
                        <div className={s.empty}>No conversations yet. Search for a colleague to start chatting.</div>
                    )}
                    {pinned.length > 0 && (
                        <>
                            <div className={s.convSection}>📌 Pinned</div>
                            {pinned.map(c => <ConversationItem key={c.id} conv={c} onOpen={onOpenConv} {...convProps} />)}
                        </>
                    )}
                    {favourites.length > 0 && (
                        <>
                            <div className={s.convSection}>⭐ Favourites</div>
                            {favourites.map(c => <ConversationItem key={c.id} conv={c} onOpen={onOpenConv} {...convProps} />)}
                        </>
                    )}
                    {(pinned.length > 0 || favourites.length > 0) && others.length > 0 && (
                        <div className={s.convSection}>💬 All Messages</div>
                    )}
                    {others.map(c => <ConversationItem key={c.id} conv={c} onOpen={onOpenConv} {...convProps} />)}
                </div>
            )}
        </div>
    );
}

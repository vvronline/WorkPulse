import { Pin, Star, Users, UserPlus, X, Search, Phone, MessageSquare, Video, BellDot } from 'lucide-react';
import { useState } from 'react';
import { ChatAvatar } from '../../components/chat';
import { isUserOnline } from './chatUtils';
import ConversationItem from './ConversationItem';
import CallsTab from './CallsTab';
import s from './ChatSidebar.module.css';

export default function ChatSidebar({
    conversations, activeConvId, search, setSearch, searchResults, searching,
    typingUsers, onlineUsers, userStatusMap = {}, convMenu, mobileView, userId,
    loadingConvs,
    onSearchUser, onOpenConv, onMenuToggle, onPinConv, onFavConv, onDeleteConv,
    onNewGroup, searchInputRef
}) {
    const totalUnread = conversations.reduce((sum, c) => sum + (c.unread_count || 0), 0);
    const [sidebarTab, setSidebarTab] = useState('msgs');

    // Separate meeting conversations from regular ones
    const regularConvs = conversations.filter(c => !c.is_meeting_chat);
    const meetingConvs = conversations.filter(c => c.is_meeting_chat);
    const unreadConvs = conversations.filter(c => (c.unread_count || 0) > 0);

    const pinned = regularConvs.filter(c => c.is_pinned);
    const favourites = regularConvs.filter(c => c.is_favourite && !c.is_pinned);
    const others = regularConvs.filter(c => !c.is_pinned && !c.is_favourite);

    const convProps = { activeConvId, typingUsers, onlineUsers, userStatusMap, convMenu, onMenuToggle, onPin: onPinConv, onFav: onFavConv, onDelete: onDeleteConv };
    const [showSearch, setShowSearch] = useState(false);

    const openSearch = () => { setShowSearch(true); setTimeout(() => searchInputRef.current?.focus(), 50); };
    const closeSearch = () => { setShowSearch(false); setSearch(''); };

    const switchTab = (tab) => { setSidebarTab(tab); setShowSearch(false); setSearch(''); };

    return (
        <div className={`${s.sidebar} ${mobileView === 'chat' ? s.hideMobile : ''}`}>
            {/* ── Tabs ── */}
            <div className={s.sidebarTabs}>
                <button
                    className={`${s.tabBtn} ${sidebarTab === 'msgs' ? s.tabActive : ''}`}
                    onClick={() => switchTab('msgs')}
                >
                    <MessageSquare size={14} /> Messages
                    {totalUnread > 0 && <span className={s.totalBadge}>{totalUnread}</span>}
                </button>
                <button
                    className={`${s.tabBtn} ${sidebarTab === 'meetings' ? s.tabActive : ''}`}
                    onClick={() => switchTab('meetings')}
                >
                    <Video size={14} /> Meetings
                    {meetingConvs.some(c => c.unread_count > 0) && <span className={s.totalBadge}>{meetingConvs.reduce((s, c) => s + (c.unread_count || 0), 0)}</span>}
                </button>
                <button
                    className={`${s.tabBtn} ${sidebarTab === 'calls' ? s.tabActive : ''}`}
                    onClick={() => switchTab('calls')}
                >
                    <Phone size={14} /> Calls
                </button>
                <button
                    className={`${s.tabBtn} ${sidebarTab === 'unread' ? s.tabActive : ''}`}
                    onClick={() => switchTab('unread')}
                >
                    <BellDot size={14} /> Unread
                    {unreadConvs.length > 0 && <span className={s.totalBadge}>{unreadConvs.length}</span>}
                </button>
            </div>

            {/* ── Calls tab ── */}
            {sidebarTab === 'calls' && <CallsTab userId={userId} />}

            {/* ── Meetings tab ── */}
            {sidebarTab === 'meetings' && (
                <div className={s.convList}>
                    {meetingConvs.length === 0 ? (
                        <div className={s.empty}>
                            <Video size={32} strokeWidth={1.2} style={{ margin: '0 auto 0.5rem', display: 'block', opacity: 0.4 }} />
                            No meeting chats yet
                        </div>
                    ) : (
                        meetingConvs.map(c => <ConversationItem key={c.id} conv={c} onOpen={onOpenConv} {...convProps} />)
                    )}
                </div>
            )}

            {/* ── Unread tab ── */}
            {sidebarTab === 'unread' && (
                <div className={s.convList}>
                    {unreadConvs.length === 0 ? (
                        <div className={s.empty}>
                            <BellDot size={32} strokeWidth={1.2} style={{ margin: '0 auto 0.5rem', display: 'block', opacity: 0.4 }} />
                            You're all caught up!
                        </div>
                    ) : (
                        unreadConvs.map(c => <ConversationItem key={c.id} conv={c} onOpen={onOpenConv} {...convProps} />)
                    )}
                </div>
            )}

            {/* ── Messages tab ── */}
            {sidebarTab === 'msgs' && (<>
                {!showSearch ? (
                    <div className={s.sidebarHeader}>
                        <h2 style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}><MessageSquare size={18} /> Messages</h2>
                        <div className={s.headerBtns}>
                            <button className={s.newGroupBtn} onClick={openSearch} title="Search people"><Search size={16} /></button>
                            <button className={s.newGroupBtn} onClick={onNewGroup} title="New group" style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}><Users size={15} /><UserPlus size={13} /></button>
                        </div>
                    </div>
                ) : (
                    <div className={s.searchHeader}>
                        <svg className={s.searchIcon} width="14" height="14" viewBox="0 0 14 14" fill="none"><circle cx="6" cy="6" r="4.5" stroke="currentColor" strokeWidth="1.4"/><path d="M10 10l2.5 2.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/></svg>
                        <input
                            ref={searchInputRef}
                            type="text"
                            placeholder="Search people..."
                            value={search}
                            onChange={e => setSearch(e.target.value)}
                            className={s.searchInput}
                            autoFocus
                        />
                        <button className={s.searchCloseBtn} onClick={closeSearch}><X size={16} /></button>
                    </div>
                )}

                {search.trim().length >= 2 && (
                    <div className={s.searchResults}>
                        {searching && <div className={s.hint}>Searching...</div>}
                        {!searching && searchResults.length === 0 && <div className={s.hint}>No users found</div>}
                        {searchResults.map(u => (
                            <div key={u.id} className={s.searchItem} onClick={() => onSearchUser(u)}>
                                <ChatAvatar name={u.full_name} avatar={u.avatar} size="md" online={onlineUsers.has(u.id)} userStatus={userStatusMap[u.id]} />
                                <div className={s.userInfo}>
                                    <div className={s.userName}>{u.full_name}{u.id === userId ? ' (You)' : ''}</div>
                                    <div className={s.userMeta}>@{u.username}{u.id === userId ? ' · Message yourself' : u.email ? ` · ${u.email}` : ''}</div>
                                </div>
                            </div>
                        ))}
                    </div>
                )}

                {!search && (
                    <div className={s.convList}>
                        {loadingConvs ? (
                            <div className={s.convListLoading}>
                                <div className={s.convListSpinner} />
                                <span>Loading conversations…</span>
                            </div>
                        ) : regularConvs.length === 0 ? (
                            <div className={s.empty}>No conversations yet. Search for a colleague to start chatting.</div>
                        ) : (<>
                            <>
                                <div className={s.convSection}><Pin size={13} style={{marginRight:4,verticalAlign:'middle'}} />Pinned</div>
                                {pinned.map(c => <ConversationItem key={c.id} conv={c} onOpen={onOpenConv} {...convProps} />)}
                            </>
                        )}
                        {favourites.length > 0 && (
                            <>
                                <div className={s.convSection}><Star size={13} style={{marginRight:4,verticalAlign:'middle'}} />Favourites</div>
                                {favourites.map(c => <ConversationItem key={c.id} conv={c} onOpen={onOpenConv} {...convProps} />)}
                            </>
                        )}
                        {(pinned.length > 0 || favourites.length > 0) && others.length > 0 && (
                            <div className={s.convSection}><MessageSquare size={13} style={{marginRight:4,verticalAlign:'middle'}} />All Messages</div>
                        )}
                        {others.map(c => <ConversationItem key={c.id} conv={c} onOpen={onOpenConv} {...convProps} />)}
                        </>)}
                    </div>
                )}
            </>)}
        </div>
    );
}

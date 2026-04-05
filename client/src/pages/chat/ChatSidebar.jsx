import { Pin, Star, Users, UserPlus, X, Search, Phone, MessageSquare } from 'lucide-react';
import { useState } from 'react';
import { ChatAvatar } from '../../components/chat';
import { isUserOnline } from './chatUtils';
import ConversationItem from './ConversationItem';
import CallsTab from './CallsTab';
import s from './ChatSidebar.module.css';

export default function ChatSidebar({
    conversations, activeConvId, search, setSearch, searchResults, searching,
    typingUsers, onlineUsers, convMenu, mobileView, userId,
    onSearchUser, onOpenConv, onMenuToggle, onPinConv, onFavConv, onDeleteConv,
    onNewGroup, searchInputRef
}) {
    const totalUnread = conversations.reduce((sum, c) => sum + (c.unread_count || 0), 0);
    const [sidebarTab, setSidebarTab] = useState('msgs');

    const pinned = conversations.filter(c => c.is_pinned);
    const favourites = conversations.filter(c => c.is_favourite && !c.is_pinned);
    const others = conversations.filter(c => !c.is_pinned && !c.is_favourite);

    const convProps = { activeConvId, typingUsers, onlineUsers, convMenu, onMenuToggle, onPin: onPinConv, onFav: onFavConv, onDelete: onDeleteConv };
    const [showSearch, setShowSearch] = useState(false);

    const openSearch = () => { setShowSearch(true); setTimeout(() => searchInputRef.current?.focus(), 50); };
    const closeSearch = () => { setShowSearch(false); setSearch(''); };

    return (
        <div className={`${s.sidebar} ${mobileView === 'chat' ? s.hideMobile : ''}`}>
            {/* ── Tabs ── */}
            <div className={s.sidebarTabs}>
                <button
                    className={`${s.tabBtn} ${sidebarTab === 'msgs' ? s.tabActive : ''}`}
                    onClick={() => { setSidebarTab('msgs'); setShowSearch(false); setSearch(''); }}
                >
                    <MessageSquare size={14} /> Messages
                    {totalUnread > 0 && <span className={s.totalBadge}>{totalUnread}</span>}
                </button>
                <button
                    className={`${s.tabBtn} ${sidebarTab === 'calls' ? s.tabActive : ''}`}
                    onClick={() => { setSidebarTab('calls'); setShowSearch(false); setSearch(''); }}
                >
                    <Phone size={14} /> Calls
                </button>
            </div>

            {/* ── Calls tab ── */}
            {sidebarTab === 'calls' && <CallsTab userId={userId} />}

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
                    </div>
                )}
            </>)}
        </div>
    );
}

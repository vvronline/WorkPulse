import { Pin, Star, Users, Trash2, MessageSquare, UserPlus, X, Search, Phone, Video, PhoneIncoming, PhoneOutgoing, PhoneMissed } from 'lucide-react';
import { useState, useEffect } from 'react';
import { ChatAvatar } from '../../components/chat';
import { fmtTime, getConvName, getConvAvatar, isUserOnline } from './chatUtils';
import { getAllCallHistory } from '../../api';
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
                        {c.is_pinned && <Pin size={12} style={{ display: 'inline', verticalAlign: 'middle', marginRight: '3px' }} />}
                        {c.is_favourite && !c.is_pinned && <Star size={12} style={{ display: 'inline', verticalAlign: 'middle', marginRight: '3px' }} />}
                        {c.is_group && <Users size={12} style={{ display: 'inline', verticalAlign: 'middle', marginRight: '3px' }} />}
                        {getConvName(c)}
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
                                : c.last_file_url?.includes('voice') ? 'Voice message'
                                : c.last_file_url ? 'Attachment'
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
                        <button onClick={() => onPin(c.id)} style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                            <Pin size={13} /> {c.is_pinned ? 'Unpin' : 'Pin chat'}
                        </button>
                        <button onClick={() => onFav(c.id)} style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                            <Star size={13} /> {c.is_favourite ? 'Unfavourite' : 'Favourite'}
                        </button>
                        <button className={s.menuDanger} onClick={() => onDelete(c)} style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                            <Trash2 size={13} /> Delete
                        </button>
                    </div>
                )}
            </div>
        </div>
    );
}

function formatCallDuration(secs) {
    if (!secs) return null;
    const m = Math.floor(secs / 60), sec = secs % 60;
    return m === 0 ? `${sec}s` : `${m}m${sec > 0 ? ` ${sec}s` : ''}`;
}

function formatCallTime(iso) {
    const d = new Date(iso), now = new Date();
    const yesterday = new Date(now); yesterday.setDate(yesterday.getDate() - 1);
    const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    if (d.toDateString() === now.toDateString()) return time;
    if (d.toDateString() === yesterday.toDateString()) return `Yesterday, ${time}`;
    if (now - d < 7 * 86400000) return `${d.toLocaleDateString([], { weekday: 'short' })}, ${time}`;
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function CallsTab({ userId }) {
    const [calls, setCalls] = useState([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        setLoading(true);
        getAllCallHistory()
            .then(r => setCalls(r.data || []))
            .catch(() => setCalls([]))
            .finally(() => setLoading(false));
    }, []);

    if (loading) return <div className={s.callsEmpty}><div className={s.callsSpinner} /><span>Loading…</span></div>;
    if (calls.length === 0) return (
        <div className={s.callsEmpty}>
            <Phone size={32} strokeWidth={1.2} />
            <p>No calls yet</p>
        </div>
    );

    return (
        <div className={s.callsList}>
            {calls.map(call => {
                const isOutgoing = call.caller_id === userId;
                const isMissed = call.status === 'missed' && !isOutgoing;
                const otherName = isOutgoing
                    ? (call.other_name || 'Unknown')
                    : (call.caller_name || 'Unknown');
                const otherAvatar = isOutgoing ? call.other_avatar : call.caller_avatar;
                const displayName = call.is_group ? (call.group_name || 'Group') : otherName;

                return (
                    <div key={call.id} className={`${s.callItem} ${isMissed ? s.callItemMissed : ''}`}>
                        <div className={s.callAvatar}>
                            <ChatAvatar name={displayName} avatar={otherAvatar} size="md" />
                        </div>
                        <div className={s.callInfo}>
                            <div className={s.callName}>{displayName}</div>
                            <div className={s.callMeta}>
                                {isMissed
                                    ? <PhoneMissed size={13} className={s.iconMissed} />
                                    : isOutgoing
                                        ? <PhoneOutgoing size={13} className={s.iconOutgoing} />
                                        : <PhoneIncoming size={13} className={s.iconIncoming} />}
                                <span className={isMissed ? s.callMetaMissed : s.callMetaText}>
                                    {isMissed ? 'Missed' : isOutgoing ? 'Outgoing' : 'Incoming'}
                                    {call.call_type === 'video' ? ' video' : ''}
                                </span>
                                {call.duration > 0 && <span className={s.callDuration}>· {formatCallDuration(call.duration)}</span>}
                            </div>
                        </div>
                        <div className={s.callRight}>
                            <span className={s.callTime}>{formatCallTime(call.created_at)}</span>
                            <span className={s.callTypeIcon}>{call.call_type === 'video' ? <Video size={13} /> : <Phone size={13} />}</span>
                        </div>
                    </div>
                );
            })}
        </div>
    );
}

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

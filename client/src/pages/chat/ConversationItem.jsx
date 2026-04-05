import { Pin, Star, Users, Trash2 } from 'lucide-react';
import { ChatAvatar } from '../../components/chat';
import { fmtTime, getConvName, getConvAvatar, isUserOnline } from './chatUtils';
import s from './ChatSidebar.module.css';

export default function ConversationItem({ conv, activeConvId, typingUsers, onlineUsers, convMenu, onOpen, onMenuToggle, onPin, onFav, onDelete }) {
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

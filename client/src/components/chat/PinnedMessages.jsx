import { useState, useEffect } from 'react';
import { Pin, X } from 'lucide-react';
import { getPinnedMessages } from '../../api';
import ChatAvatar from './ChatAvatar';
import s from './PinnedMessages.module.css';

export default function PinnedMessages({ convId, currentUserId, onClose, onJumpTo, onUnpin }) {
    const [pins, setPins] = useState([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        let cancelled = false;
        getPinnedMessages(convId).then(r => {
            if (!cancelled) setPins(r.data);
        }).catch(() => {}).finally(() => { if (!cancelled) setLoading(false); });
        return () => { cancelled = true; };
    }, [convId]);

    return (
        <div className={s.panel}>
            <div className={s.header}>
                <span><Pin size={15} style={{verticalAlign:'middle',marginRight:5}} />Pinned Messages</span>
                <button className={s.closeBtn} onClick={onClose}><X size={15} /></button>
            </div>
            <div className={s.list}>
                {loading && <p className={s.empty}>Loading…</p>}
                {!loading && pins.length === 0 && <p className={s.empty}>No pinned messages</p>}
                {pins.map(p => (
                    <div key={p.id} className={s.item} onClick={() => onJumpTo?.(p.id)}>
                        <ChatAvatar name={p.sender_name} avatar={p.sender_avatar} size="sm" />
                        <div className={s.body}>
                            <span className={s.sender}>{p.sender_name}</span>
                            <span className={s.text}>{p.content || (p.file_name ? `📎 ${p.file_name}` : 'Voice message')}</span>
                            <span className={s.date}>{new Date(p.pinned_at).toLocaleDateString()}</span>
                        </div>
                        {onUnpin && (
                            <button className={s.unpinBtn} onClick={e => { e.stopPropagation(); onUnpin(p.id); }} title="Unpin"><X size={14} /></button>
                        )}
                    </div>
                ))}
            </div>
        </div>
    );
}

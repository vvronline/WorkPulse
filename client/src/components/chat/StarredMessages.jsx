import { useState, useEffect } from 'react';
import s from './StarredMessages.module.css';
import { getStarredMessages, toggleStar } from '../../api';

export default function StarredMessages({ onJumpTo, onClose }) {
    const [msgs, setMsgs] = useState([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        setLoading(true);
        getStarredMessages()
            .then(({ data }) => setMsgs(data))
            .catch(() => setMsgs([]))
            .finally(() => setLoading(false));
    }, []);

    const handleUnstar = async (msgId) => {
        try {
            await toggleStar(msgId);
            setMsgs(prev => prev.filter(m => m.id !== msgId));
        } catch { /* ignore */ }
    };

    return (
        <div className={s.panel}>
            <div className={s.header}>
                <h4>⭐ Saved Messages</h4>
                <button className={s.close} onClick={onClose}>✕</button>
            </div>
            <div className={s.list}>
                {loading && <div className={s.hint}>Loading...</div>}
                {!loading && msgs.length === 0 && <div className={s.hint}>No saved messages</div>}
                {msgs.map(m => (
                    <div key={m.id} className={s.item}>
                        <div className={s.itemHeader}>
                            <span className={s.sender}>{m.sender_name}</span>
                            <span className={s.date}>
                                {new Date(m.created_at).toLocaleDateString([], { month: 'short', day: 'numeric' })}
                            </span>
                        </div>
                        <div className={s.content}>
                            {m.content || (m.file_name ? `📎 ${m.file_name}` : 'Attachment')}
                        </div>
                        <div className={s.actions}>
                            <button
                                className={s.actionBtn}
                                onClick={() => onJumpTo?.(m.conversation_id, m.id)}
                            >Jump to</button>
                            <button
                                className={`${s.actionBtn} ${s.danger}`}
                                onClick={() => handleUnstar(m.id)}
                            >Remove</button>
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
}

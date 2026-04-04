import { useState } from 'react';
import { X } from 'lucide-react';
import { forwardMessage } from '../../api';
import ChatAvatar from './ChatAvatar';
import s from './ForwardModal.module.css';

export default function ForwardModal({ msgId, conversations, onClose, onSuccess }) {
    const [selected, setSelected] = useState([]);
    const [sending, setSending] = useState(false);

    const toggle = (id) => {
        setSelected(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
    };

    const send = async () => {
        if (selected.length === 0) return;
        setSending(true);
        try {
            await forwardMessage(msgId, selected);
            onSuccess?.();
            onClose();
        } catch { /* toast handled upstream */ }
        setSending(false);
    };

    return (
        <div className={s.overlay} onClick={(e) => e.target === e.currentTarget && onClose()}>
            <div className={s.modal}>
                <div className={s.header}>
                    <h3>Forward Message</h3>
                    <button className={s.closeBtn} onClick={onClose}><X size={16} /></button>
                </div>
                <div className={s.list}>
                    {conversations.map(c => {
                        const name = c.is_group ? c.group_name : c.other_full_name;
                        const checked = selected.includes(c.id);
                        return (
                            <label key={c.id} className={`${s.item} ${checked ? s.checked : ''}`}>
                                <input
                                    type="checkbox"
                                    checked={checked}
                                    onChange={() => toggle(c.id)}
                                    className={s.cb}
                                />
                                <ChatAvatar
                                    avatar={c.is_group ? null : c.other_avatar}
                                    name={name}
                                    size="sm"
                                />
                                <span className={s.name}>{name}</span>
                            </label>
                        );
                    })}
                </div>
                <div className={s.footer}>
                    <button className={s.sendBtn} disabled={selected.length === 0 || sending} onClick={send}>
                        Forward{selected.length > 0 ? ` (${selected.length})` : ''}
                    </button>
                </div>
            </div>
        </div>
    );
}

import { useState, useCallback } from 'react';
import { searchChatUsers, createGroup, updateGroup } from '../../api';
import ChatAvatar from './ChatAvatar';
import s from './GroupModal.module.css';

export default function GroupModal({ existingGroup, members: existingMembers, onClose, onSuccess }) {
    const isEdit = !!existingGroup;
    const [name, setName] = useState(existingGroup?.group_name || '');
    const [search, setSearch] = useState('');
    const [searchResults, setSearchResults] = useState([]);
    const [selected, setSelected] = useState(existingMembers || []);
    const [saving, setSaving] = useState(false);

    const doSearch = useCallback(async (q) => {
        if (!q || q.length < 2) { setSearchResults([]); return; }
        try {
            const { data } = await searchChatUsers(q);
            setSearchResults(data.filter(u => !selected.some(s => s.id === u.id)));
        } catch { setSearchResults([]); }
    }, [selected]);

    const addUser = (user) => {
        setSelected(prev => [...prev, user]);
        setSearchResults(prev => prev.filter(u => u.id !== user.id));
        setSearch('');
    };

    const removeUser = (userId) => {
        setSelected(prev => prev.filter(u => u.id !== userId));
    };

    const save = async () => {
        if (!name.trim() || selected.length < 1) return;
        setSaving(true);
        try {
            if (isEdit) {
                const existingIds = new Set((existingMembers || []).map(m => m.id));
                const currentIds = new Set(selected.map(m => m.id));
                const addUserIds = selected.filter(m => !existingIds.has(m.id)).map(m => m.id);
                const removeUserIds = (existingMembers || []).filter(m => !currentIds.has(m.id)).map(m => m.id);
                await updateGroup(existingGroup.id, { name: name.trim(), addUserIds, removeUserIds });
            } else {
                await createGroup(name.trim(), selected.map(u => u.id));
            }
            onSuccess?.();
            onClose();
        } catch { /* error handled upstream */ }
        setSaving(false);
    };

    return (
        <div className={s.overlay} onClick={(e) => e.target === e.currentTarget && onClose()}>
            <div className={s.modal}>
                <div className={s.header}>
                    <h3>{isEdit ? 'Edit Group' : 'New Group'}</h3>
                    <button className={s.closeBtn} onClick={onClose}>✕</button>
                </div>
                <div className={s.body}>
                    <input
                        className={s.input}
                        placeholder="Group name"
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        maxLength={100}
                    />
                    <input
                        className={s.input}
                        placeholder="Search users to add..."
                        value={search}
                        onChange={(e) => { setSearch(e.target.value); doSearch(e.target.value); }}
                    />
                    {searchResults.length > 0 && (
                        <div className={s.searchList}>
                            {searchResults.map(u => (
                                <button key={u.id} className={s.searchItem} onClick={() => addUser(u)}>
                                    <ChatAvatar avatar={u.avatar} name={u.full_name} size="sm" />
                                    <span>{u.full_name}</span>
                                </button>
                            ))}
                        </div>
                    )}
                    {selected.length > 0 && (
                        <div className={s.chips}>
                            {selected.map(u => (
                                <span key={u.id} className={s.chip}>
                                    {u.full_name}
                                    <button onClick={() => removeUser(u.id)}>✕</button>
                                </span>
                            ))}
                        </div>
                    )}
                </div>
                <div className={s.footer}>
                    <button className={s.saveBtn} disabled={!name.trim() || selected.length < 1 || saving} onClick={save}>
                        {isEdit ? 'Save' : 'Create Group'}
                    </button>
                </div>
            </div>
        </div>
    );
}

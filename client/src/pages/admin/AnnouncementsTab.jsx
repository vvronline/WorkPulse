import React, { useState, useEffect, useCallback } from 'react';
import { Megaphone } from 'lucide-react';
import { useAutoDismiss } from '../../hooks/useAutoDismiss';
import {
    getAdminAnnouncements, createAnnouncement, updateAnnouncement, deleteAnnouncement
} from '../../api';
import s from '../Admin.module.css';
import sf from './AdminForms.module.css';
import su from './AdminUtils.module.css';

const TYPES = [
    { value: 'info', label: 'Info', color: '#3b82f6' },
    { value: 'success', label: 'Success', color: '#10b981' },
    { value: 'warning', label: 'Warning', color: '#f59e0b' },
    { value: 'urgent', label: 'Urgent', color: '#ef4444' },
    { value: 'quote', label: 'Quote', color: '#38bdf8' },
];

const DURATIONS = [
    { value: '', label: 'No expiry' },
    { value: '1', label: '1 hour' },
    { value: '6', label: '6 hours' },
    { value: '12', label: '12 hours' },
    { value: '24', label: '1 day' },
    { value: '72', label: '3 days' },
    { value: '168', label: '1 week' },
    { value: '336', label: '2 weeks' },
    { value: '720', label: '1 month' },
];

const textareaStyle = {
    width: '100%',
    padding: '0.75rem 1rem',
    border: '1.5px solid var(--glass-border)',
    borderRadius: 12,
    fontSize: '0.9rem',
    fontFamily: 'inherit',
    background: 'var(--input-bg)',
    color: 'var(--text)',
    resize: 'vertical',
    minHeight: '4.5rem',
    lineHeight: 1.5,
    outline: 'none',
    transition: 'border-color 0.2s, box-shadow 0.2s',
};

const selectStyle = {
    padding: '0.6rem 2.2rem 0.6rem 0.85rem',
    border: '1.5px solid var(--glass-border)',
    borderRadius: 10,
    fontSize: '0.85rem',
    fontFamily: 'inherit',
    background: 'var(--input-bg)',
    color: 'var(--text)',
    outline: 'none',
    cursor: 'pointer',
    minWidth: 120,
    transition: 'border-color 0.2s, box-shadow 0.2s',
};

function TypeBadge({ type }) {
    const t = TYPES.find(x => x.value === type) || TYPES[0];
    return (
        <span style={{
            display: 'inline-block',
            padding: '0.15rem 0.55rem',
            borderRadius: 6,
            fontSize: '0.72rem',
            fontWeight: 700,
            textTransform: 'uppercase',
            letterSpacing: '0.04em',
            background: `${t.color}22`,
            color: t.color,
            border: `1px solid ${t.color}44`,
        }}>{t.label}</span>
    );
}

export default function AnnouncementsTab({ userRole }) {
    const [announcements, setAnnouncements] = useState([]);
    const [loading, setLoading] = useState(true);
    const [message, setMessage] = useState('');
    const [type, setType] = useState('info');
    const [duration, setDuration] = useState('');
    const [editId, setEditId] = useState(null);
    const [editMessage, setEditMessage] = useState('');
    const [editType, setEditType] = useState('info');
    const [editDuration, setEditDuration] = useState('');
    const [error, setError] = useAutoDismiss('');
    const [success, setSuccess] = useAutoDismiss('');

    const fetchAnnouncements = useCallback(async () => {
        try {
            const res = await getAdminAnnouncements();
            setAnnouncements(res.data.data);
        } catch { setError('Failed to load announcements'); }
        finally { setLoading(false); }
    }, []);

    useEffect(() => { fetchAnnouncements(); }, [fetchAnnouncements]);

    const handleCreate = async (e) => {
        e.preventDefault();
        if (!message.trim()) return;
        try {
            await createAnnouncement({ message, type, duration: duration || undefined });
            setMessage('');
            setType('info');
            setDuration('');
            setSuccess('Announcement created');
            fetchAnnouncements();
        } catch (err) {
            setError(err.response?.data?.error || 'Failed to create announcement');
        }
    };

    const startEdit = (a) => {
        setEditId(a.id);
        setEditMessage(a.message);
        setEditType(a.type);
        setEditDuration('');
    };

    const saveEdit = async () => {
        if (!editMessage.trim()) return;
        try {
            const payload = { message: editMessage, type: editType };
            if (editDuration) payload.duration = editDuration;
            await updateAnnouncement(editId, payload);
            setEditId(null);
            setSuccess('Announcement updated');
            fetchAnnouncements();
        } catch (err) {
            setError(err.response?.data?.error || 'Failed to update announcement');
        }
    };

    const toggleActive = async (a) => {
        try {
            await updateAnnouncement(a.id, { is_active: !a.is_active });
            setSuccess(a.is_active ? 'Announcement hidden' : 'Announcement shown');
            fetchAnnouncements();
        } catch {
            setError('Failed to update announcement');
        }
    };

    const handleDelete = async (id) => {
        if (!confirm('Delete this announcement permanently?')) return;
        try {
            await deleteAnnouncement(id);
            setSuccess('Announcement deleted');
            fetchAnnouncements();
        } catch {
            setError('Failed to delete announcement');
        }
    };

    if (loading) return <div className="loading-spinner"><div className="spinner" /></div>;

    return (
        <div className={s.section}>
            <h3 className={sf.sectionTitle}>
                <Megaphone size={15} style={{ marginRight: 6, verticalAlign: 'middle' }} />Announcements
            </h3>
            <p className={su['section-desc-muted']}>
                Create announcements and quotes to display on employees' dashboards. Use the "Quote" type for motivational quotes (shown with quote marks and author attribution from the message).
            </p>

            {error && <div className="error-msg error-msg-mb">{error}</div>}
            {success && <div className={`success-msg ${su['mb-1']}`}>{success}</div>}

            <form onSubmit={handleCreate} style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', marginBottom: '1.25rem' }}>
                <div className="form-group">
                    <label>Message</label>
                    <textarea
                        value={message}
                        onChange={e => setMessage(e.target.value)}
                        placeholder="Type an announcement message..."
                        maxLength={500}
                        rows={3}
                        required
                        style={textareaStyle}
                        onFocus={e => { e.target.style.borderColor = 'var(--primary)'; e.target.style.boxShadow = '0 0 0 3px var(--primary-glow)'; }}
                        onBlur={e => { e.target.style.borderColor = 'var(--glass-border)'; e.target.style.boxShadow = 'none'; }}
                    />
                </div>
                <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap' }}>
                    <div className="form-group" style={{ marginBottom: 0 }}>
                        <label>Type</label>
                        <select
                            value={type}
                            onChange={e => setType(e.target.value)}
                            style={selectStyle}
                            onFocus={e => { e.target.style.borderColor = 'var(--primary)'; e.target.style.boxShadow = '0 0 0 3px var(--primary-glow)'; }}
                            onBlur={e => { e.target.style.borderColor = 'var(--glass-border)'; e.target.style.boxShadow = 'none'; }}
                        >
                            {TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
                        </select>
                    </div>
                    <div className="form-group" style={{ marginBottom: 0 }}>
                        <label>Duration</label>
                        <select
                            value={duration}
                            onChange={e => setDuration(e.target.value)}
                            style={selectStyle}
                            onFocus={e => { e.target.style.borderColor = 'var(--primary)'; e.target.style.boxShadow = '0 0 0 3px var(--primary-glow)'; }}
                            onBlur={e => { e.target.style.borderColor = 'var(--glass-border)'; e.target.style.boxShadow = 'none'; }}
                        >
                            {DURATIONS.map(d => <option key={d.value} value={d.value}>{d.label}</option>)}
                        </select>
                    </div>
                    <button type="submit" className="btn btn-primary" disabled={!message.trim()} style={{ marginTop: '1.55rem' }}>
                        Add Announcement
                    </button>
                </div>
            </form>

            {announcements.length === 0 ? (
                <p style={{ color: 'var(--text-muted)', fontSize: '0.88rem', textAlign: 'center', padding: '1.5rem 0' }}>
                    No announcements yet. Create one above to display messages and quotes on employee dashboards.
                </p>
            ) : (
                <div className={su['overflow-auto']}>
                    <table className={s.table}>
                        <thead>
                            <tr>
                                <th>Message</th>
                                <th>Type</th>
                                <th>Status</th>
                                {userRole === 'platform_admin' && <th>Org</th>}
                                <th>Created By</th>
                                <th>Expires</th>
                                <th>Date</th>
                                <th>Actions</th>
                            </tr>
                        </thead>
                        <tbody>
                            {announcements.map(a => (
                                <tr key={a.id} style={{ opacity: a.is_active ? 1 : 0.5 }}>
                                    <td style={{ maxWidth: 320, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                                        {editId === a.id ? (
                                            <textarea
                                                value={editMessage}
                                                onChange={e => setEditMessage(e.target.value)}
                                                maxLength={500}
                                                rows={2}
                                                style={{ ...textareaStyle, minHeight: '3rem', padding: '0.5rem 0.75rem', fontSize: '0.85rem' }}
                                                onFocus={e => { e.target.style.borderColor = 'var(--primary)'; e.target.style.boxShadow = '0 0 0 3px var(--primary-glow)'; }}
                                                onBlur={e => { e.target.style.borderColor = 'var(--glass-border)'; e.target.style.boxShadow = 'none'; }}
                                            />
                                        ) : a.message}
                                    </td>
                                    <td>
                                        {editId === a.id ? (
                                            <select value={editType} onChange={e => setEditType(e.target.value)} style={{ ...selectStyle, fontSize: '0.8rem', padding: '0.45rem 2rem 0.45rem 0.65rem' }}>
                                                {TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
                                            </select>
                                        ) : <TypeBadge type={a.type} />}
                                    </td>
                                    <td>
                                        <span style={{
                                            fontSize: '0.75rem',
                                            fontWeight: 600,
                                            color: a.is_active ? 'var(--success, #10b981)' : 'var(--text-muted)',
                                        }}>
                                            {a.is_active ? 'Active' : 'Hidden'}
                                        </span>
                                    </td>
                                    {userRole === 'platform_admin' && (
                                        <td className={su['text-sm-muted']}>{a.org_name || 'Global'}</td>
                                    )}
                                    <td className={su['text-sm-muted']}>{a.created_by_name || '—'}</td>
                                    <td className={su['text-sm-muted']}>
                                        {editId === a.id ? (
                                            <select
                                                value={editDuration}
                                                onChange={e => setEditDuration(e.target.value)}
                                                style={{ ...selectStyle, fontSize: '0.8rem', padding: '0.45rem 2rem 0.45rem 0.65rem', minWidth: 100 }}
                                            >
                                                <option value="">Keep current</option>
                                                {DURATIONS.map(d => <option key={d.value} value={d.value}>{d.label}</option>)}
                                            </select>
                                        ) : a.expires_at ? (
                                            new Date(a.expires_at) < new Date()
                                                ? <span style={{ color: 'var(--danger, #ef4444)' }}>Expired</span>
                                                : new Date(a.expires_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
                                        ) : 'Never'}
                                    </td>
                                    <td className={su['text-sm-muted']}>
                                        {new Date(a.created_at).toLocaleDateString()}
                                    </td>
                                    <td>
                                        {editId === a.id ? (
                                            <div className={su['actions-row']}>
                                                <button className="btn btn-primary btn-sm" onClick={saveEdit}>Save</button>
                                                <button className="btn btn-secondary btn-sm" onClick={() => setEditId(null)}>Cancel</button>
                                            </div>
                                        ) : (
                                            <div className={su['actions-row']}>
                                                <button className="btn btn-secondary btn-sm" onClick={() => toggleActive(a)}>
                                                    {a.is_active ? 'Hide' : 'Show'}
                                                </button>
                                                <button className="btn btn-secondary btn-sm" onClick={() => startEdit(a)}>Edit</button>
                                                <button className="btn btn-danger btn-sm" onClick={() => handleDelete(a.id)}>Delete</button>
                                            </div>
                                        )}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
        </div>
    );
}

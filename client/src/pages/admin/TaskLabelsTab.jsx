import React, { useState, useEffect, useCallback } from 'react';
import { useAutoDismiss } from '../../hooks/useAutoDismiss';
import {
    getAdminTaskLabels, createAdminTaskLabel, updateAdminTaskLabel, deleteAdminTaskLabel
} from '../../api';
import s from '../Admin.module.css';
import tl from './TaskLabels.module.css';
import sf from './AdminForms.module.css';
import su from './AdminUtils.module.css';

const PRESET_COLORS = ['#6366f1', '#ef4444', '#f59e0b', '#10b981', '#3b82f6', '#8b5cf6', '#ec4899', '#14b8a6', '#f97316', '#64748b'];

export default function TaskLabelsTab() {
    const [labels, setLabels] = useState([]);
    const [loading, setLoading] = useState(true);
    const [name, setName] = useState('');
    const [color, setColor] = useState('#6366f1');
    const [editId, setEditId] = useState(null);
    const [editName, setEditName] = useState('');
    const [editColor, setEditColor] = useState('#6366f1');
    const [error, setError] = useAutoDismiss('');
    const [success, setSuccess] = useAutoDismiss('');

    const fetchLabels = useCallback(async () => {
        try {
            const res = await getAdminTaskLabels();
            setLabels(res.data);
        } catch { setError('Failed to load labels'); }
        finally { setLoading(false); }
    }, []);

    useEffect(() => { fetchLabels(); }, [fetchLabels]);

    const handleCreate = async (e) => {
        e.preventDefault();
        if (!name.trim()) return;
        try {
            await createAdminTaskLabel({ name, color });
            setName('');
            setColor('#6366f1');
            setSuccess('Label created');
            fetchLabels();
        } catch (err) {
            setError(err.response?.data?.error || 'Failed to create label');
        }
    };

    const startEdit = (label) => {
        setEditId(label.id);
        setEditName(label.name);
        setEditColor(label.color);
    };

    const saveEdit = async () => {
        if (!editName.trim()) return;
        try {
            await updateAdminTaskLabel(editId, { name: editName, color: editColor });
            setEditId(null);
            setSuccess('Label updated');
            fetchLabels();
        } catch (err) {
            setError(err.response?.data?.error || 'Failed to update label');
        }
    };

    const handleDelete = async (id) => {
        if (!confirm('Delete this label? It will be removed from all tasks.')) return;
        try {
            await deleteAdminTaskLabel(id);
            setSuccess('Label deleted');
            fetchLabels();
        } catch {
            setError('Failed to delete label');
        }
    };

    if (loading) return <div className="loading-spinner"><div className="spinner" /></div>;

    return (
        <div className={s.section}>
            <h3 className={sf.sectionTitle}>🏷️ Task Labels</h3>
            <p className={su['section-desc-muted']}>
                Create labels that members of your organization can use to categorize tasks.
            </p>

            {error && <div className="error-msg error-msg-mb">{error}</div>}
            {success && <div className={`success-msg ${su['mb-1']}`}>{success}</div>}

            <form onSubmit={handleCreate} className={tl['label-form']}>
                <div className={`form-group ${tl['label-form-group']}`}>
                    <label>Label Name</label>
                    <input
                        type="text"
                        value={name}
                        onChange={e => setName(e.target.value)}
                        placeholder="e.g. Bug, Feature, Urgent"
                        maxLength={30}
                        required
                    />
                </div>
                <div className={`form-group ${tl['form-group-compact']}`}>
                    <label>Color</label>
                    <div className={tl['color-picker-row']}>
                        {PRESET_COLORS.map(c => (
                            <button
                                key={c}
                                type="button"
                                onClick={() => setColor(c)}
                                className={tl['color-swatch']}
                                style={{
                                    border: color === c ? '2px solid var(--text)' : '2px solid transparent',
                                    background: c
                                }}
                            />
                        ))}
                        <input type="color" value={color} onChange={e => setColor(e.target.value)} className={tl['color-input']} />
                    </div>
                </div>
                <button type="submit" className={`btn btn-primary ${tl['btn-add-label']}`}>
                    Add Label
                </button>
            </form>

            {labels.length === 0 ? (
                <p className={tl['empty-message']}>No labels yet. Create one above!</p>
            ) : (
                <div className={su['overflow-auto']}>
                    <table className={s.table}>
                        <thead>
                            <tr>
                                <th>Label</th>
                                <th>Created By</th>
                                <th className={tl['col-actions']}>Actions</th>
                            </tr>
                        </thead>
                        <tbody>
                            {labels.map(label => (
                                <tr key={label.id}>
                                    <td>
                                        {editId === label.id ? (
                                            <div className={tl['edit-label-row']}>
                                                <input
                                                    type="text"
                                                    value={editName}
                                                    onChange={e => setEditName(e.target.value)}
                                                    maxLength={30}
                                                    className={tl['edit-label-input']}
                                                />
                                                <input type="color" value={editColor} onChange={e => setEditColor(e.target.value)} className={tl['color-input']} />
                                            </div>
                                        ) : (
                                            <span className={tl['label-display']}>
                                                <span className={tl['label-badge']} style={{ background: label.color }}>{label.name}</span>
                                            </span>
                                        )}
                                    </td>
                                    <td className={su['text-sm-muted']}>{label.created_by_username || '—'}</td>
                                    <td>
                                        {editId === label.id ? (
                                            <div className={su['actions-row']}>
                                                <button className="btn btn-primary btn-sm" onClick={saveEdit}>Save</button>
                                                <button className="btn btn-secondary btn-sm" onClick={() => setEditId(null)}>Cancel</button>
                                            </div>
                                        ) : (
                                            <div className={su['actions-row']}>
                                                <button className="btn btn-secondary btn-sm" onClick={() => startEdit(label)}>Edit</button>
                                                <button className="btn btn-danger btn-sm" onClick={() => handleDelete(label.id)}>Delete</button>
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

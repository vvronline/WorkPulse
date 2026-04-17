import React, { useState, useEffect } from 'react';
import { getAdminAnnouncements, createAnnouncement, updateAnnouncement, deleteAnnouncement } from '../../api';
import { Loader2, X, Megaphone, Trash2, ToggleLeft, ToggleRight } from 'lucide-react';
import ConfirmDialog from '../../components/common/ConfirmDialog';
import s from './Tenants.module.css';

export default function PlatformSettings() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  // Announcements
  const [announcements, setAnnouncements] = useState([]);
  const [newMsg, setNewMsg] = useState('');
  const [newType, setNewType] = useState('info');
  const [newDuration, setNewDuration] = useState('');
  const [deleteModal, setDeleteModal] = useState({ open: false, id: null });

  useEffect(() => {
    getAdminAnnouncements()
      .then(r => setAnnouncements(Array.isArray(r.data) ? r.data : []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const handleCreateAnnouncement = async () => {
    if (!newMsg.trim()) return;
    setError(''); setSuccess('');
    try {
      await createAnnouncement({ message: newMsg.trim(), type: newType, duration: newDuration || null });
      setNewMsg('');
      setNewType('info');
      setNewDuration('');
      const res = await getAdminAnnouncements();
      setAnnouncements(res.data);
      setSuccess('Announcement created');
    } catch (e) {
      setError(e.response?.data?.error || 'Failed');
    }
  };

  const handleToggleAnnouncement = async (ann) => {
    try {
      await updateAnnouncement(ann.id, { is_active: !ann.is_active });
      const res = await getAdminAnnouncements();
      setAnnouncements(res.data);
    } catch (e) {
      setError(e.response?.data?.error || 'Failed');
    }
  };

  const handleDeleteAnnouncement = async () => {
    const { id } = deleteModal;
    setDeleteModal({ open: false, id: null });
    try {
      await deleteAnnouncement(id);
      const res = await getAdminAnnouncements();
      setAnnouncements(res.data);
    } catch (e) {
      setError(e.response?.data?.error || 'Failed');
    }
  };

  if (loading) return <div className={s.loading}><Loader2 size={20} className={s.spinner} /> Loading…</div>;

  return (
    <div>
      {error && (
        <div className={s.errorBanner}>
          <span className={s.errorText}>{error}</span>
          <button onClick={() => setError('')} className={s.errorClose}><X size={16} /></button>
        </div>
      )}
      {success && (
        <div className={s.successBanner}>
          <span>{success}</span>
          <button onClick={() => setSuccess('')} className={s.errorClose} style={{ color: 'var(--success)' }}><X size={16} /></button>
        </div>
      )}

      {/* Global Announcements */}
      <fieldset className={s.fieldset}>
        <legend className={s.legend}>Global Announcements</legend>
        <p style={{ color: 'var(--text-secondary)', fontSize: 13, margin: '0 0 12px' }}>
          Announcements visible to all tenants across the platform.
        </p>

        {/* Create form */}
        <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
          <input value={newMsg} onChange={e => setNewMsg(e.target.value)} placeholder="Announcement message…"
            className={s.input} style={{ flex: 1, minWidth: 200 }} />
          <select value={newType} onChange={e => setNewType(e.target.value)} className={s.statusSelect} style={{ minWidth: 100 }}>
            <option value="info">Info</option>
            <option value="success">Success</option>
            <option value="warning">Warning</option>
            <option value="urgent">Urgent</option>
          </select>
          <select value={newDuration} onChange={e => setNewDuration(e.target.value)} className={s.statusSelect} style={{ minWidth: 120 }}>
            <option value="">No expiry</option>
            <option value="1">1 hour</option>
            <option value="6">6 hours</option>
            <option value="24">1 day</option>
            <option value="168">1 week</option>
          </select>
          <button className={s.btnPrimary} onClick={handleCreateAnnouncement}>
            <Megaphone size={14} /> Post
          </button>
        </div>

        {/* List */}
        {announcements.length === 0 ? (
          <div className={s.emptyMsg}>No announcements</div>
        ) : (
          <table className={s.table}>
            <thead>
              <tr><th>Message</th><th>Type</th><th>Active</th><th>Created</th><th>Actions</th></tr>
            </thead>
            <tbody>
              {announcements.map(a => (
                <tr key={a.id}>
                  <td>{a.message}</td>
                  <td><span className={s.badgeRole}>{a.type}</span></td>
                  <td>{a.is_active ? <span className={s.badgeActive}>yes</span> : <span className={s.badgeInactive}>no</span>}</td>
                  <td className={s.cellSecondary}>{new Date(a.created_at).toLocaleDateString()}</td>
                  <td>
                    <div style={{ display: 'flex', gap: 4 }}>
                      <button className={s.btnSmall} onClick={() => handleToggleAnnouncement(a)} title={a.is_active ? 'Disable' : 'Enable'}>
                        {a.is_active ? <ToggleRight size={14} /> : <ToggleLeft size={14} />}
                      </button>
                      <button className={s.btnSmall} style={{ color: 'var(--danger)' }} onClick={() => setDeleteModal({ open: true, id: a.id })}>
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </fieldset>

      <ConfirmDialog
        isOpen={deleteModal.open}
        title="Delete Announcement"
        message="Are you sure you want to delete this announcement?"
        confirmText="Delete"
        cancelText="Cancel"
        isDanger
        onConfirm={handleDeleteAnnouncement}
        onCancel={() => setDeleteModal({ open: false, id: null })}
      />
    </div>
  );
}

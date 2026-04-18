import React, { useState, useEffect, useCallback } from 'react';
import {
  getTenants, getTenantOverview, suspendTenant, reactivateTenant,
  deleteTenantApi, impersonateTenant,
} from '../../api';
import {
  Building2, Plus, Pause, Play, Trash2, Users, Shield, X, Search, Calendar, Loader2,
} from 'lucide-react';
import ConfirmDialog from '../../components/common/ConfirmDialog';
import s from './Tenants.module.css';

const STATUS_COLORS = {
  active:    { bg: 'color-mix(in srgb, var(--success) 14%, transparent)', fg: 'var(--success)' },
  suspended: { bg: 'color-mix(in srgb, var(--warning) 14%, transparent)', fg: 'var(--warning)' },
  deleted:   { bg: 'color-mix(in srgb, var(--danger) 14%, transparent)',  fg: 'var(--danger)' },
};

function Badge({ status }) {
  const c = STATUS_COLORS[status] || STATUS_COLORS.active;
  return <span className={s.badge} style={{ background: c.bg, color: c.fg }}>{status}</span>;
}

function Stat({ icon: Icon, value, label, accent }) {
  return (
    <div className={s.stat}>
      <div className={`${s.statIcon} ${accent ? s.statIconAccent : s.statIconDefault}`}>
        <Icon size={18} />
      </div>
      <div>
        <div className={s.statValue}>{value}</div>
        <div className={s.statLabel}>{label}</div>
      </div>
    </div>
  );
}

export default function TenantList({ onSelectTenant }) {
  const [tenants, setTenants] = useState([]);
  const [overview, setOverview] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');

  const [suspendModal, setSuspendModal] = useState({ open: false, id: null });
  const [suspendReason, setSuspendReason] = useState('');
  const [deleteModal, setDeleteModal] = useState({ open: false, id: null, name: '' });

  useEffect(() => {
    const id = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(id);
  }, [search]);

  const loadTenants = useCallback(async () => {
    try {
      const params = {};
      if (debouncedSearch) params.search = debouncedSearch;
      if (statusFilter) params.status = statusFilter;
      const [tenantsRes, overviewRes] = await Promise.all([
        getTenants(params),
        getTenantOverview(),
      ]);
      setTenants(tenantsRes.data.tenants);
      setOverview(overviewRes.data);
    } catch (e) {
      setError(e.response?.data?.error || 'Failed to load tenants');
    } finally {
      setLoading(false);
    }
  }, [debouncedSearch, statusFilter]);

  useEffect(() => { loadTenants(); }, [loadTenants]);

  const handleSuspend = async () => {
    const { id } = suspendModal;
    setSuspendModal({ open: false, id: null });
    try { await suspendTenant(id, suspendReason); loadTenants(); }
    catch (e) { setError(e.response?.data?.error || 'Failed to suspend'); }
  };

  const handleReactivate = async (id) => {
    try { await reactivateTenant(id); loadTenants(); }
    catch (e) { setError(e.response?.data?.error || 'Failed to reactivate'); }
  };

  const handleDelete = async () => {
    const { id } = deleteModal;
    setDeleteModal({ open: false, id: null, name: '' });
    try { await deleteTenantApi(id, false); loadTenants(); }
    catch (e) { setError(e.response?.data?.error || 'Failed to delete'); }
  };

  const handleImpersonate = async (id) => {
    try {
      await impersonateTenant(id);
      // Server sets the impersonation cookie (HttpOnly) and saves the original token
      window.location.href = '/';
    } catch (e) { setError(e.response?.data?.error || 'Failed to impersonate'); }
  };

  if (loading) return <div className={s.loading}><Loader2 size={20} className={s.spinner} /> Loading tenants…</div>;

  return (
    <div>
      {error && (
        <div className={s.errorBanner}>
          <span className={s.errorText}>{error}</span>
          <button onClick={() => setError('')} className={s.errorClose}><X size={16} /></button>
        </div>
      )}

      {overview && (
        <div className={s.overviewStats}>
          <Stat icon={Building2} value={overview.total_tenants} label="Tenants" accent />
          <Stat icon={Users} value={overview.total_users} label="Total Users" />
          <Stat icon={Play} value={overview.by_status?.active || 0} label="Active" />
          <Stat icon={Pause} value={overview.by_status?.suspended || 0} label="Suspended" />
        </div>
      )}

      <div className={s.toolbar}>
        <div className={s.searchWrap}>
          <Search size={15} className={s.searchIcon} />
          <input
            type="text" placeholder="Search tenants…" value={search}
            onChange={e => setSearch(e.target.value)}
            className={s.searchInput}
          />
        </div>
        <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)} className={s.statusSelect}>
          <option value="">All Status</option>
          <option value="active">Active</option>
          <option value="suspended">Suspended</option>
          <option value="deleted">Deleted</option>
        </select>
      </div>

      {tenants.length === 0 ? (
        <div className={s.emptyState}>No tenants found</div>
      ) : (
        <div className={s.tenantGrid}>
          {tenants.map(t => (
            <div key={t.id} className={s.tenantCard} onClick={() => onSelectTenant(t.id)}>
              <div className={s.cardHeader}>
                <div>
                  <div className={s.cardOrgName}>
                    <Building2 size={16} className={s.iconAccent} />
                    {t.org_name}
                  </div>
                  <div className={s.cardSlug}>{t.slug}</div>
                </div>
                <Badge status={t.status} />
              </div>
              <div className={s.cardStats}>
                <div className={s.cardStat}><Users size={14} /> <strong>{t.user_count || 0}</strong> users</div>
                <div className={s.cardStat}><Calendar size={14} /> {new Date(t.created_at).toLocaleDateString()}</div>
              </div>
              <div className={s.cardActions} onClick={e => e.stopPropagation()}>
                {t.status === 'active' && (
                  <button className={s.btnSmall} onClick={() => handleImpersonate(t.id)} title="Enter as tenant admin">
                    <Shield size={13} /> Enter Tenant
                  </button>
                )}
                {t.status === 'active' && (
                  <button className={s.btnSmall} style={{ color: 'var(--warning)' }}
                    onClick={() => { setSuspendReason(''); setSuspendModal({ open: true, id: t.id }); }}>
                    <Pause size={13} /> Suspend
                  </button>
                )}
                {t.status === 'suspended' && (
                  <button className={s.btnSmall} style={{ color: 'var(--success)' }}
                    onClick={() => handleReactivate(t.id)}>
                    <Play size={13} /> Reactivate
                  </button>
                )}
                <button className={s.btnSmall} style={{ color: 'var(--danger)' }}
                  onClick={() => setDeleteModal({ open: true, id: t.id, name: t.org_name })}>
                  <Trash2 size={13} /> Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Suspend dialog */}
      <ConfirmDialog
        isOpen={suspendModal.open}
        title="Suspend Tenant"
        message={
          <div>
            <p style={{ margin: '0 0 10px' }}>Provide a reason for suspending this tenant:</p>
            <input
              value={suspendReason}
              onChange={e => setSuspendReason(e.target.value)}
              placeholder="Suspension reason…"
              className={s.input}
              style={{ width: '100%' }}
              onKeyDown={e => { if (e.key === 'Enter' && suspendReason.trim()) handleSuspend(); }}
            />
          </div>
        }
        confirmText="Suspend"
        cancelText="Cancel"
        onConfirm={() => { if (suspendReason.trim()) handleSuspend(); }}
        onCancel={() => setSuspendModal({ open: false, id: null })}
      />

      {/* Delete dialog */}
      <ConfirmDialog
        isOpen={deleteModal.open}
        title="Delete Tenant"
        message={`Are you sure you want to delete "${deleteModal.name}"? This marks the tenant as deleted.`}
        confirmText="Delete"
        cancelText="Cancel"
        isDanger
        onConfirm={handleDelete}
        onCancel={() => setDeleteModal({ open: false, id: null, name: '' })}
      />
    </div>
  );
}

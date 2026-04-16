import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  getTenants, getTenantOverview, createTenant, suspendTenant, reactivateTenant,
  deleteTenantApi, getTenantStats, getTenantUsers, impersonateTenant,
  updateTenantDomain, updateTenantLimits,
  getAdminOrganizations, updateAdminOrganization,
} from '../../api';
import {
  Building2, Plus, Pause, Play, Trash2, Users, Shield, X, ChevronRight, ChevronDown,
  Search, Globe, Database, HardDrive, Building, UsersRound, GitBranch, Pencil,
  BarChart3, ExternalLink, Clock, Calendar, Settings2, Loader2, AlertTriangle,
} from 'lucide-react';
import Departments from '../../components/organization/Departments';
import Teams from '../../components/organization/Teams';
import OrgChartView from '../../components/organization/OrgChartView';
import ConfirmDialog from '../../components/common/ConfirmDialog';
import OrgModal from './OrgModal';
import s from './AdminPages.module.css';
import as from '../Admin.module.css';
import css from './TenantManagement.module.css';

/* ─── status badge colours ─── */
const STATUS = {
  active:    { bg: 'color-mix(in srgb, var(--success) 14%, transparent)', fg: 'var(--success)' },
  suspended: { bg: 'color-mix(in srgb, var(--warning) 14%, transparent)', fg: 'var(--warning)' },
  deleted:   { bg: 'color-mix(in srgb, var(--danger) 14%, transparent)',  fg: 'var(--danger)' },
};

function Badge({ status }) {
  const c = STATUS[status] || STATUS.active;
  return (
    <span className={css.badge} style={{ background: c.bg, color: c.fg }}>
      {status}
    </span>
  );
}

/* ─── stat mini-card ─── */
function Stat({ icon: Icon, value, label, accent }) {
  return (
    <div className={css.stat}>
      <div className={`${css.statIcon} ${accent ? css.statIconAccent : css.statIconDefault}`}>
        <Icon size={18} />
      </div>
      <div>
        <div className={css.statValue}>{value}</div>
        <div className={css.statLabel}>{label}</div>
      </div>
    </div>
  );
}

/* ================================================================ */
/*  MAIN COMPONENT                                                  */
/* ================================================================ */
export default function TenantManagement() {
  const [tenants, setTenants] = useState([]);
  const [overview, setOverview] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');

  /* detail panel */
  const [expanded, setExpanded] = useState(null);   // tenant id
  const [detailTab, setDetailTab] = useState('overview');
  const [stats, setStats] = useState(null);
  const [users, setUsers] = useState([]);
  const [orgs, setOrgs] = useState([]);

  /* create / edit */
  const [showCreate, setShowCreate] = useState(false);
  const [editingOrg, setEditingOrg] = useState(null);
  const [debouncedSearch, setDebouncedSearch] = useState(search);

  /* confirmation modals */
  const [suspendModal, setSuspendModal] = useState({ open: false, id: null });
  const [suspendReason, setSuspendReason] = useState('');
  const [deleteModal, setDeleteModal] = useState({ open: false, id: null, name: '' });

  /* loading state for expand panel */
  const [detailLoading, setDetailLoading] = useState(false);

  /* ── debounce search input ── */
  useEffect(() => {
    const id = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(id);
  }, [search]);

  /* ── loaders ── */
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

  const loadOrgs = useCallback(async () => {
    try {
      const res = await getAdminOrganizations();
      setOrgs(res.data.data || res.data);
    } catch {}
  }, []);

  useEffect(() => { loadTenants(); loadOrgs(); }, [loadTenants, loadOrgs]);

  /* ── expand tenant row ── */
  const expandIdRef = useRef(null);
  const toggleExpand = async (tenant) => {
    if (expanded === tenant.id) { setExpanded(null); expandIdRef.current = null; return; }
    const thisId = tenant.id;
    expandIdRef.current = thisId;
    setExpanded(thisId);
    setDetailTab('overview');
    setStats(null);
    setUsers([]);
    setDetailLoading(true);
    // Load independently; guard against stale responses from a previously expanded tenant
    const p1 = getTenantStats(thisId).then(r => { if (expandIdRef.current === thisId) setStats(r.data); }).catch(() => { if (expandIdRef.current === thisId) setStats(null); });
    const p2 = getTenantUsers(thisId).then(r => { if (expandIdRef.current === thisId) setUsers(r.data.users); }).catch(() => { if (expandIdRef.current === thisId) setUsers([]); });
    Promise.allSettled([p1, p2]).then(() => { if (expandIdRef.current === thisId) setDetailLoading(false); });
  };

  /* ── actions ── */
  const handleCreate = async (data) => {
    try {
      await createTenant(data);
      setShowCreate(false);
      loadTenants();
      loadOrgs();
    } catch (e) { setError(e.response?.data?.error || 'Failed to create tenant'); }
  };

  const openSuspendModal = (id) => {
    setSuspendReason('');
    setSuspendModal({ open: true, id });
  };

  const confirmSuspend = async () => {
    const { id } = suspendModal;
    setSuspendModal({ open: false, id: null });
    try {
      await suspendTenant(id, suspendReason);
      loadTenants();
      if (expanded === id) setExpanded(null);
    } catch (e) { setError(e.response?.data?.error || 'Failed to suspend'); }
  };

  const handleReactivate = async (id) => {
    try { await reactivateTenant(id); loadTenants(); }
    catch (e) { setError(e.response?.data?.error || 'Failed to reactivate'); }
  };

  const openDeleteModal = (id, name) => {
    setDeleteModal({ open: true, id, name });
  };

  const confirmDelete = async () => {
    const { id } = deleteModal;
    setDeleteModal({ open: false, id: null, name: '' });
    try {
      await deleteTenantApi(id, false);
      loadTenants();
      if (expanded === id) setExpanded(null);
    } catch (e) { setError(e.response?.data?.error || 'Failed to delete'); }
  };

  const handleImpersonate = async (id) => {
    try {
      const { data } = await impersonateTenant(id);
      // Preserve only the auth token, not all cookies
      const currentToken = document.cookie.split('; ').find(c => c.startsWith('token='));
      if (currentToken) localStorage.setItem('_wp_orig_token', currentToken.split('=')[1]);
      const secure = location.protocol === 'https:' ? ';secure' : '';
      document.cookie = `token=${data.token};path=/;samesite=strict${secure}`;
      window.location.reload();
    } catch (e) { setError(e.response?.data?.error || 'Failed to impersonate'); }
  };

  const handleOrgUpdate = async (id, data) => {
    try {
      await updateAdminOrganization(id, data);
      setEditingOrg(null);
      loadOrgs();
      loadTenants();
    } catch (e) { setError(e.response?.data?.error || 'Failed to update org'); }
  };

  /* ── match tenant → org for org-level data ── */
  const getOrgForTenant = (tenant) => orgs.find(o => o.slug === tenant.slug || o.name === tenant.org_name);

  if (loading) return <div className={css.loading}>Loading tenants…</div>;

  return (
    <div>
      {/* ── error banner ── */}
      {error && (
        <div className={css.errorBanner}>
          <span className={css.errorText}>{error}</span>
          <button onClick={() => setError('')} className={css.errorClose}><X size={16} /></button>
        </div>
      )}

      {/* ── overview stats ── */}
      {overview && (
        <div className={css.overviewStats}>
          <Stat icon={Building2} value={overview.total_tenants} label="Tenants" accent />
          <Stat icon={Users} value={overview.total_users} label="Total Users" />
          <Stat icon={Play} value={overview.by_status?.active || 0} label="Active" />
          <Stat icon={Pause} value={overview.by_status?.suspended || 0} label="Suspended" />
        </div>
      )}

      {/* ── toolbar ── */}
      <div className={css.toolbar}>
        <div className={css.searchWrap}>
          <Search size={15} className={css.searchIcon} />
          <input
            type="text" placeholder="Search tenants…" value={search}
            onChange={e => setSearch(e.target.value)}
            className={css.searchInput}
          />
        </div>
        <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)} className={css.statusSelect}>
          <option value="">All Status</option>
          <option value="active">Active</option>
          <option value="suspended">Suspended</option>
          <option value="deleted">Deleted</option>
        </select>
        <button onClick={() => setShowCreate(true)} className={css.newTenantBtn}>
          <Plus size={15} /> New Tenant
        </button>
      </div>

      {/* ── create form ── */}
      {showCreate && <CreateTenantForm onSubmit={handleCreate} onCancel={() => setShowCreate(false)} />}

      {/* ── tenant list ── */}
      <div className={css.tenantList}>
        {/* header */}
        <div className={css.listHeader}>
          <span>Organization</span>
          <span>Slug</span>
          <span>Users</span>
          <span>Status</span>
          <span className={css.listHeaderActions}>Actions</span>
        </div>

        {tenants.length === 0 && (
          <div className={css.emptyState}>
            No tenants found
          </div>
        )}

        {tenants.map((t, idx) => {
          const isExpanded = expanded === t.id;
          const isLast = idx === tenants.length - 1;
          const org = getOrgForTenant(t);

          return (
            <div key={t.id} className={`${css.tenantItem} ${isLast && !isExpanded ? css.tenantItemLast : ''}`}>
              {/* ── row ── */}
              <div
                onClick={() => toggleExpand(t)}
                className={`${css.tenantRow} ${isExpanded ? css.tenantRowExpanded : ''}`}
              >
                <span className={css.orgName}>
                  {isExpanded ? <ChevronDown size={16} className={css.iconAccent} />
                              : <ChevronRight size={16} className={css.iconMuted} />}
                  <Building2 size={16} className={css.iconAccent} />
                  <span className={css.orgNameText}>{t.org_name}</span>
                </span>
                <span className={css.slug}>{t.slug}</span>
                <span className={css.userCount}>{t.user_count || 0}</span>
                <Badge status={t.status} />
                <div onClick={e => e.stopPropagation()} className={css.actions}>
                  {t.status === 'active' && (
                    <ActionBtn icon={Shield} label="Impersonate" onClick={() => handleImpersonate(t.id)} />
                  )}
                  {t.status === 'active' && (
                    <ActionBtn icon={Pause} label="Suspend" onClick={() => openSuspendModal(t.id)} color="var(--warning)" />
                  )}
                  {t.status === 'suspended' && (
                    <ActionBtn icon={Play} label="Reactivate" onClick={() => handleReactivate(t.id)} color="var(--success)" />
                  )}
                  <ActionBtn icon={Trash2} label="Delete" onClick={() => openDeleteModal(t.id, t.org_name)} color="var(--danger)" />
                </div>
              </div>

              {/* ── expanded detail ── */}
              {isExpanded && (
                <div className={`${css.expandedPanel} ${isLast ? css.expandedPanelLast : ''}`}>
                  {/* loading spinner */}
                  {detailLoading && (
                    <div className={css.detailLoading}>
                      <Loader2 size={20} className={css.spinner} /> Loading tenant data…
                    </div>
                  )}

                  {/* detail tabs */}
                  <div className={css.detailTabs}>
                    {[
                      { key: 'overview', label: 'Overview', icon: BarChart3 },
                      { key: 'users', label: `Users (${users.length})`, icon: Users },
                      { key: 'departments', label: 'Departments', icon: Building },
                      { key: 'teams', label: 'Teams', icon: UsersRound },
                      { key: 'chart', label: 'Org Chart', icon: GitBranch },
                      { key: 'settings', label: 'Settings', icon: Settings2 },
                    ].map(({ key, label, icon: Icon }) => (
                      <button key={key} onClick={() => setDetailTab(key)}
                        className={`${css.detailTab} ${detailTab === key ? css.detailTabActive : ''}`}>
                        <Icon size={14} /> {label}
                      </button>
                    ))}
                  </div>

                  {/* overview */}
                  {detailTab === 'overview' && (
                    <div className={css.overviewGrid}>
                      <InfoCard icon={Globe} label="Custom Domain" value={t.custom_domain || 'None'} />
                      <InfoCard icon={Database} label="Database" value={t.db_name || '—'} />
                      <InfoCard icon={Users} label="Max Users" value={t.max_users || '∞'} />
                      <InfoCard icon={HardDrive} label="Max Storage" value={t.max_storage_mb ? `${t.max_storage_mb} MB` : '∞'} />
                      {stats && <>
                        <InfoCard icon={BarChart3} label="Tasks" value={stats.task_count} />
                        <InfoCard icon={ExternalLink} label="Messages" value={stats.message_count} />
                        <InfoCard icon={Database} label="DB Size" value={`${(stats.db_size_bytes / 1024 / 1024).toFixed(1)} MB`} />
                      </>}
                      {org && <>
                        <InfoCard icon={Clock} label="Work Hours" value={`${org.work_hours_per_day || 8}h / day`} />
                        <InfoCard icon={Calendar} label="Work Days" value={formatWorkDays(org.work_days)} />
                        <InfoCard icon={Globe} label="Timezone" value={org.timezone || 'UTC'} />
                      </>}
                    </div>
                  )}

                  {/* users list */}
                  {detailTab === 'users' && (
                    <div>
                      {users.length === 0
                        ? <div className={css.emptyMsg}>No users found</div>
                        : (
                          <table className={as.table}>
                            <thead>
                              <tr><th>Name</th><th>Username</th><th>Email</th><th>Role</th><th>Status</th></tr>
                            </thead>
                            <tbody>
                              {users.map(u => (
                                <tr key={u.id}>
                                  <td className={css.cellBold}>{u.full_name}</td>
                                  <td className={css.cellMono}>{u.username}</td>
                                  <td className={css.cellSecondary}>{u.email}</td>
                                  <td><span className={as.badgeRole} data-role={u.role}>{u.role}</span></td>
                                  <td>{u.is_active !== false ? <span className={as.badgeActive}>active</span> : <span className={as.badgeInactive}>inactive</span>}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        )}
                    </div>
                  )}

                  {/* departments */}
                  {detailTab === 'departments' && org && <Departments orgId={org.id} userRole="platform_admin" />}
                  {detailTab === 'departments' && !org && <NoOrg />}

                  {/* teams */}
                  {detailTab === 'teams' && org && <Teams orgId={org.id} userRole="platform_admin" />}
                  {detailTab === 'teams' && !org && <NoOrg />}

                  {/* org chart */}
                  {detailTab === 'chart' && org && <OrgChartView orgId={org.id} />}
                  {detailTab === 'chart' && !org && <NoOrg />}

                  {/* settings */}
                  {detailTab === 'settings' && (
                    <TenantSettings tenant={t} org={org} onEditOrg={() => setEditingOrg(org)} onReload={() => { loadTenants(); loadOrgs(); }} />
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* org edit modal */}
      {editingOrg && <OrgModal org={editingOrg} onClose={() => setEditingOrg(null)} onSave={(data) => handleOrgUpdate(editingOrg.id, data)} />}

      {/* suspend modal */}
      <SuspendDialog
        isOpen={suspendModal.open}
        reason={suspendReason}
        onReasonChange={setSuspendReason}
        onConfirm={confirmSuspend}
        onCancel={() => setSuspendModal({ open: false, id: null })}
      />

      {/* delete confirm modal */}
      <ConfirmDialog
        isOpen={deleteModal.open}
        title="Delete Tenant"
        message={`Are you sure you want to delete "${deleteModal.name}"? This marks the tenant as deleted.`}
        confirmText="Delete"
        cancelText="Cancel"
        isDanger
        onConfirm={confirmDelete}
        onCancel={() => setDeleteModal({ open: false, id: null, name: '' })}
      />
    </div>
  );
}

/* ================================================================ */
/*  SUB-COMPONENTS                                                  */
/* ================================================================ */

/* ── Suspend Dialog with reason input ── */
function SuspendDialog({ isOpen, reason, onReasonChange, onConfirm, onCancel }) {
  const inputRef = useRef(null);
  useEffect(() => {
    if (isOpen) setTimeout(() => inputRef.current?.focus(), 80);
  }, [isOpen]);

  if (!isOpen) return null;

  return (
    <ConfirmDialog
      isOpen={isOpen}
      title="Suspend Tenant"
      message={
        <div>
          <p style={{ margin: '0 0 10px' }}>Provide a reason for suspending this tenant:</p>
          <input
            ref={inputRef}
            value={reason}
            onChange={e => onReasonChange(e.target.value)}
            placeholder="Suspension reason…"
            className={css.inputFormFull}
            onKeyDown={e => { if (e.key === 'Enter' && reason.trim()) onConfirm(); }}
          />
        </div>
      }
      confirmText="Suspend"
      cancelText="Cancel"
      isDanger={false}
      onConfirm={() => { if (reason.trim()) onConfirm(); }}
      onCancel={onCancel}
    />
  );
}

function NoOrg() {
  return <div className={css.emptyMsg}>No linked organization found</div>;
}

function ActionBtn({ icon: Icon, label, onClick, color }) {
  return (
    <button title={label} onClick={onClick}
      className={css.actionBtn}
      style={color ? { color } : undefined}
    >
      <Icon size={13} /> {label}
    </button>
  );
}

function InfoCard({ icon: Icon, label, value }) {
  return (
    <div className={css.infoCard}>
      <Icon size={16} className={css.iconAccent} />
      <div>
        <div className={css.infoCardLabel}>{label}</div>
        <div className={css.infoCardValue}>{value ?? '—'}</div>
      </div>
    </div>
  );
}

function formatWorkDays(wd) {
  if (!wd) return 'Mon–Fri';
  const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return String(wd).split(',').map(d => names[+d] || d).join(', ');
}

/* ── Tenant Settings sub-tab ── */
function TenantSettings({ tenant, org, onEditOrg, onReload }) {
  const [domain, setDomain] = useState(tenant.custom_domain || '');
  const [maxUsers, setMaxUsers] = useState(tenant.max_users || '');
  const [maxStorage, setMaxStorage] = useState(tenant.max_storage_mb || '');
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');
  const [domainError, setDomainError] = useState('');

  // Reset local state when the tenant prop changes (e.g. expanding a different row)
  useEffect(() => {
    setDomain(tenant.custom_domain || '');
    setMaxUsers(tenant.max_users || '');
    setMaxStorage(tenant.max_storage_mb || '');
    setMsg('');
    setDomainError('');
  }, [tenant.id]);

  const DOMAIN_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i;

  const handleDomainChange = (val) => {
    setDomain(val);
    if (val && !DOMAIN_RE.test(val)) {
      setDomainError('Enter a valid domain (e.g. app.company.com)');
    } else {
      setDomainError('');
    }
  };

  const saveDomain = async () => {
    if (domain && !DOMAIN_RE.test(domain)) {
      setDomainError('Enter a valid domain (e.g. app.company.com)');
      return;
    }
    setSaving(true); setMsg('');
    try { await updateTenantDomain(tenant.id, domain); setMsg('Domain updated'); onReload(); }
    catch (e) { setMsg(e.response?.data?.error || 'Failed'); }
    finally { setSaving(false); }
  };

  const saveLimits = async () => {
    setSaving(true); setMsg('');
    try {
      await updateTenantLimits(tenant.id, {
        max_users: maxUsers ? Number(maxUsers) : null,
        max_storage_mb: maxStorage ? Number(maxStorage) : null,
      });
      setMsg('Limits updated'); onReload();
    } catch (e) { setMsg(e.response?.data?.error || 'Failed'); }
    finally { setSaving(false); }
  };

  return (
    <div className={css.settingsWrap}>
      {msg && <div className={css.settingsMsg}>{msg}</div>}

      {/* domain */}
      <fieldset className={css.fieldset}>
        <legend className={css.legend}>Custom Domain</legend>
        <div className={css.fieldRow}>
          <input value={domain} onChange={e => handleDomainChange(e.target.value)} placeholder="e.g. app.company.com"
            className={`${css.inputFull} ${domainError ? css.inputError : ''}`} />
          <button onClick={saveDomain} disabled={saving || !!domainError} className={css.saveBtn}>Save</button>
        </div>
        {domainError && <div className={css.fieldError}>{domainError}</div>}
      </fieldset>

      {/* limits */}
      <fieldset className={css.fieldset}>
        <legend className={css.legend}>Limits</legend>
        <div className={css.fieldRowWrap}>
          <div>
            <label className={css.fieldLabel}>Max Users</label>
            <input type="number" value={maxUsers} onChange={e => setMaxUsers(e.target.value)} placeholder="∞"
              className={css.inputSmall} />
          </div>
          <div>
            <label className={css.fieldLabel}>Max Storage (MB)</label>
            <input type="number" value={maxStorage} onChange={e => setMaxStorage(e.target.value)} placeholder="∞"
              className={css.inputSmall} />
          </div>
          <button onClick={saveLimits} disabled={saving} className={css.saveBtn}>Save Limits</button>
        </div>
      </fieldset>

      {/* org settings */}
      {org && (
        <fieldset className={css.fieldset}>
          <legend className={css.legend}>Organization Settings</legend>
          <div className={css.fieldRowWrap}>
            <span className={css.orgSettingsText}>
              Timezone: <strong>{org.timezone || 'UTC'}</strong> · Work hours: <strong>{org.work_hours_per_day || 8}h</strong> · Work days: <strong>{formatWorkDays(org.work_days)}</strong> · Fiscal year: <strong>Month {org.fiscal_year_start || 1}</strong>
            </span>
            <button onClick={onEditOrg} className={css.editOrgBtn}>
              <Pencil size={13} /> Edit Org Settings
            </button>
          </div>
        </fieldset>
      )}
    </div>
  );
}

/* ── Create Tenant Form ── */
function CreateTenantForm({ onSubmit, onCancel }) {
  const [form, setForm] = useState({ org_name: '', slug: '', max_users: '', max_storage_mb: '' });
  const [submitting, setSubmitting] = useState(false);
  const [slugError, setSlugError] = useState('');

  const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])?$/;

  const handleSlug = (name) => {
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50);
    setForm(f => ({ ...f, org_name: name, slug }));
    setSlugError('');
  };

  const handleSlugManual = (val) => {
    setForm(f => ({ ...f, slug: val }));
    if (val && !SLUG_RE.test(val)) {
      setSlugError('Slug must be lowercase alphanumeric with hyphens, 2–50 chars');
    } else {
      setSlugError('');
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (submitting) return;
    if (!SLUG_RE.test(form.slug)) {
      setSlugError('Slug must be lowercase alphanumeric with hyphens, 2–50 chars');
      return;
    }
    setSubmitting(true);
    try { await onSubmit(form); } finally { setSubmitting(false); }
  };

  return (
    <div className={css.createForm}>
      <h3 className={css.createFormTitle}>Create New Tenant</h3>
      <form onSubmit={handleSubmit}>
        <div className={css.createFormGrid}>
          <div>
            <label className={css.fieldLabelSec}>Organization Name</label>
            <input value={form.org_name} onChange={e => handleSlug(e.target.value)} required
              className={css.inputFormFull} />
          </div>
          <div>
            <label className={css.fieldLabelSec}>Slug</label>
            <input value={form.slug} onChange={e => handleSlugManual(e.target.value)} required
              className={`${css.inputFormMono} ${slugError ? css.inputError : ''}`} />
            {slugError && <div className={css.fieldError}>{slugError}</div>}
          </div>
          <div>
            <label className={css.fieldLabelSec}>Max Users (optional)</label>
            <input type="number" value={form.max_users} onChange={e => setForm(f => ({ ...f, max_users: e.target.value }))}
              className={css.inputFormFull} />
          </div>
          <div>
            <label className={css.fieldLabelSec}>Max Storage MB (optional)</label>
            <input type="number" value={form.max_storage_mb} onChange={e => setForm(f => ({ ...f, max_storage_mb: e.target.value }))}
              className={css.inputFormFull} />
          </div>
        </div>
        <div className={css.createFormActions}>
          <button type="submit" disabled={submitting} className={css.submitBtn}>{submitting ? 'Creating…' : 'Create Tenant'}</button>
          <button type="button" onClick={onCancel} className={css.cancelBtn}>Cancel</button>
        </div>
      </form>
    </div>
  );
}

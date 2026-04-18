import React, { useState, useEffect, useCallback } from 'react';
import {
  getTenant, getTenantStats, getTenantUsers, impersonateTenant,
  suspendTenant, reactivateTenant, updateTenantDomain, updateTenantLimits,
  getAdminOrganizations, updateAdminOrganization,
} from '../../api';
import {
  ArrowLeft, Building2, Users, Shield, Globe, Database, HardDrive,
  BarChart3, ExternalLink, Clock, Calendar, Settings2, Loader2,
  Pause, Play, Pencil, Building, UsersRound, GitBranch, X,
} from 'lucide-react';
import Departments from '../../components/organization/Departments';
import Teams from '../../components/organization/Teams';
import OrgChartView from '../../components/organization/OrgChartView';
import OrgModal from '../admin/OrgModal';
import s from './Tenants.module.css';

function InfoCard({ icon: Icon, label, value }) {
  return (
    <div className={s.infoCard}>
      <Icon size={16} className={s.iconAccent} />
      <div>
        <div className={s.infoCardLabel}>{label}</div>
        <div className={s.infoCardValue}>{value ?? '—'}</div>
      </div>
    </div>
  );
}

function Badge({ status }) {
  const colors = {
    active:    { bg: 'color-mix(in srgb, var(--success) 14%, transparent)', fg: 'var(--success)' },
    suspended: { bg: 'color-mix(in srgb, var(--warning) 14%, transparent)', fg: 'var(--warning)' },
    deleted:   { bg: 'color-mix(in srgb, var(--danger) 14%, transparent)',  fg: 'var(--danger)' },
  };
  const c = colors[status] || colors.active;
  return <span className={s.badge} style={{ background: c.bg, color: c.fg }}>{status}</span>;
}

function formatWorkDays(wd) {
  if (!wd) return 'Mon–Fri';
  const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return String(wd).split(',').map(d => names[+d] || d).join(', ');
}

export default function TenantDetail({ tenantId, onBack }) {
  const [tenant, setTenant] = useState(null);
  const [stats, setStats] = useState(null);
  const [users, setUsers] = useState([]);
  const [orgs, setOrgs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [tab, setTab] = useState('overview');
  const [editingOrg, setEditingOrg] = useState(null);

  const loadData = useCallback(async () => {
    try {
      setLoading(true);
      const [tenantRes, statsRes, usersRes, orgsRes] = await Promise.all([
        getTenant(tenantId),
        getTenantStats(tenantId).catch(() => ({ data: null })),
        getTenantUsers(tenantId).catch(() => ({ data: { users: [] } })),
        getAdminOrganizations().catch(() => ({ data: { data: [] } })),
      ]);
      setTenant(tenantRes.data);
      setStats(statsRes.data);
      setUsers(usersRes.data.users || []);
      setOrgs(orgsRes.data.data || orgsRes.data || []);
    } catch (e) {
      setError(e.response?.data?.error || 'Failed to load tenant');
    } finally {
      setLoading(false);
    }
  }, [tenantId]);

  useEffect(() => { loadData(); }, [loadData]);

  const org = tenant && orgs.find(o => o.slug === tenant.slug || o.name === tenant.org_name);

  const handleImpersonate = async () => {
    try {
      await impersonateTenant(tenantId);
      // Server sets the impersonation cookie (HttpOnly) and saves the original token
      window.location.href = '/';
    } catch (e) { setError(e.response?.data?.error || 'Failed to impersonate'); }
  };

  const handleSuspend = async () => {
    try { await suspendTenant(tenantId, 'Suspended by platform admin'); loadData(); }
    catch (e) { setError(e.response?.data?.error || 'Failed'); }
  };

  const handleReactivate = async () => {
    try { await reactivateTenant(tenantId); loadData(); }
    catch (e) { setError(e.response?.data?.error || 'Failed'); }
  };

  const handleOrgUpdate = async (id, data) => {
    try { await updateAdminOrganization(id, data); setEditingOrg(null); loadData(); }
    catch (e) { setError(e.response?.data?.error || 'Failed to update'); }
  };

  if (loading) return <div className={s.detailPage}><div className={s.loading}><Loader2 size={20} className={s.spinner} /> Loading tenant…</div></div>;
  if (!tenant) return <div className={s.detailPage}><div className={s.emptyMsg}>Tenant not found</div></div>;

  return (
    <div className={s.detailPage}>
      <button className={s.backBtn} onClick={onBack}><ArrowLeft size={16} /> Back to Tenants</button>

      {error && (
        <div className={s.errorBanner}>
          <span className={s.errorText}>{error}</span>
          <button onClick={() => setError('')} className={s.errorClose}><X size={16} /></button>
        </div>
      )}

      <div className={s.detailHeader}>
        <div className={s.detailTitle}>
          <Building2 size={24} className={s.iconAccent} />
          <div>
            <h1>{tenant.org_name}</h1>
            <span className={s.cellMono} style={{ color: 'var(--text-muted)' }}>{tenant.slug}</span>
          </div>
          <Badge status={tenant.status} />
        </div>
        <div className={s.detailActions}>
          {tenant.status === 'active' && (
            <button className={s.btnPrimary} onClick={handleImpersonate}>
              <Shield size={14} /> Enter Tenant
            </button>
          )}
          {tenant.status === 'active' && (
            <button className={s.btnSmall} style={{ color: 'var(--warning)' }} onClick={handleSuspend}>
              <Pause size={14} /> Suspend
            </button>
          )}
          {tenant.status === 'suspended' && (
            <button className={s.btnSmall} style={{ color: 'var(--success)' }} onClick={handleReactivate}>
              <Play size={14} /> Reactivate
            </button>
          )}
        </div>
      </div>

      <div className={s.detailTabs}>
        {[
          { key: 'overview', label: 'Overview', icon: BarChart3 },
          { key: 'users', label: `Users (${users.length})`, icon: Users },
          { key: 'departments', label: 'Departments', icon: Building },
          { key: 'teams', label: 'Teams', icon: UsersRound },
          { key: 'chart', label: 'Org Chart', icon: GitBranch },
          { key: 'settings', label: 'Settings', icon: Settings2 },
        ].map(({ key, label, icon: Icon }) => (
          <button key={key} onClick={() => setTab(key)}
            className={`${s.detailTab} ${tab === key ? s.detailTabActive : ''}`}>
            <Icon size={14} /> {label}
          </button>
        ))}
      </div>

      {/* Overview */}
      {tab === 'overview' && (
        <div className={s.overviewGrid}>
          <InfoCard icon={Globe} label="Custom Domain" value={tenant.custom_domain || 'None'} />
          <InfoCard icon={Database} label="Database" value={tenant.db_name || '—'} />
          <InfoCard icon={Users} label="Max Users" value={tenant.max_users || '∞'} />
          <InfoCard icon={HardDrive} label="Max Storage" value={tenant.max_storage_mb ? `${tenant.max_storage_mb} MB` : '∞'} />
          <InfoCard icon={Users} label="User Count" value={tenant.user_count || 0} />
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

      {/* Users */}
      {tab === 'users' && (
        <div>
          {users.length === 0 ? <div className={s.emptyMsg}>No users found</div> : (
            <table className={s.table}>
              <thead>
                <tr><th>Name</th><th>Username</th><th>Email</th><th>Role</th><th>Status</th></tr>
              </thead>
              <tbody>
                {users.map(u => (
                  <tr key={u.id}>
                    <td className={s.cellBold}>{u.full_name}</td>
                    <td className={s.cellMono}>{u.username}</td>
                    <td className={s.cellSecondary}>{u.email}</td>
                    <td><span className={s.badgeRole}>{u.role}</span></td>
                    <td>{u.is_active !== false ? <span className={s.badgeActive}>active</span> : <span className={s.badgeInactive}>inactive</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* Departments */}
      {tab === 'departments' && org ? <Departments orgId={org.id} userRole="platform_admin" /> : tab === 'departments' && <div className={s.emptyMsg}>No linked organization found</div>}

      {/* Teams */}
      {tab === 'teams' && org ? <Teams orgId={org.id} userRole="platform_admin" /> : tab === 'teams' && <div className={s.emptyMsg}>No linked organization found</div>}

      {/* Org Chart */}
      {tab === 'chart' && org ? <OrgChartView orgId={org.id} /> : tab === 'chart' && <div className={s.emptyMsg}>No linked organization found</div>}

      {/* Settings */}
      {tab === 'settings' && (
        <TenantSettings tenant={tenant} org={org} onEditOrg={() => setEditingOrg(org)} onReload={loadData} />
      )}

      {editingOrg && <OrgModal org={editingOrg} onClose={() => setEditingOrg(null)} onSave={(data) => handleOrgUpdate(editingOrg.id, data)} />}
    </div>
  );
}

/* ── Tenant Settings sub-section ── */
function TenantSettings({ tenant, org, onEditOrg, onReload }) {
  const [domain, setDomain] = useState(tenant.custom_domain || '');
  const [maxUsers, setMaxUsers] = useState(tenant.max_users || '');
  const [maxStorage, setMaxStorage] = useState(tenant.max_storage_mb || '');
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');
  const [domainError, setDomainError] = useState('');

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
    setDomainError(val && !DOMAIN_RE.test(val) ? 'Enter a valid domain (e.g. app.company.com)' : '');
  };

  const saveDomain = async () => {
    if (domain && !DOMAIN_RE.test(domain)) { setDomainError('Enter a valid domain'); return; }
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
    <div className={s.settingsWrap}>
      {msg && <div className={s.settingsMsg}>{msg}</div>}

      <fieldset className={s.fieldset}>
        <legend className={s.legend}>Custom Domain</legend>
        <div className={s.fieldRow}>
          <input value={domain} onChange={e => handleDomainChange(e.target.value)}
            placeholder="e.g. app.company.com"
            className={`${s.inputFull} ${domainError ? s.inputError : ''}`} />
          <button onClick={saveDomain} disabled={saving || !!domainError} className={s.saveBtn}>Save</button>
        </div>
        {domainError && <div className={s.fieldError}>{domainError}</div>}
      </fieldset>

      <fieldset className={s.fieldset}>
        <legend className={s.legend}>Limits</legend>
        <div className={s.fieldRowWrap}>
          <div>
            <label className={s.fieldLabel}>Max Users</label>
            <input type="number" value={maxUsers} onChange={e => setMaxUsers(e.target.value)} placeholder="∞" className={s.inputSmall} />
          </div>
          <div>
            <label className={s.fieldLabel}>Max Storage (MB)</label>
            <input type="number" value={maxStorage} onChange={e => setMaxStorage(e.target.value)} placeholder="∞" className={s.inputSmall} />
          </div>
          <button onClick={saveLimits} disabled={saving} className={s.saveBtn}>Save Limits</button>
        </div>
      </fieldset>

      {org && (
        <fieldset className={s.fieldset}>
          <legend className={s.legend}>Organization Settings</legend>
          <div className={s.fieldRowWrap}>
            <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
              Timezone: <strong>{org.timezone || 'UTC'}</strong> · Work hours: <strong>{org.work_hours_per_day || 8}h</strong> · Work days: <strong>{formatWorkDays(org.work_days)}</strong> · Fiscal year: <strong>Month {org.fiscal_year_start || 1}</strong>
            </span>
            <button onClick={onEditOrg} className={s.btnSmall}>
              <Pencil size={13} /> Edit Org Settings
            </button>
          </div>
        </fieldset>
      )}
    </div>
  );
}

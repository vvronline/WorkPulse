import React, { useState, useEffect } from 'react';
import {
  getTenantOverview, getTenantAlerts,
} from '../../api';
import {
  Loader2, Building2, Users, AlertTriangle, TrendingUp,
  Database, Activity, ShieldAlert,
} from 'lucide-react';
import s from './Tenants.module.css';

export default function PlatformDashboard() {
  const [loading, setLoading] = useState(true);
  const [overview, setOverview] = useState(null);
  const [alerts, setAlerts] = useState([]);
  const [error, setError] = useState('');

  useEffect(() => {
    Promise.all([
      getTenantOverview().then(r => setOverview(r.data)),
      getTenantAlerts().then(r => setAlerts(r.data?.alerts || [])),
    ]).catch(e => setError(e.response?.data?.error || 'Failed to load dashboard'))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div className={s.loading}><Loader2 size={20} className={s.spinner} /> Loading…</div>;
  if (error) return <div className={s.errorBanner}><span className={s.errorText}>{error}</span></div>;
  if (!overview) return null;

  const { total_tenants, total_users, by_status, by_plan, trend_30d, recent, pool_stats } = overview;

  return (
    <div>
      {/* ─── Stats Overview ─── */}
      <div className={s.overviewStats}>
        <StatCard icon={Building2} label="Total Tenants" value={total_tenants} color="var(--accent)" />
        <StatCard icon={Users} label="Total Users" value={total_users} color="var(--success)" />
        <StatCard icon={Activity} label="Active" value={by_status?.active || 0} color="var(--success)" />
        <StatCard icon={ShieldAlert} label="Suspended" value={by_status?.suspended || 0} color="var(--warning)" />
      </div>

      {/* ─── Plan Distribution ─── */}
      {by_plan && Object.keys(by_plan).length > 0 && (
        <fieldset className={s.fieldset} style={{ marginBottom: 20 }}>
          <legend className={s.legend}>Plan Distribution</legend>
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
            {Object.entries(by_plan).map(([plan, count]) => (
              <div key={plan} style={{
                padding: '12px 20px',
                background: 'var(--bg-secondary)',
                borderRadius: 10,
                textAlign: 'center',
                minWidth: 100,
              }}>
                <div style={{ fontSize: '1.4rem', fontWeight: 700, color: 'var(--text-primary)' }}>{count}</div>
                <div style={{ fontSize: 12, color: 'var(--text-secondary)', textTransform: 'capitalize', marginTop: 2 }}>{plan}</div>
              </div>
            ))}
          </div>
        </fieldset>
      )}

      {/* ─── Alerts ─── */}
      <fieldset className={s.fieldset} style={{ marginBottom: 20 }}>
        <legend className={s.legend} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <AlertTriangle size={14} /> Alerts ({alerts.length})
        </legend>
        {alerts.length === 0 ? (
          <div className={s.emptyMsg} style={{ padding: 20 }}>No alerts — all tenants within limits.</div>
        ) : (
          <table className={s.table}>
            <thead>
              <tr>
                <th>Tenant</th>
                <th>Alert</th>
                <th>Usage</th>
                <th>Limit</th>
                <th>%</th>
              </tr>
            </thead>
            <tbody>
              {alerts.map((a, i) => (
                <tr key={i}>
                  <td>
                    <strong>{a.tenant_name}</strong>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'monospace' }}>{a.slug}</div>
                  </td>
                  <td>
                    <span className={s.badge} style={{
                      background: a.alert_type === 'no_active_super_admin'
                        ? 'color-mix(in srgb, var(--danger) 15%, transparent)'
                        : 'color-mix(in srgb, var(--warning) 15%, transparent)',
                      color: a.alert_type === 'no_active_super_admin' ? 'var(--danger)' : 'var(--warning)',
                    }}>
                      {alertLabel(a.alert_type)}
                    </span>
                  </td>
                  <td>{a.alert_type === 'no_active_super_admin' ? '—' : formatValue(a.current_value, a.alert_type)}</td>
                  <td>{a.alert_type === 'no_active_super_admin' ? '—' : formatValue(a.limit_value, a.alert_type)}</td>
                  <td>
                    {a.alert_type !== 'no_active_super_admin' && (
                      <span style={{ fontWeight: 600, color: a.percentage >= 95 ? 'var(--danger)' : 'var(--warning)' }}>
                        {a.percentage}%
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </fieldset>

      {/* ─── 30-day Trend ─── */}
      {trend_30d && trend_30d.length > 0 && (
        <fieldset className={s.fieldset} style={{ marginBottom: 20 }}>
          <legend className={s.legend} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <TrendingUp size={14} /> New Tenants (Last 30 Days)
          </legend>
          <div style={{ display: 'flex', gap: 3, alignItems: 'flex-end', height: 60, padding: '8px 0' }}>
            {trend_30d.map((d, i) => {
              const max = Math.max(...trend_30d.map(x => parseInt(x.count, 10)), 1);
              const h = Math.max((parseInt(d.count, 10) / max) * 48, 3);
              return (
                <div
                  key={i}
                  title={`${d.day}: ${d.count} new`}
                  style={{
                    flex: 1,
                    height: h,
                    background: 'var(--accent)',
                    borderRadius: 3,
                    opacity: 0.8,
                  }}
                />
              );
            })}
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
            Total: {trend_30d.reduce((sum, d) => sum + parseInt(d.count, 10), 0)} new tenants
          </div>
        </fieldset>
      )}

      {/* ─── Recent Tenants ─── */}
      {recent && recent.length > 0 && (
        <fieldset className={s.fieldset} style={{ marginBottom: 20 }}>
          <legend className={s.legend}>Recently Created</legend>
          <table className={s.table}>
            <thead>
              <tr><th>Organization</th><th>Slug</th><th>Status</th><th>Created</th></tr>
            </thead>
            <tbody>
              {recent.map(t => (
                <tr key={t.id}>
                  <td><strong>{t.org_name}</strong></td>
                  <td style={{ fontFamily: 'monospace', fontSize: 13 }}>{t.slug}</td>
                  <td>
                    <span className={s.badge} style={{
                      background: t.status === 'active'
                        ? 'color-mix(in srgb, var(--success) 15%, transparent)'
                        : 'color-mix(in srgb, var(--warning) 15%, transparent)',
                      color: t.status === 'active' ? 'var(--success)' : 'var(--warning)',
                    }}>{t.status}</span>
                  </td>
                  <td className={s.cellSecondary}>{new Date(t.created_at).toLocaleDateString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </fieldset>
      )}

      {/* ─── Pool Stats ─── */}
      {pool_stats && (
        <fieldset className={s.fieldset}>
          <legend className={s.legend} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <Database size={14} /> Connection Pool
          </legend>
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
            <MiniStat label="Active Pools" value={pool_stats.active || 0} />
            <MiniStat label="Max Pools" value={pool_stats.max || 10} />
            <MiniStat label="Evictions" value={pool_stats.evictions || 0} />
          </div>
        </fieldset>
      )}
    </div>
  );
}

function StatCard({ icon: Icon, label, value, color }) {
  return (
    <div className={s.stat}>
      <div className={s.statIcon} style={{ background: `color-mix(in srgb, ${color} 14%, transparent)`, color }}>
        <Icon size={18} />
      </div>
      <div>
        <div className={s.statValue}>{value}</div>
        <div className={s.statLabel}>{label}</div>
      </div>
    </div>
  );
}

function MiniStat({ label, value }) {
  return (
    <div style={{ padding: '10px 16px', background: 'var(--bg-secondary)', borderRadius: 8 }}>
      <div style={{ fontSize: '1.1rem', fontWeight: 700 }}>{value}</div>
      <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{label}</div>
    </div>
  );
}

function alertLabel(type) {
  switch (type) {
    case 'users_approaching_limit': return 'Users at limit';
    case 'storage_approaching_limit': return 'Storage at limit';
    case 'no_active_super_admin': return 'No active admin';
    default: return type;
  }
}

function formatValue(val, type) {
  if (type === 'storage_approaching_limit') return `${val} MB`;
  return val;
}

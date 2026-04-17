import React, { useState } from 'react';
import { ShieldAlert, LogOut } from 'lucide-react';
import { exitImpersonation } from '../../api';
import { useAuth } from '../../AuthContext';
import s from './ImpersonationBanner.module.css';

export default function ImpersonationBanner() {
  const { user, saveAuth } = useAuth();
  const [exiting, setExiting] = useState(false);

  if (!user?.impersonated) return null;

  const handleExit = async () => {
    setExiting(true);
    try {
      // The server's exit-impersonate endpoint restores the original platform_admin JWT cookie.
      // We pass tenant_id so the server knows which tenant context to exit.
      await exitImpersonation(user.tenant_id);
      localStorage.removeItem('_wp_orig_token');
      // Full reload to reset all cached tenant-specific state
      window.location.href = '/tenants';
    } catch {
      setExiting(false);
    }
  };

  return (
    <div className={s.banner}>
      <ShieldAlert size={15} />
      <span className={s.text}>
        Viewing tenant <span className={s.tenantName}>{user.impersonated_tenant_name || user.tenant_id}</span> as {user.full_name || user.username}
      </span>
      <button className={s.exitBtn} onClick={handleExit} disabled={exiting}>
        <LogOut size={13} />
        {exiting ? 'Exiting…' : 'Exit Tenant'}
      </button>
    </div>
  );
}

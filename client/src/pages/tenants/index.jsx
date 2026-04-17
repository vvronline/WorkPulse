import React, { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Building2, Users, Shield, Settings2 } from 'lucide-react';
import TenantList from './TenantList';
import TenantDetail from './TenantDetail';
import CreateTenant from './CreateTenant';
import PlatformAdmins from './PlatformAdmins';
import PlatformSettings from './PlatformSettings';
import s from './Tenants.module.css';

export default function TenantsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const initialTab = searchParams.get('tab') || 'tenants';
  const [tab, setTab] = useState(initialTab);

  // Tenant detail view — when a tenant ID is selected
  const [selectedTenantId, setSelectedTenantId] = useState(null);

  const changeTab = (t) => {
    setTab(t);
    setSelectedTenantId(null);
    setSearchParams(t === 'tenants' ? {} : { tab: t });
  };

  // If viewing a specific tenant detail, show full detail page
  if (selectedTenantId) {
    return <TenantDetail tenantId={selectedTenantId} onBack={() => setSelectedTenantId(null)} />;
  }

  return (
    <div className={s.tenantsPage}>
      <h1>Platform Management</h1>
      <p className={s.subtitle}>Manage tenants, platform admins, and global settings</p>

      <div className={s.tabs}>
        <button className={`${s.tab} ${tab === 'tenants' ? s.active : ''}`} onClick={() => changeTab('tenants')}>
          <span><Building2 size={14} /></span> Tenants
        </button>
        <button className={`${s.tab} ${tab === 'create' ? s.active : ''}`} onClick={() => changeTab('create')}>
          <span><Building2 size={14} /></span> New Tenant
        </button>
        <button className={`${s.tab} ${tab === 'admins' ? s.active : ''}`} onClick={() => changeTab('admins')}>
          <span><Shield size={14} /></span> Platform Admins
        </button>
        <button className={`${s.tab} ${tab === 'settings' ? s.active : ''}`} onClick={() => changeTab('settings')}>
          <span><Settings2 size={14} /></span> Platform Settings
        </button>
      </div>

      {tab === 'tenants' && <TenantList onSelectTenant={setSelectedTenantId} />}
      {tab === 'create' && <CreateTenant onCreated={(id) => { setSelectedTenantId(id); }} />}
      {tab === 'admins' && <PlatformAdmins />}
      {tab === 'settings' && <PlatformSettings />}
    </div>
  );
}

import React, { useState } from 'react';
import OrganizationsManagement from './OrganizationsManagement';
import MyOrganization from './MyOrganization';
import s from '../Admin.module.css';
import su from './AdminUtils.module.css';

export default function OrganizationsTab({ userRole, hasOrgId }) {
    const isSuperAdmin = userRole === 'super_admin';
    const [orgRefreshKey, setOrgRefreshKey] = useState(0);

    return (
        <>
            {isSuperAdmin && (
                <>
                    <h2 className={su['heading-mb']}>All Organizations</h2>
                    <OrganizationsManagement onOrgChange={() => setOrgRefreshKey(k => k + 1)} />
                </>
            )}
            {hasOrgId && (
                <>
                    {isSuperAdmin && <hr className={su['section-divider']} />}
                    <MyOrganization userRole={userRole} refreshKey={orgRefreshKey} />
                </>
            )}
        </>
    );
}

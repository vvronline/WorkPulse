import React, { useState } from "react";
import { Hammer, Building, UsersRound, GitBranch, X } from "lucide-react";
import OrganizationsManagement from "./OrganizationsManagement";
import MyOrganization from "./MyOrganization";
import Departments from "../../components/organization/Departments";
import Teams from "../../components/organization/Teams";
import OrgChartView from "../../components/organization/OrgChartView";
import s from "../Admin.module.css";
import su from "./AdminUtils.module.css";

interface OrganizationsTabProps {
    userRole?: string;
    hasOrgId?: boolean;
}

export default function OrganizationsTab({ userRole, hasOrgId }: OrganizationsTabProps) {
    const isPlatformAdmin = userRole === "platform_admin";
    const [orgRefreshKey, setOrgRefreshKey] = useState(0);
    const [managingOrg, setManagingOrg] = useState<any>(null);
    const [manageTab, setManageTab] = useState("departments");

    return (
        <>
            {isPlatformAdmin && (
                <>
                    <h2 className={su["heading-mb"]}>All Organizations</h2>
                    <OrganizationsManagement
                        onOrgChange={() => setOrgRefreshKey(k => k + 1)}
                        onManageOrg={(org) => { setManagingOrg(org); setManageTab("departments"); }}
                    />
                </>
            )}
            {isPlatformAdmin && managingOrg && (
                <>
                    <hr className={su["section-divider"]} />
                    <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", marginBottom: "0.5rem" }}>
                        <h2 className={su.sectionHeading} style={{ margin: 0 }}><Hammer size={18} style={{ marginRight: 7, verticalAlign: "middle" }} />Managing: {managingOrg.name}</h2>
                        <button className={`${s.btnSmall} ${s.btnSecondary}`} onClick={() => setManagingOrg(null)}><X size={14} style={{ marginRight: 4, verticalAlign: "middle" }} />Close</button>
                    </div>
                    <div className={s.tabs}>
                        <button className={`${s.tab} ${manageTab === "departments" ? s.active : ""}`} onClick={() => setManageTab("departments")}>
                            <span><Building size={14} style={{ marginRight: 4, verticalAlign: "middle" }} /></span> Departments
                        </button>
                        <button className={`${s.tab} ${manageTab === "teams" ? s.active : ""}`} onClick={() => setManageTab("teams")}>
                            <span><UsersRound size={14} style={{ marginRight: 4, verticalAlign: "middle" }} /></span> Teams
                        </button>
                        <button className={`${s.tab} ${manageTab === "chart" ? s.active : ""}`} onClick={() => setManageTab("chart")}>
                            <span><GitBranch size={14} style={{ marginRight: 4, verticalAlign: "middle" }} /></span> Org Chart
                        </button>
                    </div>
                    <div className={su["tab-content"]}>
                        {manageTab === "departments" && <Departments orgId={managingOrg.id} userRole={userRole} />}
                        {manageTab === "teams" && <Teams orgId={managingOrg.id} userRole={userRole} />}
                        {manageTab === "chart" && <OrgChartView orgId={managingOrg.id} />}
                    </div>
                </>
            )}
            {hasOrgId && (
                <>
                    {isPlatformAdmin && <hr className={su["section-divider"]} />}
                    <MyOrganization userRole={userRole} refreshKey={orgRefreshKey} />
                </>
            )}
        </>
    );
}
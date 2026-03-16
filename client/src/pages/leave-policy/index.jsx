import React, { useState, useEffect } from 'react';
import { useAuth } from '../../AuthContext';
import { useSearchParams } from 'react-router-dom';
import PoliciesTab from './PoliciesTab';
import MyBalances from './MyBalances';
import HolidaysTab from './HolidaysTab';
import AllBalances from './AllBalances';
import s from '../LeavePolicy.module.css';

const TABS = [
    { id: 'balances',   label: 'My Balances', icon: '📊', hrOnly: false },
    { id: 'holidays',   label: 'Holidays',    icon: '🏖️', hrOnly: false },
    { id: 'policies',   label: 'Policies',    icon: '📋', hrOnly: true  },
    { id: 'allBalances',label: 'All Balances',icon: '👥', hrOnly: true  },
];

export default function LeavePolicy() {
    const { user } = useAuth();
    const isHR = ['hr_admin', 'super_admin'].includes(user?.role);
    const visibleTabs = TABS.filter(t => !t.hrOnly || isHR);
    const [searchParams] = useSearchParams();
    const [tab, setTab] = useState(() => {
        const t = searchParams.get('tab');
        return (t && visibleTabs.find(v => v.id === t)) ? t : (visibleTabs[0]?.id || 'balances');
    });

    // Sync tab when URL changes (e.g. navigated from GlobalSearch)
    useEffect(() => {
        const t = searchParams.get('tab');
        if (t && visibleTabs.find(v => v.id === t)) setTab(t);
    }, [searchParams]); // eslint-disable-line react-hooks/exhaustive-deps

    return (
        <div className={s.page}>
            <div className={s.pageHeader}>
                <div>
                    <h1 className={s.pageTitle}>Leave &amp; Holidays</h1>
                    <p className={s.pageSubtitle}>Manage leave policies, balances, and public holidays</p>
                </div>
            </div>

            <div className={s.tabBar}>
                {visibleTabs.map(t => (
                    <button
                        key={t.id}
                        className={`${s.tabBtn} ${tab === t.id ? s.tabBtnActive : ''}`}
                        onClick={() => setTab(t.id)}
                    >
                        <span className={s.tabIcon}>{t.icon}</span>
                        {t.label}
                    </button>
                ))}
            </div>

            <div className={s.tabContent}>
                {tab === 'balances'    && <MyBalances />}
                {tab === 'holidays'    && <HolidaysTab isHR={isHR} />}
                {tab === 'policies'    && isHR && <PoliciesTab />}
                {tab === 'allBalances' && isHR && <AllBalances />}
            </div>
        </div>
    );
}

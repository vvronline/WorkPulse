import React, { useState } from 'react';
import { useAuth } from '../../AuthContext';
import PoliciesTab from './PoliciesTab';
import MyBalances from './MyBalances';
import HolidaysTab from './HolidaysTab';
import AllBalances from './AllBalances';
import s from '../LeavePolicy.module.css';

export default function LeavePolicy() {
    const { user } = useAuth();
    const [tab, setTab] = useState('policies');
    const isHR = ['hr_admin', 'super_admin'].includes(user?.role);

    return (
        <div className={s.adminPage}>
            <h1>Leave Management</h1>
            <div className={s.tabs}>
                {isHR && <button className={`${s.tab} ${tab === 'policies' ? s.active : ''}`} onClick={() => setTab('policies')}>Policies</button>}
                <button className={`${s.tab} ${tab === 'balances' ? s.active : ''}`} onClick={() => setTab('balances')}>My Balances</button>
                <button className={`${s.tab} ${tab === 'holidays' ? s.active : ''}`} onClick={() => setTab('holidays')}>Holidays</button>
                {isHR && <button className={`${s.tab} ${tab === 'allBalances' ? s.active : ''}`} onClick={() => setTab('allBalances')}>All Balances</button>}
            </div>
            {tab === 'policies' && isHR && <PoliciesTab />}
            {tab === 'balances' && <MyBalances />}
            {tab === 'holidays' && <HolidaysTab isHR={isHR} />}
            {tab === 'allBalances' && isHR && <AllBalances />}
        </div>
    );
}

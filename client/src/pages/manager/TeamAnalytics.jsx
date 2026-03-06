import React, { useState, useEffect, useMemo } from 'react';
import { getTeamAnalytics } from '../../api';
import { ROLE_LABELS, formatMin } from './constants';
import TodayStatusBadge from './TodayStatusBadge';
import PercentBar from './PercentBar';
import MiniTrend from './MiniTrend';
import MemberExpandedCard from './MemberExpandedCard';
import s from '../Admin.module.css';
import m from '../ManagerDashboard.module.css';

export default function TeamAnalytics({ onSelectMember }) {
    const [data, setData] = useState(null);
    const [range, setRange] = useState('7');
    const [customFrom, setCustomFrom] = useState('');
    const [customTo, setCustomTo] = useState('');
    const [search, setSearch] = useState('');
    const [sortBy, setSortBy] = useState('hours');
    const [sortAsc, setSortAsc] = useState(false);
    const [expandedId, setExpandedId] = useState(null);
    const [filterDept, setFilterDept] = useState('');

    useEffect(() => {
        if (range === 'custom') {
            if (customFrom && customTo && customFrom <= customTo) {
                getTeamAnalytics(null, customFrom, customTo).then(r => setData(r.data)).catch(e => console.error(e));
            }
            return;
        }
        getTeamAnalytics(range).then(r => setData(r.data)).catch(e => console.error(e));
    }, [range, customFrom, customTo]);

    const handleRangeChange = (val) => {
        setRange(val);
        if (val !== 'custom') { setCustomFrom(''); setCustomTo(''); }
    };

    const departments = useMemo(() => {
        if (!data?.members) return [];
        const depts = new Set(data.members.map(mem => mem.department_name).filter(Boolean));
        return [...depts].sort();
    }, [data]);

    const filteredMembers = useMemo(() => {
        if (!data?.members) return [];
        let list = data.members;
        if (search) {
            const q = search.toLowerCase();
            list = list.filter(mem => mem.full_name?.toLowerCase().includes(q) || mem.email?.toLowerCase().includes(q) || mem.role?.toLowerCase().includes(q));
        }
        if (filterDept) list = list.filter(mem => mem.department_name === filterDept);
        list = [...list].sort((a, b) => {
            const av = a[sortBy], bv = b[sortBy];
            if (typeof av === 'string') return sortAsc ? av.localeCompare(bv) : bv.localeCompare(av);
            return sortAsc ? (av || 0) - (bv || 0) : (bv || 0) - (av || 0);
        });
        return list;
    }, [data, search, filterDept, sortBy, sortAsc]);

    const handleSort = (col) => {
        if (sortBy === col) setSortAsc(!sortAsc);
        else { setSortBy(col); setSortAsc(false); }
    };

    const SortIcon = ({ col }) => sortBy === col ? (sortAsc ? ' ▲' : ' ▼') : '';

    if (!data) return <p>Loading...</p>;

    const rangeLabel = range === '7' ? 'This Week' : range === '30' ? 'This Month' : range === '90' ? 'This Quarter' : (customFrom && customTo) ? `${customFrom} — ${customTo}` : 'Custom Range';

    return (
        <>
            <div className={m.analyticsToolbar}>
                <select value={range} onChange={e => handleRangeChange(e.target.value)} className={m.selectField}>
                    <option value="7">This Week</option>
                    <option value="30">This Month</option>
                    <option value="90">This Quarter</option>
                    <option value="custom">Custom Range</option>
                </select>
                {range === 'custom' && (
                    <div className={m.dateRangePicker}>
                        <input type="date" value={customFrom} onChange={e => setCustomFrom(e.target.value)} className={m.inputField} max={customTo || undefined} />
                        <span className={m.dateRangeSep}>to</span>
                        <input type="date" value={customTo} onChange={e => setCustomTo(e.target.value)} className={m.inputField} min={customFrom || undefined} max={new Date().toISOString().split('T')[0]} />
                    </div>
                )}
                <input placeholder="Search members..." value={search} onChange={e => setSearch(e.target.value)} className={m.inputField} />
                {departments.length > 0 && (
                    <select value={filterDept} onChange={e => setFilterDept(e.target.value)} className={m.selectField}>
                        <option value="">All Departments</option>
                        {departments.map(d => <option key={d} value={d}>{d}</option>)}
                    </select>
                )}
            </div>

            <div className={m.summaryGrid}>
                <div className={m.summaryCard}><div className={m.summaryIcon}>👥</div><div className={m.summaryValue}>{data.totalMembers}</div><div className={m.summaryLabel}>Team Members</div></div>
                <div className={m.summaryCard}><div className={m.summaryIcon}>⏱</div><div className={m.summaryValue}>{data.avgHours?.toFixed(1) || 0}h</div><div className={m.summaryLabel}>Avg Hours/Day</div></div>
                <div className={m.summaryCard}><div className={m.summaryIcon}>📋</div><div className={m.summaryValue}>{data.totalTasksDone || 0}</div><div className={m.summaryLabel}>Planner Completed</div></div>
                <div className={m.summaryCard}><div className={m.summaryIcon}>🎯</div><div className={m.summaryValue}>{data.avgTargetMet || 0}%</div><div className={m.summaryLabel}>Avg Target Met</div></div>
                <div className={m.summaryCard}><div className={m.summaryIcon}>⏰</div><div className={m.summaryValue}>{data.avgPunctuality || 0}%</div><div className={m.summaryLabel}>Avg Punctuality</div></div>
                <div className={m.summaryCard}><div className={m.summaryIcon}>📋</div><div className={`${m.summaryValue} ${m.colorAmber}`}>{data.pendingApprovals || 0}</div><div className={m.summaryLabel}>Pending Approvals</div></div>
            </div>

            <h3 className={m.sectionTitle}>Member Performance — {rangeLabel} <span className={m.memberCount}>({filteredMembers.length})</span></h3>
            <div className={m.tableWrap}>
                <table className={m.analyticsTable}>
                    <thead>
                        <tr>
                            <th onClick={() => handleSort('full_name')} className={m.sortable}>Member<SortIcon col="full_name" /></th>
                            <th>Today</th>
                            <th onClick={() => handleSort('hours')} className={m.sortable}>Total Hours<SortIcon col="hours" /></th>
                            <th onClick={() => handleSort('avgFloorMinutes')} className={m.sortable}>Avg/Day<SortIcon col="avgFloorMinutes" /></th>
                            <th onClick={() => handleSort('tasksDone')} className={m.sortable}>Planner<SortIcon col="tasksDone" /></th>
                            <th onClick={() => handleSort('targetMetPercent')} className={m.sortable}>Target Met<SortIcon col="targetMetPercent" /></th>
                            <th onClick={() => handleSort('punctualityPercent')} className={m.sortable}>Punctuality<SortIcon col="punctualityPercent" /></th>
                            <th>Trend</th>
                            <th></th>
                        </tr>
                    </thead>
                    <tbody>
                        {filteredMembers.map(mem => (
                            <React.Fragment key={mem.id}>
                                <tr className={m.memberRow} onClick={() => setExpandedId(expandedId === mem.id ? null : mem.id)}>
                                    <td>
                                        <div className={m.memberInfo}>
                                            {mem.avatar ? <img src={mem.avatar} className={m.memberAvatarSm} alt="" /> : <span className={m.avatarPlaceholder}>{mem.full_name?.charAt(0)}</span>}
                                            <div>
                                                <div className={m.memberNameCol}>{mem.full_name}</div>
                                                <div className={m.memberMeta}>
                                                    {ROLE_LABELS[mem.role] || mem.role}
                                                    {mem.department_name && <> · {mem.department_name}</>}
                                                    {mem.team_name && <> · {mem.team_name}</>}
                                                </div>
                                            </div>
                                        </div>
                                    </td>
                                    <td><TodayStatusBadge status={mem.todayStatus} minutes={mem.todayHoursMin} /></td>
                                    <td className={m.numCell}>{mem.hours?.toFixed(1)}h</td>
                                    <td className={m.numCell}>{formatMin(mem.avgFloorMinutes)}</td>
                                    <td className={m.numCell}>
                                        <span className={m.tasksPill}>{mem.tasksDone}<span className={m.tasksSep}>/{mem.tasksTotal}</span></span>
                                    </td>
                                    <td><PercentBar value={mem.targetMetPercent} /></td>
                                    <td><PercentBar value={mem.punctualityPercent} color="blue" /></td>
                                    <td><MiniTrend data={mem.trend} target={data.targetMinutes} /></td>
                                    <td>
                                        <button className={m.viewBtn} onClick={(e) => { e.stopPropagation(); onSelectMember(mem); }} title="View full profile">→</button>
                                    </td>
                                </tr>
                                {expandedId === mem.id && (
                                    <tr className={m.expandedRow}>
                                        <td colSpan={9}>
                                            <MemberExpandedCard member={mem} targetMinutes={data.targetMinutes} expectedWeekdays={data.expectedWeekdays} />
                                        </td>
                                    </tr>
                                )}
                            </React.Fragment>
                        ))}
                        {filteredMembers.length === 0 && (
                            <tr><td colSpan={9} className={m.emptyState}>No members match your filters</td></tr>
                        )}
                    </tbody>
                </table>
            </div>
        </>
    );
}

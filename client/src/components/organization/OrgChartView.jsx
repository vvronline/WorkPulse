import React, { useState, useEffect, useMemo } from 'react';
import DOMPurify from 'dompurify';
import { getOrgChart } from '../../api';
import { ROLE_LABELS } from '../../pages/admin/constants';
import s from '../../pages/Admin.module.css';
import oc from './OrgChart.module.css';
import su from '../../pages/admin/AdminUtils.module.css';

function MemberAvatar({ member, size = 'sm' }) {
    const src = member.avatar || null;
    return src
        ? <img src={src} className={size === 'md' ? oc['mini-avatar-md'] : oc['mini-avatar-sm']} alt="" />
        : <span className={`${s.initials} ${size === 'md' ? oc['mini-initials-md'] : oc['mini-initials-sm']}`}>
            {member.full_name?.charAt(0)?.toUpperCase()}
          </span>;
}

function MemberChip({ member, highlight }) {
    const name = member.full_name;
    const hl = highlight?.toLowerCase();
    const escapedHl = hl ? hl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : null;
    const hiName = escapedHl && name.toLowerCase().includes(hl)
        ? DOMPurify.sanitize(name.replace(new RegExp(`(${escapedHl})`, 'gi'), '<mark>$1</mark>'))
        : name;
    return (
        <div className={oc['member-chip']} title={`${name}\n${ROLE_LABELS[member.role] || member.role}${member.manager_name ? `\nReports to: ${member.manager_name}` : ''}`}>
            <MemberAvatar member={member} />
            <span dangerouslySetInnerHTML={{ __html: hiName }} />
            <span className={`${s.badgeRole} ${oc['badge-sm']}`} data-role={member.role}>
                {ROLE_LABELS[member.role] || member.role}
            </span>
        </div>
    );
}

// ── Reporting Tree view ────────────────────────────────────────────────────
function TreeNode({ member, childrenMap, depth = 0, highlight }) {
    const [open, setOpen] = useState(depth < 2);
    const children = childrenMap[member.id] || [];
    const hasChildren = children.length > 0;

    return (
        <div className={oc['tree-node']} style={{ '--depth': depth }}>
            <div className={`${oc['tree-row']} ${highlight && member.full_name.toLowerCase().includes(highlight.toLowerCase()) ? oc['tree-row-hl'] : ''}`}>
                {hasChildren ? (
                    <button className={oc['tree-toggle']} onClick={() => setOpen(o => !o)} aria-label={open ? 'Collapse' : 'Expand'}>
                        {open ? '▾' : '▸'}
                    </button>
                ) : (
                    <span className={oc['tree-leaf-dot']} />
                )}
                <MemberAvatar member={member} size="md" />
                <div className={oc['tree-info']}>
                    <span className={oc['tree-name']}>{member.full_name}</span>
                    <span className={oc['tree-meta']}>
                        {ROLE_LABELS[member.role] || member.role}
                        {member.manager_name ? ` · reports to ${member.manager_name}` : ''}
                    </span>
                </div>
                {hasChildren && (
                    <span className={oc['tree-count']}>{children.length} direct report{children.length !== 1 ? 's' : ''}</span>
                )}
            </div>
            {hasChildren && open && (
                <div className={oc['tree-children']}>
                    {children.map(c => (
                        <TreeNode key={c.id} member={c} childrenMap={childrenMap} depth={depth + 1} highlight={highlight} />
                    ))}
                </div>
            )}
        </div>
    );
}

// ── Department/Team view ───────────────────────────────────────────────────
function DeptCard({ dept, teams, members, highlight }) {
    const [open, setOpen] = useState(true);
    const deptTeams = teams.filter(t => t.department_id === dept.id);
    const deptDirectMembers = members.filter(m => m.department_id === dept.id && !m.team_id);
    const totalCount = members.filter(m => m.department_id === dept.id).length;

    return (
        <div className={oc['card-panel']}>
            <div className={oc['dept-header']} style={{ cursor: 'pointer' }} onClick={() => setOpen(o => !o)}>
                <span className={oc['dept-icon']}>🏢</span>
                <div style={{ flex: 1 }}>
                    <div className={oc['dept-name']}>
                        {open ? '▾' : '▸'} {dept.name}
                        <span className={oc['headcount-badge']}>{totalCount}</span>
                    </div>
                    {dept.head_name && <div className={su['text-muted-xs']}>Head: {dept.head_name}</div>}
                </div>
            </div>
            {open && (
                <>
                    {deptTeams.map(team => {
                        const tMembers = members.filter(m => m.team_id === team.id);
                        return (
                            <div key={team.id} className={oc['team-card']}>
                                <div className={oc['team-title']}>
                                    👥 {team.name}
                                    <span className={oc['headcount-badge']}>{tMembers.length}</span>
                                    {team.lead_name && <span className={oc['team-lead-label']}> · Lead: {team.lead_name}</span>}
                                </div>
                                <div className={oc['flex-wrap']}>
                                    {tMembers.length > 0
                                        ? tMembers.map(m => <MemberChip key={m.id} member={m} highlight={highlight} />)
                                        : <span className={su['text-muted-xs']}>No members</span>
                                    }
                                </div>
                            </div>
                        );
                    })}
                    {deptDirectMembers.length > 0 && (
                        <div className={oc['unassigned-section']}>
                            <div className={oc['unassigned-label']}>Not assigned to a team:</div>
                            <div className={oc['flex-wrap']}>
                                {deptDirectMembers.map(m => <MemberChip key={m.id} member={m} highlight={highlight} />)}
                            </div>
                        </div>
                    )}
                </>
            )}
        </div>
    );
}

// ── Main component ─────────────────────────────────────────────────────────
export default function OrgChartView({ orgId }) {
    const [chart, setChart] = useState(null);
    const [viewMode, setViewMode] = useState('dept');   // 'dept' | 'tree'
    const [search, setSearch] = useState('');

    useEffect(() => {
        const params = orgId ? { org_id: orgId } : undefined;
        getOrgChart(params).then(r => setChart(r.data)).catch(e => console.error(e));
    }, [orgId]);

    // Filtered members for dept view
    const filteredMembers = useMemo(() => {
        if (!chart) return [];
        const q = search.trim().toLowerCase();
        if (!q) return chart.members;
        return chart.members.filter(m =>
            m.full_name.toLowerCase().includes(q) ||
            m.email?.toLowerCase().includes(q) ||
            (ROLE_LABELS[m.role] || m.role).toLowerCase().includes(q) ||
            m.manager_name?.toLowerCase().includes(q)
        );
    }, [chart, search]);

    // Build manager→children map for tree view
    const { childrenMap, roots } = useMemo(() => {
        if (!chart) return { childrenMap: {}, roots: [] };
        const allIds = new Set(chart.members.map(m => m.id));
        const map = {};
        for (const m of chart.members) {
            const pid = m.manager_id && allIds.has(m.manager_id) ? m.manager_id : null;
            if (!map[pid]) map[pid] = [];
            map[pid].push(m);
        }
        // Sort each level by name
        for (const k of Object.keys(map)) map[k].sort((a, b) => a.full_name.localeCompare(b.full_name));
        return { childrenMap: map, roots: map[null] || [] };
    }, [chart]);

    if (!chart) return <div className={oc['loading']}>Loading org chart…</div>;

    const unassigned = chart.members.filter(m => !m.department_id && !m.team_id);
    const filteredUnassigned = filteredMembers.filter(m => !m.department_id && !m.team_id);
    const totalVisible = viewMode === 'dept' ? filteredMembers.length : chart.members.length;

    return (
        <div>
            {/* Controls */}
            <div className={oc['chart-controls']}>
                <div className={oc['view-toggle']}>
                    <button
                        className={`${oc['view-btn']} ${viewMode === 'dept' ? oc['view-btn-active'] : ''}`}
                        onClick={() => setViewMode('dept')}
                    >🏢 By Department</button>
                    <button
                        className={`${oc['view-btn']} ${viewMode === 'tree' ? oc['view-btn-active'] : ''}`}
                        onClick={() => setViewMode('tree')}
                    >👥 Reporting Lines</button>
                </div>
                <div className={oc['search-box']}>
                    <span className={oc['search-icon']}>🔍</span>
                    <input
                        type="text"
                        placeholder="Filter by name, role, or manager…"
                        value={search}
                        onChange={e => setSearch(e.target.value)}
                        className={oc['search-input']}
                    />
                    {search && <button className={oc['search-clear']} onClick={() => setSearch('')}>✕</button>}
                </div>
                <span className={oc['member-total']}>{totalVisible} member{totalVisible !== 1 ? 's' : ''}</span>
            </div>

            {/* Department / Team view */}
            {viewMode === 'dept' && (
                <>
                    {chart.departments.map(dept => {
                        // Only include dept if it has matching members (or no search)
                        const hasMatch = filteredMembers.some(m => m.department_id === dept.id);
                        if (search && !hasMatch) return null;
                        return (
                            <DeptCard
                                key={dept.id}
                                dept={dept}
                                teams={chart.teams}
                                members={filteredMembers}
                                highlight={search}
                            />
                        );
                    })}
                    {filteredUnassigned.length > 0 && (
                        <div className={oc['card-panel']}>
                            <div className={oc['dept-header']}>
                                <span className={oc['dept-icon']}>❓</span>
                                <div className={oc['dept-name']}>
                                    Unassigned
                                    <span className={oc['headcount-badge']}>{filteredUnassigned.length}</span>
                                </div>
                            </div>
                            <div className={oc['flex-wrap']}>
                                {filteredUnassigned.map(m => <MemberChip key={m.id} member={m} highlight={search} />)}
                            </div>
                        </div>
                    )}
                    {search && filteredMembers.length === 0 && (
                        <p style={{ color: 'var(--text-secondary)', textAlign: 'center', padding: '2rem' }}>
                            No members match "{search}"
                        </p>
                    )}
                </>
            )}

            {/* Reporting tree view */}
            {viewMode === 'tree' && (
                <div className={oc['tree-root']}>
                    {roots.length === 0 ? (
                        <p style={{ color: 'var(--text-secondary)', textAlign: 'center', padding: '2rem' }}>
                            No reporting lines configured — assign managers to employees to build the hierarchy.
                        </p>
                    ) : (
                        roots.map(r => (
                            <TreeNode
                                key={r.id}
                                member={r}
                                childrenMap={childrenMap}
                                depth={0}
                                highlight={search}
                            />
                        ))
                    )}
                </div>
            )}
        </div>
    );
}

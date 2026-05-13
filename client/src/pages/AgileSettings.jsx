/**
 * AgileSettings — tenant-level Agile administration UI.
 *
 * Tabs:
 *   1. General  — estimation scale, story-point unit, feature flags, DoD
 *   2. Types    — manage Work Item Types (Story / Bug / Task / Epic / custom)
 *   3. Workflow — manage Workflow States (Kanban columns) — categories,
 *                 colours, WIP limits
 *   4. Access   — request edit access (any user) + super_admin grants/requests
 *
 * Edit actions are gated client-side on `permissions.canEdit`. The backend
 * also enforces this so any UI bypass attempt fails.
 */
import React, { useEffect, useMemo, useState } from 'react';
import {
    Plus, Trash2, Save, Settings as SettingsIcon, Layers, Workflow as WorkflowIcon,
    Lock, ShieldCheck, Tag, ListChecks,
} from 'lucide-react';
import TaskLabelsTab from './admin/TaskLabelsTab';
import CustomFieldsTab from './CustomFieldsTab';
import {
    getAgileSettings, updateAgileSettings,
    getWorkItemTypes, createWorkItemType, updateWorkItemType, deleteWorkItemType, reorderWorkItemTypes,
    getWorkflowStates, createWorkflowState, updateWorkflowState, deleteWorkflowState, reorderWorkflowStates,
    getAgilePermissions,
} from '../api';
import { useAgileConfig } from '../AgileConfigContext';
import s from './AgileSettings.module.css';

const CATEGORIES = [
    { key: 'open', label: 'Open / To Do', color: '#6b7280' },
    { key: 'in_progress', label: 'In Progress', color: '#f59e0b' },
    { key: 'in_review', label: 'In Review', color: '#3b82f6' },
    { key: 'done', label: 'Done', color: '#10b981' },
];

const ESTIMATION_PRESETS = {
    fibonacci: [0.5, 1, 2, 3, 5, 8, 13, 21, 34],
    linear: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    tshirt: ['XS', 'S', 'M', 'L', 'XL', 'XXL'],
    hours: [1, 2, 4, 8, 16, 24, 40],
    none: [],
    custom: [],
};

export default function AgileSettings() {
    const { refresh: refreshConfig } = useAgileConfig();
    const [tab, setTab] = useState('general');
    // We only use the `canEdit` + role for the header badge — per role rules
    // (super_admin / hr_admin / platform_admin / manager / team_lead /
    // scrum_master can edit, others are read-only). The grant/request UI was
    // removed; access is purely role-based now.
    const [perms, setPerms] = useState({ canEdit: false, isSuperAdmin: false, role: '' });
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');

    useEffect(() => {
        getAgilePermissions().then(r => setPerms(r.data)).catch(() => { }).finally(() => setLoading(false));
    }, []);

    if (loading) return <div className={s.page}><div className={s.loading}>Loading…</div></div>;

    return (
        <div className={s.page}>
            <header className={s.header}>
                <div>
                    <h1 className={s.title}>Agile Configuration</h1>
                    <p className={s.subtitle}>Customise your team's work item types, workflow states and estimation rules.</p>
                </div>
                <div className={s.permsBadge}>
                    {perms.canEdit
                        ? <span className={s.canEdit}>
                            <ShieldCheck size={14} />
                            {perms.isSuperAdmin
                                ? 'Super Admin'
                                : (perms.role
                                    ? `Editor (${perms.role.replace(/_/g, ' ')})`
                                    : 'Editor')}
                          </span>
                        : <span className={s.readOnly}><Lock size={14} /> Read-only</span>}
                </div>
            </header>

            <nav className={s.tabs}>
                <button onClick={() => setTab('general')} className={`${s.tabBtn} ${tab === 'general' ? s.active : ''}`}><SettingsIcon size={14} /> General</button>
                <button onClick={() => setTab('types')} className={`${s.tabBtn} ${tab === 'types' ? s.active : ''}`}><Layers size={14} /> Work Item Types</button>
                <button onClick={() => setTab('workflow')} className={`${s.tabBtn} ${tab === 'workflow' ? s.active : ''}`}><WorkflowIcon size={14} /> Workflow</button>
                <button onClick={() => setTab('labels')} className={`${s.tabBtn} ${tab === 'labels' ? s.active : ''}`}><Tag size={14} /> Labels</button>
                <button onClick={() => setTab('custom-fields')} className={`${s.tabBtn} ${tab === 'custom-fields' ? s.active : ''}`}><ListChecks size={14} /> Custom Fields</button>
            </nav>

            {error && <div className={s.error}>{error}</div>}

            {tab === 'general' && <GeneralTab canEdit={perms.canEdit} onSaved={refreshConfig} setError={setError} />}
            {tab === 'types' && <TypesTab canEdit={perms.canEdit} onChanged={refreshConfig} setError={setError} />}
            {tab === 'workflow' && <WorkflowTab canEdit={perms.canEdit} onChanged={refreshConfig} setError={setError} />}
            {tab === 'labels' && (
                <div className={s.card}>
                    <h2 className={s.sectionTitle}>Task Labels</h2>
                    <p className={s.helpText}>
                        <strong>Labels</strong> are free-form tags used for cross-cutting filtering and reporting
                        (e.g. <em>frontend</em>, <em>tech-debt</em>, <em>customer-X</em>, <em>Q4-OKR</em>).
                        A ticket can carry many labels, but only one Work Item Type.
                    </p>
                    <TaskLabelsTab />
                </div>
            )}
            {tab === 'custom-fields' && (
                <div className={s.card}>
                    <h2 className={s.sectionTitle}>Custom Fields</h2>
                    <p className={s.helpText}>
                        Add tenant-specific fields shown on every task — text, number, date,
                        dropdown, multi-select, checkbox, or URL. Each field can be required,
                        scoped to specific work item types, and (optionally) shown directly on
                        the task card. Field definitions are stored per organisation; values
                        live per task.
                    </p>
                    <CustomFieldsTab canEdit={perms.canEdit} />
                </div>
            )}
        </div>
    );
}

// ─── General tab ────────────────────────────────────────────────────────────
function GeneralTab({ canEdit, onSaved, setError }) {
    const [settings, setSettings] = useState(null);
    const [saving, setSaving] = useState(false);
    useEffect(() => { getAgileSettings().then(r => setSettings(r.data)); }, []);

    const updateField = (key, val) => setSettings(s => ({ ...s, [key]: val }));

    const handleEstimationType = (type) => {
        setSettings(s => ({
            ...s,
            estimation_type: type,
            estimation_values: ESTIMATION_PRESETS[type] !== undefined && type !== 'custom'
                ? ESTIMATION_PRESETS[type]
                : s.estimation_values,
        }));
    };

    const save = async () => {
        if (!canEdit || !settings) return;
        setSaving(true); setError('');
        try {
            await updateAgileSettings(settings);
            onSaved && onSaved();
        } catch (e) { setError(e?.response?.data?.error || 'Failed to save'); }
        finally { setSaving(false); }
    };

    if (!settings) return <div className={s.loading}>Loading…</div>;

    return (
        <div className={s.card}>
            <h2 className={s.sectionTitle}>Estimation</h2>
            <div className={s.formRow}>
                <label>Scale type</label>
                <select disabled={!canEdit} value={settings.estimation_type} onChange={e => handleEstimationType(e.target.value)}>
                    <option value="fibonacci">Fibonacci (0.5, 1, 2, 3, 5, 8, 13, 21, 34)</option>
                    <option value="linear">Linear (1–10)</option>
                    <option value="tshirt">T-shirt (XS / S / M / L / XL / XXL)</option>
                    <option value="hours">Hours (1, 2, 4, 8, 16, 24, 40)</option>
                    <option value="none">None — disable estimation</option>
                    <option value="custom">Custom</option>
                </select>
            </div>
            <div className={s.formRow}>
                <label>Scale values (comma-separated)</label>
                <input
                    disabled={!canEdit || settings.estimation_type === 'none'}
                    value={Array.isArray(settings.estimation_values) ? settings.estimation_values.join(', ') : ''}
                    onChange={e => updateField('estimation_values', e.target.value.split(',').map(v => v.trim()).filter(Boolean).map(v => isNaN(Number(v)) ? v : Number(v)))}
                />
            </div>
            <div className={s.formRow}>
                <label>Unit label</label>
                <input disabled={!canEdit} value={settings.estimation_unit_label || ''} onChange={e => updateField('estimation_unit_label', e.target.value)} placeholder="SP" />
            </div>

            <h2 className={s.sectionTitle}>Features</h2>
            <div className={s.flagGrid}>
                {[
                    ['enable_story_points', 'Story Points'],
                    ['enable_epics', 'Epics & parent links'],
                    ['enable_dependencies', 'Dependencies / blocked-by graph'],
                    ['enable_acceptance_criteria', 'Acceptance Criteria'],
                    ['enable_blockers', 'Blocker badges'],
                    ['enable_wip_limits', 'WIP limits per column'],
                    ['enable_retrospectives', 'Sprint Retrospectives'],
                    ['require_estimate_for_sprint', 'Require estimate before adding to sprint'],
                ].map(([k, label]) => (
                    <label key={k} className={s.flag}>
                        <input type="checkbox" disabled={!canEdit} checked={!!settings[k]} onChange={e => updateField(k, e.target.checked)} />
                        {label}
                    </label>
                ))}
            </div>

            <h2 className={s.sectionTitle}>Definition of Done (default)</h2>
            <textarea
                disabled={!canEdit}
                rows={6}
                value={settings.default_dod || ''}
                onChange={e => updateField('default_dod', e.target.value)}
                placeholder="- Code reviewed&#10;- Tests pass&#10;- Documentation updated"
            />

            <div className={s.formActions}>
                <button className="btn btn-primary" disabled={!canEdit || saving} onClick={save}>
                    <Save size={14} /> {saving ? 'Saving…' : 'Save Settings'}
                </button>
            </div>
        </div>
    );
}

// ─── Types tab ──────────────────────────────────────────────────────────────
function TypesTab({ canEdit, onChanged, setError }) {
    const [list, setList] = useState([]);
    const [adding, setAdding] = useState(false);
    const [form, setForm] = useState({ name: '', color: '#6366f1', icon: '', is_epic: false, is_default: false, description: '' });

    const reload = () => getWorkItemTypes().then(r => setList(r.data));
    useEffect(() => { reload(); }, []);

    const submitNew = async (e) => {
        e.preventDefault();
        try {
            await createWorkItemType(form);
            setForm({ name: '', color: '#6366f1', icon: '', is_epic: false, is_default: false, description: '' });
            setAdding(false);
            reload(); onChanged && onChanged();
        } catch (e) { setError(e?.response?.data?.error || 'Failed to create'); }
    };

    const save = async (id, patch) => {
        try { await updateWorkItemType(id, patch); reload(); onChanged && onChanged(); }
        catch (e) { setError(e?.response?.data?.error || 'Failed to update'); }
    };

    const remove = async (id, name) => {
        if (!window.confirm(`Delete "${name}"? This will fail if any tasks still use it.`)) return;
        try { await deleteWorkItemType(id); reload(); onChanged && onChanged(); }
        catch (e) { setError(e?.response?.data?.error || 'Failed to delete'); }
    };

    return (
        <div className={s.card}>
            <div className={s.sectionHead}>
                <h2 className={s.sectionTitle}>Work Item Types</h2>
                {canEdit && (
                    <button className="btn btn-primary btn-sm" onClick={() => setAdding(v => !v)}>
                        <Plus size={13} /> {adding ? 'Cancel' : 'Add Type'}
                    </button>
                )}
            </div>
            <p className={s.helpText}>
                <strong>Work Item Types</strong> classify <em>what kind</em> of work a ticket is —
                each ticket has exactly one type (Story / Bug / Task / Epic / Spike / etc.).
                <br />
                <strong>Labels</strong> (managed in the <em>Labels</em> tab here) are free-form tags —
                a ticket can have many, and they're typically used for cross-cutting concerns like
                "frontend", "tech-debt", "needs-design", "Q4-OKR".
            </p>

            {adding && canEdit && (
                <form className={s.inlineForm} onSubmit={submitNew}>
                    <input required placeholder="Name (e.g. Spike)" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} />
                    <input type="color" value={form.color} onChange={e => setForm({ ...form, color: e.target.value })} />
                    <input placeholder="Icon name" value={form.icon} onChange={e => setForm({ ...form, icon: e.target.value })} />
                    <label><input type="checkbox" checked={form.is_epic} onChange={e => setForm({ ...form, is_epic: e.target.checked })} /> Epic</label>
                    <label><input type="checkbox" checked={form.is_default} onChange={e => setForm({ ...form, is_default: e.target.checked })} /> Default</label>
                    <button className="btn btn-primary btn-sm" type="submit">Create</button>
                </form>
            )}

            <table className={s.table}>
                <thead><tr><th>Type</th><th>Color</th><th>Default</th><th>Epic</th><th>Active</th><th>Actions</th></tr></thead>
                <tbody>
                    {list.map(t => (
                        <tr key={t.id}>
                            <td>
                                <input className={s.cellInput} disabled={!canEdit} value={t.name}
                                    onBlur={e => e.target.value !== t.name && save(t.id, { name: e.target.value })}
                                    onChange={e => setList(list.map(x => x.id === t.id ? { ...x, name: e.target.value } : x))}
                                />
                            </td>
                            <td><input type="color" disabled={!canEdit} value={t.color} onChange={e => save(t.id, { color: e.target.value })} /></td>
                            <td><input type="checkbox" disabled={!canEdit} checked={!!t.is_default} onChange={e => save(t.id, { is_default: e.target.checked })} /></td>
                            <td><input type="checkbox" disabled={!canEdit} checked={!!t.is_epic} onChange={e => save(t.id, { is_epic: e.target.checked })} /></td>
                            <td><input type="checkbox" disabled={!canEdit} checked={!!t.is_active} onChange={e => save(t.id, { is_active: e.target.checked })} /></td>
                            <td>{canEdit && <button className="btn btn-danger btn-sm" onClick={() => remove(t.id, t.name)}><Trash2 size={13} /></button>}</td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}

// ─── Workflow tab ───────────────────────────────────────────────────────────
function WorkflowTab({ canEdit, onChanged, setError }) {
    const [list, setList] = useState([]);
    const [adding, setAdding] = useState(false);
    const [form, setForm] = useState({ name: '', category: 'open', color: '#6b7280', wip_limit: '', is_initial: false, is_terminal: false });

    const reload = () => getWorkflowStates().then(r => setList(r.data));
    useEffect(() => { reload(); }, []);

    const submitNew = async (e) => {
        e.preventDefault();
        try {
            const payload = { ...form, wip_limit: form.wip_limit ? parseInt(form.wip_limit, 10) : null };
            await createWorkflowState(payload);
            setForm({ name: '', category: 'open', color: '#6b7280', wip_limit: '', is_initial: false, is_terminal: false });
            setAdding(false);
            reload(); onChanged && onChanged();
        } catch (e) { setError(e?.response?.data?.error || 'Failed to create'); }
    };

    const save = async (id, patch) => {
        try { await updateWorkflowState(id, patch); reload(); onChanged && onChanged(); }
        catch (e) { setError(e?.response?.data?.error || 'Failed to update'); }
    };

    const remove = async (id, name) => {
        if (!window.confirm(`Delete state "${name}"? This will fail if any tasks are still in it.`)) return;
        try { await deleteWorkflowState(id); reload(); onChanged && onChanged(); }
        catch (e) { setError(e?.response?.data?.error || 'Failed to delete'); }
    };

    // Group by category for visual reassurance about coverage
    const grouped = useMemo(() => {
        const g = { open: [], in_progress: [], in_review: [], done: [] };
        for (const r of list) if (g[r.category]) g[r.category].push(r);
        return g;
    }, [list]);

    return (
        <div className={s.card}>
            <div className={s.sectionHead}>
                <h2 className={s.sectionTitle}>Workflow States</h2>
                {canEdit && (
                    <button className="btn btn-primary btn-sm" onClick={() => setAdding(v => !v)}>
                        <Plus size={13} /> {adding ? 'Cancel' : 'Add State'}
                    </button>
                )}
            </div>
            <p className={s.helpText}>
                Every workflow must keep <strong>at least one active state in each of the 4 categories</strong>:
                Open, In Progress, In Review, Done. You cannot delete a state that still has tasks in it.
            </p>
            <div className={s.helpGlossary}>
                <div><strong>WIP</strong> — <em>Work In Progress</em> limit. Maximum number of tickets allowed
                    in this column at the same time. The board badge turns red when exceeded so the team can
                    swarm and unblock work instead of starting more. Leave blank for no limit.
                </div>
                <div><strong>Initial</strong> — The starting state for any newly created ticket. Exactly one
                    state across the whole workflow should be marked as initial (typically <em>To Do</em>).
                </div>
                <div><strong>Terminal</strong> — A "finished" state. Tickets in a terminal state are counted
                    as completed for sprint progress, burndown and velocity. Mark <em>Done</em> (and any other
                    closing state like <em>Cancelled</em> or <em>Won't Fix</em>) as terminal.
                </div>
                <div><strong>Active</strong> — Whether the state is shown on the board. Uncheck to retire a
                    state without deleting historical references to it.
                </div>
            </div>

            {adding && canEdit && (
                <form className={s.inlineForm} onSubmit={submitNew}>
                    <input required placeholder="Name (e.g. Triage)" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} />
                    <select value={form.category} onChange={e => setForm({ ...form, category: e.target.value })}>
                        {CATEGORIES.map(c => <option key={c.key} value={c.key}>{c.label}</option>)}
                    </select>
                    <input type="color" value={form.color} onChange={e => setForm({ ...form, color: e.target.value })} />
                    <input type="number" min="1" placeholder="WIP" value={form.wip_limit} onChange={e => setForm({ ...form, wip_limit: e.target.value })} />
                    <label><input type="checkbox" checked={form.is_initial} onChange={e => setForm({ ...form, is_initial: e.target.checked })} /> Initial</label>
                    <label><input type="checkbox" checked={form.is_terminal} onChange={e => setForm({ ...form, is_terminal: e.target.checked })} /> Terminal</label>
                    <button className="btn btn-primary btn-sm" type="submit">Create</button>
                </form>
            )}

            {CATEGORIES.map(cat => (
                <div key={cat.key} className={s.categoryGroup}>
                    <h3 className={s.categoryTitle} style={{ borderColor: cat.color }}>
                        <span className={s.dot} style={{ background: cat.color }} /> {cat.label}
                    </h3>
                    {grouped[cat.key].length === 0 && (
                        <div className={s.warn}>⚠ No active state in this category — add one to keep reporting accurate.</div>
                    )}
                    <table className={s.table}>
                        <thead>
                            <tr>
                                <th>Name</th>
                                <th>Color</th>
                                <th title="Work In Progress limit — max tickets allowed in this column">WIP</th>
                                <th title="Starting state for new tickets">Initial</th>
                                <th title="Counts as 'Done' for sprint progress / burndown / velocity">Terminal</th>
                                <th title="Whether the state is shown on the board">Active</th>
                                <th>Actions</th>
                            </tr>
                        </thead>
                        <tbody>
                            {grouped[cat.key].map(t => (
                                <tr key={t.id}>
                                    <td>
                                        <input className={s.cellInput} disabled={!canEdit} defaultValue={t.name}
                                            onBlur={e => e.target.value !== t.name && save(t.id, { name: e.target.value })} />
                                    </td>
                                    <td><input type="color" disabled={!canEdit} value={t.color} onChange={e => save(t.id, { color: e.target.value })} /></td>
                                    <td><input type="number" min="0" disabled={!canEdit} defaultValue={t.wip_limit ?? ''}
                                        onBlur={e => save(t.id, { wip_limit: e.target.value === '' ? null : parseInt(e.target.value, 10) })} className={s.wipInput} /></td>
                                    <td><input type="checkbox" disabled={!canEdit} checked={!!t.is_initial} onChange={e => save(t.id, { is_initial: e.target.checked })} /></td>
                                    <td><input type="checkbox" disabled={!canEdit} checked={!!t.is_terminal} onChange={e => save(t.id, { is_terminal: e.target.checked })} /></td>
                                    <td><input type="checkbox" disabled={!canEdit} checked={!!t.is_active} onChange={e => save(t.id, { is_active: e.target.checked })} /></td>
                                    <td>{canEdit && <button className="btn btn-danger btn-sm" onClick={() => remove(t.id, t.name)}><Trash2 size={13} /></button>}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            ))}
        </div>
    );
}

// (Access tab removed — Agile config edit access is now purely role-based.
// See server/middleware/agileEditor.js for the allow-list:
// super_admin / platform_admin / hr_admin / manager / team_lead / scrum_master.)

import { useState, useEffect, useCallback } from 'react';
import { Plus, Trash2, Edit2, Save, X, Users, LayoutTemplate } from 'lucide-react';
import {
    getCompensationTemplates, createCompensationTemplate, updateCompensationTemplate,
    deleteCompensationTemplate, getEmployeeCompensations, assignCompensation,
} from '../../api';
import s from './AdminPages.module.css';

const DEFAULT_COMPONENTS = [
    { key: 'basic', label: 'Basic Salary', type: 'earning', calc_type: 'fixed', taxable: true },
    { key: 'hra', label: 'HRA', type: 'earning', calc_type: 'fixed', taxable: true },
    { key: 'conveyance', label: 'Conveyance Allowance', type: 'earning', calc_type: 'fixed', taxable: false },
    { key: 'special_allowance', label: 'Special Allowance', type: 'earning', calc_type: 'fixed', taxable: true },
    { key: '_ded_pf', label: 'Provident Fund', type: 'deduction', calc_type: 'fixed', taxable: false },
    { key: '_ded_professional_tax', label: 'Professional Tax', type: 'deduction', calc_type: 'fixed', taxable: false },
    { key: '_ded_tds', label: 'Income Tax (TDS)', type: 'deduction', calc_type: 'fixed', taxable: false },
];

export default function CompensationSetup() {
    const [tab, setTab] = useState('templates');
    const [templates, setTemplates] = useState([]);
    const [employees, setEmployees] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');

    // Template form
    const [editingTemplate, setEditingTemplate] = useState(null);
    const [templateForm, setTemplateForm] = useState({ name: '', description: '', components: DEFAULT_COMPONENTS, is_default: false });

    // Employee compensation form
    const [assignModal, setAssignModal] = useState(null);
    const [assignForm, setAssignForm] = useState({ effective_from: '', base_salary: '', components: {} });

    const loadTemplates = useCallback(async () => {
        try {
            const res = await getCompensationTemplates();
            setTemplates(res.data);
        } catch { setError('Failed to load templates'); }
    }, []);

    const loadEmployees = useCallback(async () => {
        try {
            const res = await getEmployeeCompensations();
            setEmployees(res.data);
        } catch { setError('Failed to load employee compensations'); }
    }, []);

    useEffect(() => {
        setLoading(true);
        Promise.all([loadTemplates(), loadEmployees()]).finally(() => setLoading(false));
    }, [loadTemplates, loadEmployees]);

    const handleSaveTemplate = async (e) => {
        e.preventDefault();
        setError('');
        try {
            if (editingTemplate) {
                await updateCompensationTemplate(editingTemplate.id, templateForm);
            } else {
                await createCompensationTemplate(templateForm);
            }
            setEditingTemplate(null);
            setTemplateForm({ name: '', description: '', components: DEFAULT_COMPONENTS, is_default: false });
            loadTemplates();
        } catch (err) {
            setError(err.response?.data?.error || 'Failed to save template');
        }
    };

    const handleDeleteTemplate = async (id) => {
        if (!window.confirm('Delete this template?')) return;
        try {
            await deleteCompensationTemplate(id);
            loadTemplates();
        } catch (err) {
            alert(err.response?.data?.error || 'Cannot delete template');
        }
    };

    const handleAssign = async (e) => {
        e.preventDefault();
        setError('');
        try {
            await assignCompensation(assignModal.id || assignModal.user_id, assignForm);
            setAssignModal(null);
            loadEmployees();
        } catch (err) {
            setError(err.response?.data?.error || 'Failed to assign compensation');
        }
    };

    const addComponent = () => {
        setTemplateForm(f => ({
            ...f,
            components: [...f.components, { key: '', label: '', type: 'earning', calc_type: 'fixed', taxable: false }],
        }));
    };

    const removeComponent = (idx) => {
        setTemplateForm(f => ({
            ...f,
            components: f.components.filter((_, i) => i !== idx),
        }));
    };

    const updateComponent = (idx, field, value) => {
        setTemplateForm(f => ({
            ...f,
            components: f.components.map((c, i) => i === idx ? { ...c, [field]: value } : c),
        }));
    };

    if (loading) return <div className={s.loading}>Loading...</div>;

    return (
        <div>
            <h2 className={s.pageTitle}>Compensation Management</h2>

            <div className={s.tabBar}>
                <button className={`${s.tabBtn} ${tab === 'templates' ? s.active : ''}`} onClick={() => setTab('templates')}>
                    <LayoutTemplate size={14} /> Templates
                </button>
                <button className={`${s.tabBtn} ${tab === 'employees' ? s.active : ''}`} onClick={() => setTab('employees')}>
                    <Users size={14} /> Employees
                </button>
            </div>

            {error && <div className={s.error}>{error}</div>}

            {tab === 'templates' && (
                <div>
                    <form onSubmit={handleSaveTemplate} className={s.formCard}>
                        <h3>{editingTemplate ? 'Edit Template' : 'Create Template'}</h3>
                        <div className={s.formRow}>
                            <input
                                placeholder="Template Name"
                                value={templateForm.name}
                                onChange={e => setTemplateForm(f => ({ ...f, name: e.target.value }))}
                                required
                                className={s.input}
                            />
                            <input
                                placeholder="Description (optional)"
                                value={templateForm.description}
                                onChange={e => setTemplateForm(f => ({ ...f, description: e.target.value }))}
                                className={s.input}
                            />
                            <label className={s.checkLabel}>
                                <input
                                    type="checkbox"
                                    checked={templateForm.is_default}
                                    onChange={e => setTemplateForm(f => ({ ...f, is_default: e.target.checked }))}
                                />
                                Default
                            </label>
                        </div>

                        <h4>Components</h4>
                        <div className={s.componentList}>
                            {templateForm.components.map((comp, idx) => (
                                <div key={idx} className={s.componentRow}>
                                    <input
                                        placeholder="Key (e.g. hra)"
                                        value={comp.key}
                                        onChange={e => updateComponent(idx, 'key', e.target.value)}
                                        className={s.inputSm}
                                        required
                                    />
                                    <input
                                        placeholder="Label"
                                        value={comp.label}
                                        onChange={e => updateComponent(idx, 'label', e.target.value)}
                                        className={s.inputSm}
                                        required
                                    />
                                    <select
                                        value={comp.type}
                                        onChange={e => updateComponent(idx, 'type', e.target.value)}
                                        className={s.selectSm}
                                    >
                                        <option value="earning">Earning</option>
                                        <option value="deduction">Deduction</option>
                                    </select>
                                    <button type="button" onClick={() => removeComponent(idx)} className={s.iconBtn} title="Remove">
                                        <Trash2 size={14} />
                                    </button>
                                </div>
                            ))}
                        </div>
                        <button type="button" onClick={addComponent} className={s.linkBtn}>
                            <Plus size={14} /> Add Component
                        </button>

                        <div className={s.formActions}>
                            <button type="submit" className={s.btnPrimary}>
                                <Save size={14} /> {editingTemplate ? 'Update' : 'Create'}
                            </button>
                            {editingTemplate && (
                                <button type="button" className={s.btnSecondary} onClick={() => {
                                    setEditingTemplate(null);
                                    setTemplateForm({ name: '', description: '', components: DEFAULT_COMPONENTS, is_default: false });
                                }}>
                                    <X size={14} /> Cancel
                                </button>
                            )}
                        </div>
                    </form>

                    <div className={s.tableWrap}>
                        <table className={s.table}>
                            <thead>
                                <tr>
                                    <th>Name</th>
                                    <th>Components</th>
                                    <th>Default</th>
                                    <th>Actions</th>
                                </tr>
                            </thead>
                            <tbody>
                                {templates.map(t => (
                                    <tr key={t.id}>
                                        <td><strong>{t.name}</strong><br /><small>{t.description}</small></td>
                                        <td>{(t.components || []).length} items</td>
                                        <td>{t.is_default ? 'Yes' : '-'}</td>
                                        <td>
                                            <button className={s.iconBtn} onClick={() => {
                                                setEditingTemplate(t);
                                                setTemplateForm({ name: t.name, description: t.description || '', components: t.components || [], is_default: t.is_default });
                                            }}>
                                                <Edit2 size={14} />
                                            </button>
                                            <button className={s.iconBtn} onClick={() => handleDeleteTemplate(t.id)}>
                                                <Trash2 size={14} />
                                            </button>
                                        </td>
                                    </tr>
                                ))}
                                {templates.length === 0 && <tr><td colSpan={4}>No templates yet</td></tr>}
                            </tbody>
                        </table>
                    </div>
                </div>
            )}

            {tab === 'employees' && (
                <div>
                    <div className={s.tableWrap}>
                        <table className={s.table}>
                            <thead>
                                <tr>
                                    <th>Employee</th>
                                    <th>Department</th>
                                    <th>Base Salary</th>
                                    <th>Effective From</th>
                                    <th>Actions</th>
                                </tr>
                            </thead>
                            <tbody>
                                {employees.map(emp => (
                                    <tr key={emp.id}>
                                        <td><strong>{emp.full_name}</strong><br /><small>{emp.email}</small></td>
                                        <td>{emp.department_name || '-'}</td>
                                        <td>₹{Number(emp.base_salary).toLocaleString('en-IN')}</td>
                                        <td>{emp.effective_from}</td>
                                        <td>
                                            <button className={s.iconBtn} onClick={() => {
                                                setAssignModal(emp);
                                                setAssignForm({
                                                    effective_from: new Date().toISOString().slice(0, 10),
                                                    base_salary: emp.base_salary,
                                                    components: emp.components || {},
                                                    template_id: emp.template_id,
                                                });
                                            }}>
                                                <Edit2 size={14} />
                                            </button>
                                        </td>
                                    </tr>
                                ))}
                                {employees.length === 0 && <tr><td colSpan={5}>No compensation records. Assign salary to employees.</td></tr>}
                            </tbody>
                        </table>
                    </div>
                </div>
            )}

            {/* Assign compensation modal */}
            {assignModal && (
                <div className={s.modalOverlay} onClick={() => setAssignModal(null)}>
                    <div className={s.modal} onClick={e => e.stopPropagation()}>
                        <h3>Assign Compensation — {assignModal.full_name || 'Employee'}</h3>
                        <form onSubmit={handleAssign}>
                            <div className={s.formRow}>
                                <label>Effective From</label>
                                <input
                                    type="date"
                                    value={assignForm.effective_from}
                                    onChange={e => setAssignForm(f => ({ ...f, effective_from: e.target.value }))}
                                    required
                                    className={s.input}
                                />
                            </div>
                            <div className={s.formRow}>
                                <label>Base Salary (Monthly)</label>
                                <input
                                    type="number"
                                    value={assignForm.base_salary}
                                    onChange={e => setAssignForm(f => ({ ...f, base_salary: e.target.value }))}
                                    required
                                    min="0"
                                    className={s.input}
                                />
                            </div>
                            <div className={s.formRow}>
                                <label>Template</label>
                                <select
                                    value={assignForm.template_id || ''}
                                    onChange={e => {
                                        const tid = e.target.value;
                                        setAssignForm(f => ({ ...f, template_id: tid || null }));
                                        if (tid) {
                                            const tmpl = templates.find(t => t.id === parseInt(tid));
                                            if (tmpl) {
                                                const comps = {};
                                                tmpl.components.forEach(c => { comps[c.key] = 0; });
                                                setAssignForm(f => ({ ...f, components: comps }));
                                            }
                                        }
                                    }}
                                    className={s.input}
                                >
                                    <option value="">No template</option>
                                    {templates.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                                </select>
                            </div>

                            <h4>Component Amounts</h4>
                            <div className={s.componentList}>
                                {Object.entries(assignForm.components).map(([key, val]) => (
                                    <div key={key} className={s.componentRow}>
                                        <span className={s.compLabel}>{key.replace(/_ded_/, '').replace(/_/g, ' ')}</span>
                                        <input
                                            type="number"
                                            value={val}
                                            onChange={e => setAssignForm(f => ({
                                                ...f,
                                                components: { ...f.components, [key]: parseFloat(e.target.value) || 0 },
                                            }))}
                                            min="0"
                                            className={s.inputSm}
                                        />
                                    </div>
                                ))}
                            </div>

                            <div className={s.formActions}>
                                <button type="submit" className={s.btnPrimary}><Save size={14} /> Save</button>
                                <button type="button" className={s.btnSecondary} onClick={() => setAssignModal(null)}>
                                    <X size={14} /> Cancel
                                </button>
                            </div>
                        </form>
                    </div>
                </div>
            )}
        </div>
    );
}

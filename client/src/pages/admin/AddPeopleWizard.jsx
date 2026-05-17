import React, { useState, useEffect, useMemo, useRef } from 'react';
import {
    UserPlus, Upload, Link as LinkIcon, ArrowLeft, ArrowRight, Check, Copy, Download,
    AlertTriangle, FileText, Trash2, Plus,
} from 'lucide-react';
import {
    createAdminUser, importUsers, getAdminOrganizations, getCurrentOrg,
    getOrgDepartments, getOrgTeams, createInviteCode,
} from '../../api';
import { ROLES, ROLE_LABELS } from './constants';
import s from './UserManagement.module.css';
import w from './AddPeopleWizard.module.css';

/**
 * AddPeopleWizard — unified flow that merges Create User + Import Users +
 * Invite Code generation into a single 3-step wizard:
 *
 *   Step 1: Choose method (single / bulk paste / file upload / invite link)
 *   Step 2: Provide data + review defaults (org, dept, team)
 *   Step 3: Send / generate, show results
 *
 * Props:
 *   userRole             – current admin role
 *   onCompleted(message) – called after a successful add (parent can navigate or refresh)
 */
const METHODS = [
    {
        key: 'single',
        title: 'Add one user',
        desc: 'Create a single account with full details.',
        icon: UserPlus,
    },
    {
        key: 'paste',
        title: 'Paste a list',
        desc: 'Paste rows from a spreadsheet or text editor.',
        icon: FileText,
    },
    {
        key: 'file',
        title: 'Upload a file',
        desc: 'CSV or JSON file (up to 200 users per batch).',
        icon: Upload,
    },
    {
        key: 'invite',
        title: 'Generate invite link',
        desc: 'Share a code or self-serve registration link.',
        icon: LinkIcon,
    },
];

export default function AddPeopleWizard({ userRole, onCompleted }) {
    const [step, setStep] = useState(1);
    const [method, setMethod] = useState(null);
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);
    const [result, setResult] = useState(null);

    // ─── Defaults shared across methods ───
    const [organizations, setOrganizations] = useState([]);
    const [departments, setDepartments] = useState([]);
    const [teams, setTeams] = useState([]);
    const [defaults, setDefaults] = useState({
        org_id: '', department_id: '', team_id: '', role: 'employee',
    });

    useEffect(() => {
        if (userRole === 'platform_admin') {
            getAdminOrganizations().then(r => {
                setOrganizations(r.data?.data || r.data || []);
            }).catch(() => {});
        } else {
            getCurrentOrg().then(r => {
                if (r.data?.id) {
                    setOrganizations([r.data]);
                    setDefaults(d => ({ ...d, org_id: String(r.data.id) }));
                }
            }).catch(() => {});
        }
    }, [userRole]);

    useEffect(() => {
        if (!defaults.org_id && userRole === 'platform_admin') {
            setDepartments([]); setTeams([]); return;
        }
        const orgParam = userRole === 'platform_admin' ? { org_id: defaults.org_id } : {};
        getOrgDepartments(orgParam).then(r => setDepartments(r.data || [])).catch(() => setDepartments([]));
        getOrgTeams(orgParam).then(r => setTeams(r.data || [])).catch(() => setTeams([]));
    }, [defaults.org_id, userRole]);

    const filteredTeams = useMemo(() =>
        defaults.department_id
            ? teams.filter(t => t.department_id === Number(defaults.department_id))
            : teams,
        [teams, defaults.department_id]);

    // ─── Single-user form ──
    const [singleForm, setSingleForm] = useState({
        full_name: '', username: '', email: '', password: '',
    });

    // ─── Paste / parsed rows ──
    const [pasted, setPasted] = useState('');
    const [parsedRows, setParsedRows] = useState([]);
    const [parseErrors, setParseErrors] = useState([]);

    // ─── File upload ──
    const fileRef = useRef(null);
    const [file, setFile] = useState(null);
    const [dragging, setDragging] = useState(false);

    // ─── Invite code form ──
    const [inviteForm, setInviteForm] = useState({ max_uses: '', expires_days: '7' });
    const [generatedCode, setGeneratedCode] = useState(null);
    const [copied, setCopied] = useState(null);

    // ─── Helpers ──────────────────────────────────────────────────────────
    const reset = () => {
        setStep(1);
        setMethod(null);
        setError(''); setBusy(false); setResult(null);
        setSingleForm({ full_name: '', username: '', email: '', password: '' });
        setPasted(''); setParsedRows([]); setParseErrors([]);
        setFile(null); setGeneratedCode(null);
    };

    /** Parse pasted text — accepts TSV/CSV with optional header row. */
    const parsePaste = (text) => {
        const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
        if (lines.length === 0) { setParsedRows([]); setParseErrors([]); return; }

        // Detect delimiter
        const first = lines[0];
        const delim = first.includes('\t') ? '\t' : (first.split(',').length > first.split(';').length ? ',' : ';');

        // Header detection: contains "name" or "email" or "username"
        const headerCells = first.split(delim).map(c => c.trim().toLowerCase());
        const hasHeader = headerCells.some(c => /name|email|user|role/.test(c));

        // Field positions
        const cols = hasHeader ? headerCells : ['full_name', 'email', 'username', 'role', 'department_name', 'team_name'];
        const dataLines = hasHeader ? lines.slice(1) : lines;

        const rows = [];
        const errors = [];
        dataLines.forEach((line, i) => {
            const cells = line.split(delim).map(c => c.trim());
            const row = {};
            cols.forEach((col, idx) => { row[col] = cells[idx] || ''; });

            // Validation
            const errs = [];
            if (!row.full_name) errs.push('missing name');
            if (!row.email) errs.push('missing email');
            else if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(row.email)) errs.push('invalid email');
            if (!row.username) {
                // Auto-generate from email local part
                row.username = (row.email.split('@')[0] || '').toLowerCase().replace(/[^a-z0-9_-]/g, '');
                if (!row.username) errs.push('cannot infer username');
            }
            if (errs.length) errors.push({ line: i + (hasHeader ? 2 : 1), errors: errs.join(', '), row });
            else rows.push(row);
        });
        setParsedRows(rows);
        setParseErrors(errors);
    };

    useEffect(() => { parsePaste(pasted); }, [pasted]);

    const handleFile = (f) => {
        if (!f) return;
        if (!/\.(csv|json)$/i.test(f.name)) {
            setError('Only .csv or .json files are accepted.');
            return;
        }
        setFile(f);
        setError('');
    };

    const handleDrop = (e) => {
        e.preventDefault();
        setDragging(false);
        handleFile(e.dataTransfer.files[0]);
    };

    // ─── Step 3: submit ──────────────────────────────────────────────────
    const submit = async () => {
        setError(''); setBusy(true); setResult(null);
        try {
            switch (method) {
                case 'single': {
                    const payload = {
                        ...singleForm,
                        role: defaults.role,
                    };
                    if (!payload.password) delete payload.password;
                    if (defaults.org_id) payload.org_id = Number(defaults.org_id);
                    if (defaults.department_id) payload.department_id = Number(defaults.department_id);
                    if (defaults.team_id) payload.team_id = Number(defaults.team_id);
                    const r = await createAdminUser(payload);
                    setResult({ kind: 'single', message: r.data.message, initial_password: r.data.initial_password });
                    onCompleted?.(r.data.message);
                    break;
                }
                case 'paste': {
                    if (parsedRows.length === 0) {
                        setError('No valid rows to import.');
                        setBusy(false);
                        return;
                    }
                    // Build CSV blob and submit via importUsers
                    const cols = ['username', 'full_name', 'email', 'role', 'department_name', 'team_name'];
                    const csv = [cols.join(',')].concat(
                        parsedRows.map(r => cols.map(c => {
                            let v = r[c];
                            if (c === 'role' && !v) v = defaults.role;
                            if (c === 'department_name' && !v && defaults.department_id) {
                                const d = departments.find(d => d.id === Number(defaults.department_id));
                                v = d?.name || '';
                            }
                            if (c === 'team_name' && !v && defaults.team_id) {
                                const t = teams.find(t => t.id === Number(defaults.team_id));
                                v = t?.name || '';
                            }
                            return `"${String(v ?? '').replace(/"/g, '""')}"`;
                        }).join(','))
                    ).join('\r\n');
                    const blob = new Blob([csv], { type: 'text/csv' });
                    const fd = new FormData();
                    fd.append('file', new File([blob], 'paste.csv', { type: 'text/csv' }));
                    const r = await importUsers(fd, true);
                    setResult({ kind: 'bulk', ...r.data });
                    if (r.data.imported > 0) onCompleted?.(`Added ${r.data.imported} user(s)`);
                    break;
                }
                case 'file': {
                    if (!file) { setError('No file selected.'); setBusy(false); return; }
                    const fd = new FormData();
                    fd.append('file', file);
                    const r = await importUsers(fd, true);
                    setResult({ kind: 'bulk', ...r.data });
                    if (r.data.imported > 0) onCompleted?.(`Added ${r.data.imported} user(s)`);
                    break;
                }
                case 'invite': {
                    const payload = { role: defaults.role };
                    if (inviteForm.max_uses) payload.max_uses = Number(inviteForm.max_uses);
                    if (inviteForm.expires_days) payload.expires_days = Number(inviteForm.expires_days);
                    const r = await createInviteCode(payload);
                    setGeneratedCode(r.data);
                    setResult({ kind: 'invite', code: r.data.code });
                    break;
                }
                default:
                    break;
            }
        } catch (e) {
            setError(e.response?.data?.error || 'Action failed');
        } finally {
            setBusy(false);
        }
    };

    const copy = async (text, key) => {
        try { await navigator.clipboard.writeText(text); setCopied(key); setTimeout(() => setCopied(null), 1800); } catch {}
    };

    // ─── Render helpers ──────────────────────────────────────────────────
    const renderStepIndicator = () => (
        <div className={w.steps}>
            {[1, 2, 3].map(n => {
                const labels = { 1: 'Method', 2: 'Details', 3: 'Send' };
                return (
                    <div key={n} className={`${w.step} ${step === n ? w.current : ''} ${step > n ? w.done : ''}`}>
                        <div className={w.stepDot}>{step > n ? <Check size={12} /> : n}</div>
                        <div className={w.stepLabel}>{labels[n]}</div>
                    </div>
                );
            })}
        </div>
    );

    // ─── Step 1 ──────────────────────────────────────────────────────────
    const renderStep1 = () => (
        <>
            <h3 className={w.h3}>How would you like to add people?</h3>
            <div className={w.methodGrid}>
                {METHODS.map(m => {
                    const Icon = m.icon;
                    const active = method === m.key;
                    return (
                        <button
                            key={m.key}
                            type="button"
                            className={`${w.methodCard} ${active ? w.methodActive : ''}`}
                            onClick={() => setMethod(m.key)}
                        >
                            <div className={w.methodIcon}><Icon size={22} /></div>
                            <div className={w.methodTitle}>{m.title}</div>
                            <div className={w.methodDesc}>{m.desc}</div>
                        </button>
                    );
                })}
            </div>
        </>
    );

    // ─── Step 2 ──────────────────────────────────────────────────────────
    const renderDefaults = () => (
        <div className={w.defaults}>
            <h4 className={w.h4}>Defaults</h4>
            <p className={w.helpText}>
                {method === 'single' && 'Set the role and assignment for this user.'}
                {method !== 'single' && method !== 'invite' && 'Apply these defaults when a row doesn\'t specify them.'}
                {method === 'invite' && 'New users registering with this code will be assigned these defaults.'}
            </p>
            <div className={w.fieldGrid}>
                <div className={w.field}>
                    <label>Role</label>
                    <select value={defaults.role} onChange={e => setDefaults(d => ({ ...d, role: e.target.value }))}>
                        {ROLES.map(r => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
                    </select>
                </div>
                {userRole === 'platform_admin' && (
                    <div className={w.field}>
                        <label>Organization</label>
                        <select
                            value={defaults.org_id}
                            onChange={e => setDefaults(d => ({ ...d, org_id: e.target.value, department_id: '', team_id: '' }))}
                        >
                            <option value="">— None —</option>
                            {organizations.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
                        </select>
                    </div>
                )}
                {method !== 'invite' && (
                    <>
                        <div className={w.field}>
                            <label>Department</label>
                            <select
                                value={defaults.department_id}
                                onChange={e => setDefaults(d => ({ ...d, department_id: e.target.value, team_id: '' }))}
                                disabled={userRole === 'platform_admin' && !defaults.org_id}
                            >
                                <option value="">— None —</option>
                                {departments.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
                            </select>
                        </div>
                        <div className={w.field}>
                            <label>Team</label>
                            <select
                                value={defaults.team_id}
                                onChange={e => setDefaults(d => ({ ...d, team_id: e.target.value }))}
                                disabled={userRole === 'platform_admin' && !defaults.org_id}
                            >
                                <option value="">— None —</option>
                                {filteredTeams.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                            </select>
                        </div>
                    </>
                )}
            </div>
        </div>
    );

    const renderStep2 = () => {
        if (method === 'single') {
            return (
                <>
                    <h3 className={w.h3}>Account details</h3>
                    <div className={w.fieldGrid}>
                        <div className={w.field}>
                            <label>Full name *</label>
                            <input
                                value={singleForm.full_name}
                                onChange={e => setSingleForm({ ...singleForm, full_name: e.target.value })}
                                placeholder="Jane Doe"
                            />
                        </div>
                        <div className={w.field}>
                            <label>Username *</label>
                            <input
                                value={singleForm.username}
                                onChange={e => setSingleForm({ ...singleForm, username: e.target.value })}
                                placeholder="janedoe"
                            />
                        </div>
                        <div className={w.field}>
                            <label>Email *</label>
                            <input
                                type="email"
                                value={singleForm.email}
                                onChange={e => setSingleForm({ ...singleForm, email: e.target.value })}
                                placeholder="jane@example.com"
                            />
                        </div>
                        <div className={w.field}>
                            <label>Initial password (min 8 chars, auto-generated if empty)</label>
                            <input
                                type="password"
                                value={singleForm.password}
                                onChange={e => setSingleForm({ ...singleForm, password: e.target.value })}
                                placeholder="Leave blank to auto-generate"
                            />
                        </div>
                    </div>
                    {renderDefaults()}
                </>
            );
        }

        if (method === 'paste') {
            return (
                <>
                    <h3 className={w.h3}>Paste rows</h3>
                    <p className={w.helpText}>
                        One user per line. Tabs, commas, or semicolons accepted. First row may be a header
                        (e.g. <code>full_name, email, username, role</code>).
                    </p>
                    <textarea
                        className={w.textarea}
                        rows={10}
                        value={pasted}
                        onChange={e => setPasted(e.target.value)}
                        placeholder={'full_name, email, username, role\nJane Doe, jane@example.com, janedoe, employee\nJohn Smith, john@example.com, johns, manager'}
                    />
                    {pasted && (
                        <div className={w.parseSummary}>
                            <span className={w.parseOk}>{parsedRows.length} valid</span>
                            {parseErrors.length > 0 && <span className={w.parseFail}>{parseErrors.length} skipped</span>}
                        </div>
                    )}
                    {parseErrors.length > 0 && (
                        <div className={w.errorList}>
                            <div className={w.errorListTitle}>Skipped rows:</div>
                            {parseErrors.slice(0, 5).map((e, i) => (
                                <div key={i} className={w.errorRow}>
                                    Line {e.line}: {e.errors}
                                </div>
                            ))}
                            {parseErrors.length > 5 && <div className={w.errorRow}>… and {parseErrors.length - 5} more</div>}
                        </div>
                    )}
                    {renderDefaults()}
                </>
            );
        }

        if (method === 'file') {
            return (
                <>
                    <h3 className={w.h3}>Upload a file</h3>
                    <p className={w.helpText}>
                        CSV or JSON, max 200 users per batch. Required columns:
                        <code> username, full_name, email</code>.
                        Optional: <code>password, role, department_name, team_name, manager_username</code>.
                    </p>
                    <div
                        className={`${w.dropZone} ${dragging ? w.dropActive : ''} ${file ? w.dropHasFile : ''}`}
                        onDragOver={e => { e.preventDefault(); setDragging(true); }}
                        onDragLeave={() => setDragging(false)}
                        onDrop={handleDrop}
                        onClick={() => fileRef.current?.click()}
                        role="button"
                        tabIndex={0}
                        onKeyDown={e => e.key === 'Enter' && fileRef.current?.click()}
                    >
                        <input
                            ref={fileRef}
                            type="file"
                            accept=".csv,.json"
                            style={{ display: 'none' }}
                            onChange={e => handleFile(e.target.files[0])}
                        />
                        {file ? (
                            <>
                                <Upload size={28} />
                                <strong>{file.name}</strong>
                                <span className={w.helpText}>Click or drop to replace</span>
                            </>
                        ) : (
                            <>
                                <Upload size={28} />
                                <strong>Drop your CSV or JSON file here</strong>
                                <span className={w.helpText}>or click to browse</span>
                            </>
                        )}
                    </div>
                    {renderDefaults()}
                </>
            );
        }

        if (method === 'invite') {
            return (
                <>
                    <h3 className={w.h3}>Invite link options</h3>
                    <p className={w.helpText}>
                        Generate a self-serve registration code. Anyone with the code can register
                        and join your organization with the configured role.
                    </p>
                    <div className={w.fieldGrid}>
                        <div className={w.field}>
                            <label>Max uses (0 = unlimited)</label>
                            <input
                                type="number"
                                min="0"
                                value={inviteForm.max_uses}
                                onChange={e => setInviteForm({ ...inviteForm, max_uses: e.target.value })}
                                placeholder="Unlimited"
                            />
                        </div>
                        <div className={w.field}>
                            <label>Expires in (days)</label>
                            <input
                                type="number"
                                min="1"
                                value={inviteForm.expires_days}
                                onChange={e => setInviteForm({ ...inviteForm, expires_days: e.target.value })}
                                placeholder="Never"
                            />
                        </div>
                    </div>
                    {renderDefaults()}
                </>
            );
        }
        return null;
    };

    // ─── Step 3: result ─────────────────────────────────────────────────
    const renderStep3 = () => {
        if (busy) return <div className={w.busyState}>Submitting…</div>;

        if (!result) {
            return (
                <div className={w.confirmReady}>
                    <h3 className={w.h3}>Ready to submit</h3>
                    {method === 'single' && (
                        <p className={w.helpText}>
                            Create <strong>{singleForm.full_name || singleForm.username || 'this user'}</strong>{' '}
                            as <strong>{ROLE_LABELS[defaults.role]}</strong>?
                        </p>
                    )}
                    {method === 'paste' && (
                        <p className={w.helpText}>
                            Import <strong>{parsedRows.length}</strong> user{parsedRows.length === 1 ? '' : 's'}
                            {parseErrors.length > 0 && <> ({parseErrors.length} skipped)</>}?
                        </p>
                    )}
                    {method === 'file' && (
                        <p className={w.helpText}>
                            Upload <strong>{file?.name}</strong> for processing?
                        </p>
                    )}
                    {method === 'invite' && (
                        <p className={w.helpText}>
                            Generate an invite code for the <strong>{ROLE_LABELS[defaults.role]}</strong> role
                            {inviteForm.max_uses ? ` with max ${inviteForm.max_uses} uses` : ' with unlimited uses'}
                            {inviteForm.expires_days ? `, expiring in ${inviteForm.expires_days} day${inviteForm.expires_days === '1' ? '' : 's'}` : ', never expiring'}?
                        </p>
                    )}
                </div>
            );
        }

        // Single user result
        if (result.kind === 'single') {
            return (
                <div className={w.successState}>
                    <Check size={32} color="var(--success)" />
                    <h3 className={w.h3}>{result.message}</h3>
                    {result.initial_password && (
                        <div className={w.credBox}>
                            <p className={w.helpText}>
                                <AlertTriangle size={13} color="var(--warning)" style={{ verticalAlign: 'middle' }} />{' '}
                                Auto-generated password (shown once):
                            </p>
                            <div className={w.codeRow}>
                                <code className={w.codeVal}>{result.initial_password}</code>
                                <button className={`${s.btn} ${s.secondary}`} onClick={() => copy(result.initial_password, 'pw')}>
                                    {copied === 'pw' ? <Check size={14} /> : <Copy size={14} />}
                                </button>
                            </div>
                        </div>
                    )}
                    {!result.initial_password && (
                        <p className={w.helpText}>
                            The user must change their password on first login.
                        </p>
                    )}
                </div>
            );
        }

        // Bulk result
        if (result.kind === 'bulk') {
            const rows = result.details || [];
            return (
                <div>
                    <div className={w.bulkSummary}>
                        {result.imported > 0 && (
                            <span className={w.bulkOk}><Check size={16} />{result.imported} imported</span>
                        )}
                        {result.failed?.length > 0 && (
                            <span className={w.bulkFail}><AlertTriangle size={16} />{result.failed.length} failed</span>
                        )}
                    </div>

                    {result.failed?.length > 0 && (
                        <div className={w.errorList}>
                            <div className={w.errorListTitle}>Failed rows</div>
                            {result.failed.map((f, i) => (
                                <div key={i} className={w.errorRow}>Row {f.row}: {f.error}</div>
                            ))}
                        </div>
                    )}

                    {rows.length > 0 && (
                        <div className={w.credBox}>
                            <div className={w.credHead}>
                                <strong>Initial passwords</strong>
                                <button
                                    type="button"
                                    className={`${s.btn} ${s.secondary}`}
                                    onClick={() => downloadCSV(rows)}
                                >
                                    <Download size={14} />Download CSV
                                </button>
                            </div>
                            <p className={w.helpText}>
                                <AlertTriangle size={13} color="var(--warning)" style={{ verticalAlign: 'middle' }} />{' '}
                                These passwords are shown once. Save them now.
                            </p>
                            <div className={w.credList}>
                                {rows.map((d, i) => (
                                    <div key={i} className={w.credRow}>
                                        <div>
                                            <strong>{d.full_name}</strong>
                                            <div className={w.credSub}>@{d.username} · {d.email}</div>
                                        </div>
                                        <code className={w.credPw}>{d.initial_password}</code>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}
                </div>
            );
        }

        // Invite result
        if (result.kind === 'invite' && generatedCode) {
            const link = `${window.location.origin}/register?invite=${generatedCode.code}`;
            return (
                <div className={w.successState}>
                    <Check size={32} color="var(--success)" />
                    <h3 className={w.h3}>Invite code generated</h3>
                    <div className={w.codeBox}>
                        <div className={w.codeRow}>
                            <span className={w.codeLabel}>Code</span>
                            <code className={w.codeVal}>{generatedCode.code}</code>
                            <button className={`${s.btn} ${s.secondary}`} onClick={() => copy(generatedCode.code, 'code')}>
                                {copied === 'code' ? <Check size={14} /> : <Copy size={14} />}
                            </button>
                        </div>
                        <div className={w.codeRow}>
                            <span className={w.codeLabel}>Link</span>
                            <code className={w.codeVal} style={{ fontSize: '0.78rem' }}>{link}</code>
                            <button className={`${s.btn} ${s.secondary}`} onClick={() => copy(link, 'link')}>
                                {copied === 'link' ? <Check size={14} /> : <Copy size={14} />}
                            </button>
                        </div>
                    </div>
                </div>
            );
        }

        return null;
    };

    // ─── Navigation guards ──────────────────────────────────────────────
    const canNext = (() => {
        if (step === 1) return !!method;
        if (step === 2) {
            if (method === 'single') {
                return singleForm.full_name && singleForm.username && singleForm.email
                    && (!singleForm.password || singleForm.password.length >= 8);
            }
            if (method === 'paste') return parsedRows.length > 0;
            if (method === 'file') return !!file;
            if (method === 'invite') return true;
        }
        return false;
    })();

    return (
        <div className={w.wrap}>
            {renderStepIndicator()}

            {error && (
                <div style={{
                    background: 'color-mix(in srgb, var(--danger) 15%, transparent)',
                    color: 'var(--danger)',
                    border: '1px solid color-mix(in srgb, var(--danger) 30%, transparent)',
                    borderRadius: 8, padding: '0.55rem 0.85rem', fontSize: 13, marginBottom: '0.75rem',
                }}>{error}</div>
            )}

            <div className={w.body}>
                {step === 1 && renderStep1()}
                {step === 2 && renderStep2()}
                {step === 3 && renderStep3()}
            </div>

            <div className={w.actions}>
                {step > 1 && !result && (
                    <button className={`${s.btn} ${s.secondary}`} onClick={() => setStep(step - 1)} disabled={busy}>
                        <ArrowLeft size={14} />Back
                    </button>
                )}
                {step === 3 && result && (
                    <button className={`${s.btn} ${s.secondary}`} onClick={reset}>
                        <Plus size={14} />Add more people
                    </button>
                )}
                <span style={{ flex: 1 }} />
                {step < 3 && (
                    <button className={s.btn} onClick={() => setStep(step + 1)} disabled={!canNext}>
                        Next<ArrowRight size={14} />
                    </button>
                )}
                {step === 3 && !result && (
                    <button className={s.btn} onClick={submit} disabled={busy}>
                        {busy ? 'Working…' : (method === 'invite' ? 'Generate code' : 'Submit')}
                    </button>
                )}
            </div>
        </div>
    );
}

function downloadCSV(rows) {
    const header = 'Username,Full Name,Email,Role,Initial Password,Auto-Generated';
    const lines = rows.map(d =>
        [d.username, d.full_name, d.email, d.role, d.initial_password, d.auto_generated ? 'Yes' : 'No']
            .map(v => `"${String(v ?? '').replace(/"/g, '""')}"`)
            .join(',')
    );
    const csv = [header, ...lines].join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `imported_credentials_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
}
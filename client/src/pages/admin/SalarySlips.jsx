import { useState, useEffect, useCallback } from 'react';
import { Play, Eye, Download, Send, RefreshCw, CheckCircle, XCircle, Clock } from 'lucide-react';
import {
    getPayPeriods, getSalarySlips, runPayroll, publishSalarySlip,
    bulkPublishSlips, downloadSalarySlipPdf, disburseSalaries,
    getDisbursements, retryDisbursement,
} from '../../api';
import s from './AdminPages.module.css';

const STATUS_COLORS = {
    draft: '#f59e0b',
    published: '#10b981',
    processed: '#10b981',
    processing: '#3b82f6',
    failed: '#ef4444',
    reversed: '#ef4444',
    queued: '#6b7280',
};

export default function SalarySlips() {
    const [periods, setPeriods] = useState([]);
    const [slips, setSlips] = useState([]);
    const [disbursements, setDisbursements] = useState([]);
    const [loading, setLoading] = useState(true);
    const [selectedPeriod, setSelectedPeriod] = useState('');
    const [generating, setGenerating] = useState(false);
    const [publishing, setPublishing] = useState(false);
    const [disbursing, setDisbursing] = useState(false);
    const [message, setMessage] = useState('');
    const [error, setError] = useState('');

    const load = useCallback(async () => {
        setLoading(true);
        try {
            const [periodsRes] = await Promise.all([getPayPeriods()]);
            setPeriods(periodsRes.data || []);
        } catch { setError('Failed to load data'); }
        setLoading(false);
    }, []);

    useEffect(() => { load(); }, [load]);

    const loadSlips = useCallback(async (periodId) => {
        if (!periodId) { setSlips([]); return; }
        try {
            const res = await getSalarySlips({ pay_period_id: periodId });
            setSlips(res.data || []);
            const disbRes = await getDisbursements({ pay_period_id: periodId });
            setDisbursements(disbRes.data || []);
        } catch { setError('Failed to load slips'); }
    }, []);

    useEffect(() => { if (selectedPeriod) loadSlips(selectedPeriod); }, [selectedPeriod, loadSlips]);

    const handleGenerate = async () => {
        if (!selectedPeriod) return;
        setGenerating(true);
        setError('');
        setMessage('');
        try {
            const res = await runPayroll({ pay_period_id: parseInt(selectedPeriod) });
            setMessage(res.data.message);
            loadSlips(selectedPeriod);
        } catch (err) {
            setError(err.response?.data?.error || 'Payroll run failed');
        }
        setGenerating(false);
    };

    const handlePublish = async (id) => {
        try {
            await publishSalarySlip(id);
            loadSlips(selectedPeriod);
        } catch (err) {
            alert(err.response?.data?.error || 'Failed to publish');
        }
    };

    const handleBulkPublish = async () => {
        if (!window.confirm('Publish all draft slips for this period?')) return;
        setPublishing(true);
        try {
            const res = await bulkPublishSlips({ pay_period_id: parseInt(selectedPeriod) });
            setMessage(res.data.message);
            loadSlips(selectedPeriod);
        } catch (err) {
            setError(err.response?.data?.error || 'Bulk publish failed');
        }
        setPublishing(false);
    };

    const handleDownload = async (id, name, month) => {
        try {
            const res = await downloadSalarySlipPdf(id);
            const url = window.URL.createObjectURL(new Blob([res.data]));
            const a = document.createElement('a');
            a.href = url;
            a.download = `salary_slip_${name.replace(/\s+/g, '_')}_${month}.pdf`;
            a.click();
            window.URL.revokeObjectURL(url);
        } catch {
            alert('Failed to download PDF');
        }
    };

    const handleDisburse = async () => {
        if (!window.confirm('Initiate bank transfer for all published slips in this period?')) return;
        setDisbursing(true);
        setError('');
        try {
            const res = await disburseSalaries({ pay_period_id: parseInt(selectedPeriod) });
            setMessage(`${res.data.message} (${res.data.disbursed} sent, ${res.data.failed} failed)`);
            loadSlips(selectedPeriod);
        } catch (err) {
            setError(err.response?.data?.error || 'Disbursement failed');
        }
        setDisbursing(false);
    };

    const handleRetry = async (id) => {
        try {
            await retryDisbursement(id);
            loadSlips(selectedPeriod);
        } catch (err) {
            alert(err.response?.data?.error || 'Retry failed');
        }
    };

    const draftCount = slips.filter(s => s.status === 'draft').length;
    const publishedCount = slips.filter(s => s.status === 'published').length;

    if (loading) return <div className={s.loading}>Loading...</div>;

    return (
        <div>
            <h2 className={s.pageTitle}>Salary Slips</h2>

            {error && <div className={s.error}>{error}</div>}
            {message && <div className={s.success}>{message}</div>}

            {/* Period selector */}
            <div className={s.formCard}>
                <div className={s.formRow}>
                    <label>Pay Period:</label>
                    <select
                        value={selectedPeriod}
                        onChange={e => { setSelectedPeriod(e.target.value); setMessage(''); setError(''); }}
                        className={s.input}
                    >
                        <option value="">Select a locked pay period</option>
                        {periods.filter(p => p.locked_by).map(p => (
                            <option key={p.id} value={p.id}>{p.label} ({p.start_date} to {p.end_date})</option>
                        ))}
                    </select>

                    <button onClick={handleGenerate} disabled={!selectedPeriod || generating} className={s.btnPrimary}>
                        <Play size={14} /> {generating ? 'Generating...' : 'Generate Slips'}
                    </button>
                </div>

                {selectedPeriod && slips.length > 0 && (
                    <div className={s.formRow} style={{ marginTop: 12 }}>
                        {draftCount > 0 && (
                            <button onClick={handleBulkPublish} disabled={publishing} className={s.btnSecondary}>
                                <CheckCircle size={14} /> Publish All Drafts ({draftCount})
                            </button>
                        )}
                        {publishedCount > 0 && (
                            <button onClick={handleDisburse} disabled={disbursing} className={s.btnPrimary}>
                                <Send size={14} /> {disbursing ? 'Disbursing...' : `Disburse All (${publishedCount})`}
                            </button>
                        )}
                    </div>
                )}
            </div>

            {/* Slips table */}
            {selectedPeriod && (
                <div className={s.tableWrap}>
                    <table className={s.table}>
                        <thead>
                            <tr>
                                <th>Employee</th>
                                <th>Department</th>
                                <th>Gross</th>
                                <th>Deductions</th>
                                <th>Net Pay</th>
                                <th>Status</th>
                                <th>Payment</th>
                                <th>Actions</th>
                            </tr>
                        </thead>
                        <tbody>
                            {slips.map(slip => {
                                const disb = disbursements.find(d => d.salary_slip_id === slip.id);
                                return (
                                    <tr key={slip.id}>
                                        <td><strong>{slip.full_name}</strong><br/><small>{slip.email}</small></td>
                                        <td>{slip.department_name || '-'}</td>
                                        <td>₹{Number(slip.gross_earnings).toLocaleString('en-IN')}</td>
                                        <td>₹{Number(slip.total_deductions).toLocaleString('en-IN')}</td>
                                        <td><strong>₹{Number(slip.net_pay).toLocaleString('en-IN')}</strong></td>
                                        <td>
                                            <span style={{ color: STATUS_COLORS[slip.status], fontWeight: 600 }}>
                                                {slip.status}
                                            </span>
                                        </td>
                                        <td>
                                            {disb ? (
                                                <span style={{ color: STATUS_COLORS[disb.status] }}>
                                                    {disb.status === 'processed' && <><CheckCircle size={12} /> Paid</>}
                                                    {disb.status === 'processing' && <><Clock size={12} /> Processing</>}
                                                    {disb.status === 'failed' && <><XCircle size={12} /> Failed</>}
                                                    {disb.utr && <><br/><small>UTR: {disb.utr}</small></>}
                                                </span>
                                            ) : (
                                                <span style={{ color: '#9ca3af' }}>—</span>
                                            )}
                                        </td>
                                        <td>
                                            {slip.status === 'draft' && (
                                                <button className={s.iconBtn} onClick={() => handlePublish(slip.id)} title="Publish">
                                                    <CheckCircle size={14} />
                                                </button>
                                            )}
                                            <button className={s.iconBtn} onClick={() => handleDownload(slip.id, slip.full_name, slip.slip_month)} title="Download PDF">
                                                <Download size={14} />
                                            </button>
                                            {disb?.status === 'failed' && (
                                                <button className={s.iconBtn} onClick={() => handleRetry(disb.id)} title="Retry">
                                                    <RefreshCw size={14} />
                                                </button>
                                            )}
                                        </td>
                                    </tr>
                                );
                            })}
                            {slips.length === 0 && <tr><td colSpan={8}>No salary slips for this period. Click "Generate Slips" to create them.</td></tr>}
                        </tbody>
                    </table>
                </div>
            )}
        </div>
    );
}

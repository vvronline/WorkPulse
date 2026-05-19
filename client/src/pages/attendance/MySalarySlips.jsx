import { useState, useEffect, useCallback } from 'react';
import { Download, CheckCircle, Clock, XCircle, CreditCard } from 'lucide-react';
import { getMySalarySlips, downloadMySalarySlipPdf, getMyBankDetails } from '../../api';

const STATUS_ICONS = {
    processed: <CheckCircle size={14} style={{ color: '#10b981' }} />,
    processing: <Clock size={14} style={{ color: '#3b82f6' }} />,
    failed: <XCircle size={14} style={{ color: '#ef4444' }} />,
    reversed: <XCircle size={14} style={{ color: '#ef4444' }} />,
};

export default function MySalarySlips() {
    const [slips, setSlips] = useState([]);
    const [bankDetails, setBankDetails] = useState(null);
    const [loading, setLoading] = useState(true);

    const load = useCallback(async () => {
        setLoading(true);
        try {
            const [slipsRes, bankRes] = await Promise.all([getMySalarySlips(), getMyBankDetails()]);
            setSlips(slipsRes.data || []);
            setBankDetails(bankRes.data);
        } catch {}
        setLoading(false);
    }, []);

    useEffect(() => { load(); }, [load]);

    const handleDownload = async (id, month) => {
        try {
            const res = await downloadMySalarySlipPdf(id);
            const url = window.URL.createObjectURL(new Blob([res.data]));
            const a = document.createElement('a');
            a.href = url;
            a.download = `salary_slip_${month}.pdf`;
            a.click();
            window.URL.revokeObjectURL(url);
        } catch {
            alert('Failed to download PDF');
        }
    };

    if (loading) return <div style={{ padding: 24, textAlign: 'center' }}>Loading salary slips...</div>;

    return (
        <div style={{ padding: '16px 0' }}>
            <h3 style={{ margin: '0 0 16px', display: 'flex', alignItems: 'center', gap: 8 }}>
                <CreditCard size={18} /> My Salary Slips
            </h3>

            {bankDetails && (
                <div style={{ background: '#f0f9ff', border: '1px solid #bae6fd', borderRadius: 8, padding: '10px 16px', marginBottom: 16, fontSize: 13 }}>
                    <strong>Bank Account:</strong> {bankDetails.bank_name || 'Bank'} • {bankDetails.account_number} • IFSC: {bankDetails.ifsc_code}
                    {bankDetails.is_verified && <span style={{ color: '#10b981', marginLeft: 8 }}>✓ Verified</span>}
                </div>
            )}

            {slips.length === 0 ? (
                <div style={{ textAlign: 'center', padding: 40, color: '#6b7280' }}>
                    No salary slips available yet.
                </div>
            ) : (
                <div style={{ overflowX: 'auto' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                        <thead>
                            <tr style={{ borderBottom: '2px solid #e5e7eb', textAlign: 'left' }}>
                                <th style={{ padding: '8px 12px' }}>Month</th>
                                <th style={{ padding: '8px 12px' }}>Gross</th>
                                <th style={{ padding: '8px 12px' }}>Deductions</th>
                                <th style={{ padding: '8px 12px' }}>Net Pay</th>
                                <th style={{ padding: '8px 12px' }}>Payment</th>
                                <th style={{ padding: '8px 12px' }}>Actions</th>
                            </tr>
                        </thead>
                        <tbody>
                            {slips.map(slip => (
                                <tr key={slip.id} style={{ borderBottom: '1px solid #f3f4f6' }}>
                                    <td style={{ padding: '10px 12px', fontWeight: 600 }}>{slip.slip_month}</td>
                                    <td style={{ padding: '10px 12px' }}>₹{Number(slip.gross_earnings).toLocaleString('en-IN')}</td>
                                    <td style={{ padding: '10px 12px', color: '#ef4444' }}>₹{Number(slip.total_deductions).toLocaleString('en-IN')}</td>
                                    <td style={{ padding: '10px 12px', fontWeight: 700 }}>₹{Number(slip.net_pay).toLocaleString('en-IN')}</td>
                                    <td style={{ padding: '10px 12px' }}>
                                        {slip.disbursement_status ? (
                                            <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                                                {STATUS_ICONS[slip.disbursement_status] || <Clock size={14} />}
                                                {slip.disbursement_status === 'processed' ? 'Paid' : slip.disbursement_status}
                                                {slip.utr && <small style={{ color: '#6b7280', marginLeft: 4 }}>UTR: {slip.utr}</small>}
                                            </span>
                                        ) : (
                                            <span style={{ color: '#9ca3af' }}>Pending</span>
                                        )}
                                    </td>
                                    <td style={{ padding: '10px 12px' }}>
                                        <button
                                            onClick={() => handleDownload(slip.id, slip.slip_month)}
                                            style={{ background: 'none', border: '1px solid #d1d5db', borderRadius: 4, padding: '4px 8px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4, fontSize: 12 }}
                                            title="Download PDF"
                                        >
                                            <Download size={13} /> PDF
                                        </button>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
        </div>
    );
}

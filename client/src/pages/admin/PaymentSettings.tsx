import { useState, useEffect, useCallback } from "react";
import { Save, TestTube2, CheckCircle, AlertCircle } from "lucide-react";
import { getPaymentConfig, savePaymentConfig, testPaymentConfig } from "../../api";
import s from "./AdminPages.module.css";

export default function PaymentSettings() {
    const [config, setConfig] = useState<any>(null);
    const [form, setForm] = useState({
        api_key_id: "",
        api_key_secret: "",
        account_number: "",
        webhook_secret: "",
        default_transfer_mode: "NEFT",
        is_active: false,
    });
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [testing, setTesting] = useState(false);
    const [message, setMessage] = useState("");
    const [error, setError] = useState("");

    const load = useCallback(async () => {
        setLoading(true);
        try {
            const res = await getPaymentConfig();
            if (res.data) {
                const data = res.data as any;
                setConfig(data);
                setForm({
                    api_key_id: "",
                    api_key_secret: "",
                    account_number: data.account_number || "",
                    webhook_secret: "",
                    default_transfer_mode: data.default_transfer_mode || "NEFT",
                    is_active: data.is_active || false,
                });
            }
        } catch { setError("Failed to load payment config"); }
        setLoading(false);
    }, []);

    useEffect(() => { load(); }, [load]);

    const handleSave = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!form.api_key_id || !form.api_key_secret || !form.account_number) {
            setError("All fields are required");
            return;
        }
        setSaving(true);
        setError("");
        setMessage("");
        try {
            await savePaymentConfig(form);
            setMessage("Payment configuration saved successfully");
            load();
        } catch (err: any) {
            setError(err.response?.data?.error || "Failed to save");
        }
        setSaving(false);
    };

    const handleTest = async () => {
        setTesting(true);
        setError("");
        setMessage("");
        try {
            const res = await testPaymentConfig();
            setMessage(`Connection successful! Balance: ₹${((res.data as any).balance / 100).toLocaleString("en-IN")}`);
        } catch (err: any) {
            setError(err.response?.data?.error || "Connection test failed");
        }
        setTesting(false);
    };

    if (loading) return <div className={s.loading}>Loading...</div>;

    return (
        <div>
            <h2 className={s.pageTitle}>Payment Settings (Razorpay Payouts)</h2>

            {error && <div className={s.error}><AlertCircle size={14} /> {error}</div>}
            {message && <div className={s.success}><CheckCircle size={14} /> {message}</div>}

            {config && (
                <div className={s.infoBox}>
                    <p><strong>Current Status:</strong> {config.is_active ? "✓ Active" : "✗ Inactive"}</p>
                    <p><strong>Key ID:</strong> {config.api_key_id || "Not set"}</p>
                    <p><strong>Account:</strong> {config.account_number || "Not set"}</p>
                    <p><strong>Transfer Mode:</strong> {config.default_transfer_mode}</p>
                </div>
            )}

            <form onSubmit={handleSave} className={s.formCard}>
                <h3>{config ? "Update Configuration" : "Setup Configuration"}</h3>
                <p className={s.helpText}>
                    Enter your Razorpay X (Payouts) API credentials. These are different from your regular Razorpay payment gateway keys.
                </p>

                <div className={s.formGroup}>
                    <label>API Key ID</label>
                    <input
                        type="text"
                        value={form.api_key_id}
                        onChange={e => setForm(f => ({ ...f, api_key_id: e.target.value }))}
                        placeholder="rzp_live_..."
                        className={s.input}
                        required
                    />
                </div>

                <div className={s.formGroup}>
                    <label>API Key Secret</label>
                    <input
                        type="password"
                        value={form.api_key_secret}
                        onChange={e => setForm(f => ({ ...f, api_key_secret: e.target.value }))}
                        placeholder="Enter secret key"
                        className={s.input}
                        required
                    />
                </div>

                <div className={s.formGroup}>
                    <label>Account Number (Razorpay X)</label>
                    <input
                        type="text"
                        value={form.account_number}
                        onChange={e => setForm(f => ({ ...f, account_number: e.target.value }))}
                        placeholder="2323230012345679"
                        className={s.input}
                        required
                    />
                </div>

                <div className={s.formGroup}>
                    <label>Webhook Secret</label>
                    <input
                        type="password"
                        value={form.webhook_secret}
                        onChange={e => setForm(f => ({ ...f, webhook_secret: e.target.value }))}
                        placeholder={config?.webhook_secret ? "(configured — enter new to replace)" : "From Razorpay Dashboard → Webhooks"}
                        className={s.input}
                    />
                    <small className={s.helpText} style={{ margin: 0 }}>
                        Configure your webhook URL as: https://your-domain.com/api/webhooks/razorpay
                    </small>
                </div>

                <div className={s.formGroup}>
                    <label>Default Transfer Mode</label>
                    <select
                        value={form.default_transfer_mode}
                        onChange={e => setForm(f => ({ ...f, default_transfer_mode: e.target.value }))}
                        className={s.input}
                    >
                        <option value="NEFT">NEFT (1-2 hours)</option>
                        <option value="IMPS">IMPS (Instant, higher fee)</option>
                        <option value="UPI">UPI (Instant)</option>
                    </select>
                </div>

                <div className={s.formGroup}>
                    <label className={s.checkLabel}>
                        <input
                            type="checkbox"
                            checked={form.is_active}
                            onChange={e => setForm(f => ({ ...f, is_active: e.target.checked }))}
                        />
                        Enable disbursement (allow salary transfers)
                    </label>
                </div>

                <div className={s.formActions}>
                    <button type="submit" disabled={saving} className={s.btnPrimary}>
                        <Save size={14} /> {saving ? "Saving..." : "Save Configuration"}
                    </button>
                    {config && (
                        <button type="button" onClick={handleTest} disabled={testing} className={s.btnSecondary}>
                            <TestTube2 size={14} /> {testing ? "Testing..." : "Test Connection"}
                        </button>
                    )}
                </div>
            </form>
        </div>
    );
}
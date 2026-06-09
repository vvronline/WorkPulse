import React, { useState, useEffect, useCallback } from "react";
import {
    X, Shield, Loader2, CheckCircle2, AlertTriangle, KeyRound, Lock,
} from "lucide-react";
import {
    createTenantAccessRequest, listTenantAccessRequests, cancelAccessRequest,
    impersonateTenant, getImpersonationPolicy,
} from "../../api";
import s from "./Tenants.module.css";

interface AccessRequest {
    id: number | string;
    status: string;
    reason?: string;
    scope?: string;
    duration_minutes?: number;
    denied_reason?: string;
    approved_by_name?: string;
    code_expires_at?: string;
    [key: string]: unknown;
}

interface Policy {
    breakGlassAllowed?: boolean;
    maxSessionMinutes?: number;
    [key: string]: unknown;
}

interface RequestAccessModalProps {
    tenant: { id: number | string; org_name?: string; [key: string]: unknown };
    onClose: () => void;
    onError?: (msg: string) => void;
}

/**
 * Multi-step Request Access modal — replaces the legacy "Enter Tenant" button.
 *
 *   Step 1 — Reason: collect reason + scope + duration, POST a request.
 *   Step 2 — Waiting: poll for approval status; show pending.
 *   Step 3 — Code entry: show the request was approved; collect the 6-digit
 *            code + the inspector's password; call /impersonate.
 *   Step 4 — Break-glass (only if policy allows): bypass consent with a
 *            second password challenge, audited heavily.
 *
 * On success, the parent component navigates the user into the impersonated
 * tenant (window.location.href = '/').
 */
export default function RequestAccessModal({ tenant, onClose, onError }: RequestAccessModalProps) {
    const [policy, setPolicy] = useState<Policy | null>(null);
    const [step, setStep] = useState<string>("reason");   // reason | waiting | code | done | break_glass
    const [request, setRequest] = useState<AccessRequest | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");

    // Step 1 inputs
    const [reason, setReason] = useState("");
    const [scope, setScope] = useState("write");
    const [durationMin, setDurationMin] = useState<number | string>(30);

    // Step 3 inputs
    const [approvalCode, setApprovalCode] = useState("");
    const [password, setPassword] = useState("");

    useEffect(() => {
        getImpersonationPolicy().then(r => setPolicy(r.data as Policy)).catch(() => { });
    }, []);

    // ── On mount: look for an existing live request so we can re-enter the
    // correct step (e.g. user closed the modal while it was pending).
    useEffect(() => {
        let cancelled = false;
        listTenantAccessRequests(tenant.id as any).then(r => {
            if (cancelled) return;
            const live = ((r.data as any)?.requests || []).find((req: AccessRequest) =>
                ["pending", "approved"].includes(req.status)
            );
            if (live) {
                setRequest(live);
                setStep(live.status === "approved" ? "code" : "waiting");
            }
        }).catch(() => { });
        return () => { cancelled = true; };
    }, [tenant.id]);

    // ── Poll for status while waiting for approval ────────────────────────
    useEffect(() => {
        if (step !== "waiting" || !request) return;
        let cancelled = false;
        const tick = async () => {
            try {
                const r = await listTenantAccessRequests(tenant.id as any);
                if (cancelled) return;
                const fresh = ((r.data as any)?.requests || []).find((x: AccessRequest) => x.id === request.id);
                if (!fresh) return;
                setRequest(fresh);
                if (fresh.status === "approved") setStep("code");
                if (fresh.status === "denied") { setError(`Request denied: ${fresh.denied_reason || "—"}`); setStep("reason"); setRequest(null); }
                if (fresh.status === "expired") { setError("The approval code expired. Please request again."); setStep("reason"); setRequest(null); }
                if (fresh.status === "cancelled") { setStep("reason"); setRequest(null); }
            } catch { /* keep polling */ }
        };
        const id = setInterval(tick, 4000);
        return () => { cancelled = true; clearInterval(id); };
    }, [step, request, tenant.id]);

    const handleCreateRequest = useCallback(async () => {
        if (reason.trim().length < 10) {
            setError("Please describe why access is needed (at least 10 characters).");
            return;
        }
        setBusy(true); setError("");
        try {
            const r = await createTenantAccessRequest(tenant.id as any, {
                reason: reason.trim(), scope, duration_minutes: Number(durationMin),
            } as any);
            setRequest((r.data as any)?.request || null);
            setStep("waiting");
        } catch (e: any) {
            setError(e.response?.data?.error || "Failed to create request");
        } finally { setBusy(false); }
    }, [reason, scope, durationMin, tenant.id]);

    const handleCancel = useCallback(async () => {
        if (!request) { onClose(); return; }
        try {
            await cancelAccessRequest(request.id as any);
        } catch { /* ignore */ }
        onClose();
    }, [request, onClose]);

    const handleEnter = useCallback(async (useBreakGlass = false) => {
        if (!password) { setError("Enter your password to continue."); return; }
        if (!useBreakGlass && !/^\d{6}$/.test(approvalCode)) {
            setError("Enter the 6-digit approval code."); return;
        }
        setBusy(true); setError("");
        try {
            await impersonateTenant(tenant.id as any, {
                approval_code: useBreakGlass ? undefined : approvalCode,
                password,
                break_glass: useBreakGlass || undefined,
            } as any);
            setStep("done");
            // Hand off to the parent — they typically window.location.href = '/'
            setTimeout(() => { window.location.href = "/"; }, 400);
        } catch (e: any) {
            setError(e.response?.data?.error || "Failed to start session");
        } finally { setBusy(false); }
    }, [approvalCode, password, tenant.id]);

    // Build modal content per step
    return (
        <div className={s.modalScrim} role="dialog" aria-modal="true" aria-label="Request access">
            <div className={s.modalCard}>
                <div className={s.modalHeader}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <Shield size={16} className={s.iconAccent} />
                        <h2 style={{ margin: 0, fontSize: 16 }}>Request access — {tenant.org_name}</h2>
                    </div>
                    <button className={s.errorClose} onClick={onClose} aria-label="Close"><X size={16} /></button>
                </div>

                <StepIndicator step={step} hasGlass={policy?.breakGlassAllowed} />

                {error && (
                    <div className={s.errorBanner} style={{ margin: "12px 0" }}>
                        <span className={s.errorText}>{error}</span>
                        <button onClick={() => setError("")} className={s.errorClose}><X size={14} /></button>
                    </div>
                )}

                {step === "reason" && (
                    <div className={s.modalBody}>
                        <p style={{ fontSize: 13, color: "var(--text-secondary)", marginTop: 0 }}>
                            The tenant's super admin must approve your request before you can enter the workspace.
                            They'll receive a notification with the reason below.
                        </p>

                        <label className={s.fieldLabel}>Reason for access *</label>
                        <textarea
                            value={reason}
                            onChange={e => setReason(e.target.value)}
                            rows={4}
                            placeholder="e.g. Customer ticket #4231 — investigating missing salary slip records."
                            maxLength={500}
                            className={s.inputFull}
                            style={{ minHeight: 80, resize: "vertical" }}
                        />
                        <div style={{ display: "flex", gap: 12, marginTop: 12, flexWrap: "wrap" }}>
                            <div style={{ flex: 1, minWidth: 140 }}>
                                <label className={s.fieldLabel}>Scope</label>
                                <select value={scope} onChange={e => setScope(e.target.value)} className={s.statusSelect} style={{ width: "100%" }}>
                                    <option value="read">Read-only (recommended)</option>
                                    <option value="write">Full write access</option>
                                </select>
                            </div>
                            <div style={{ flex: 1, minWidth: 140 }}>
                                <label className={s.fieldLabel}>Duration (minutes)</label>
                                <input
                                    type="number" min="5" max={policy?.maxSessionMinutes || 60}
                                    value={durationMin}
                                    onChange={e => setDurationMin(e.target.value)}
                                    className={s.inputSmall}
                                    style={{ width: "100%" }}
                                />
                                <small style={{ color: "var(--text-muted)", fontSize: 11 }}>
                                    Max {policy?.maxSessionMinutes || 60} min
                                </small>
                            </div>
                        </div>

                        <div className={s.modalActions}>
                            <button className={s.btnSmall} onClick={onClose} disabled={busy}>Cancel</button>
                            <button className={s.btnPrimary} onClick={handleCreateRequest} disabled={busy}>
                                {busy ? <Loader2 size={14} className={s.spinner} /> : <Shield size={14} />}
                                Request access
                            </button>
                        </div>

                        {policy?.breakGlassAllowed && (
                            <div className={s.breakGlassNotice}>
                                <AlertTriangle size={14} />
                                <span>
                                    Break-glass emergency access is enabled by platform policy.{" "}
                                    <button className={s.linkBtn} onClick={() => setStep("break_glass")}>
                                        Use it instead
                                    </button>
                                </span>
                            </div>
                        )}
                    </div>
                )}

                {step === "waiting" && request && (
                    <div className={s.modalBody} style={{ textAlign: "center", padding: "20px 4px" }}>
                        <Loader2 size={28} className={s.spinner} style={{ color: "var(--accent)" }} />
                        <h3 style={{ marginTop: 12 }}>Waiting for approval</h3>
                        <p style={{ color: "var(--text-secondary)", fontSize: 13 }}>
                            Your request was sent to the tenant's super admin. They'll generate a one-time
                            6-digit code and share it with you over your support channel.
                        </p>
                        <div className={s.detailGrid} style={{ marginTop: 12 }}>
                            <div><strong>Reason:</strong> {request.reason}</div>
                            <div><strong>Scope:</strong> {request.scope}</div>
                            <div><strong>Duration:</strong> {request.duration_minutes} minutes</div>
                        </div>
                        <div className={s.modalActions}>
                            <button className={s.btnSmall} onClick={handleCancel}>Cancel request</button>
                        </div>
                    </div>
                )}

                {step === "code" && request && (
                    <div className={s.modalBody}>
                        <div className={s.successBanner}>
                            <CheckCircle2 size={16} />
                            <span>Approved by {request.approved_by_name || "the tenant"}.</span>
                        </div>

                        <p style={{ fontSize: 13, color: "var(--text-secondary)" }}>
                            Enter the 6-digit approval code the tenant shared with you, plus your platform password.
                            Both will be verified before the session starts.
                        </p>

                        <label className={s.fieldLabel}>
                            <KeyRound size={12} /> 6-digit approval code
                        </label>
                        <input
                            type="text"
                            inputMode="numeric"
                            autoComplete="one-time-code"
                            value={approvalCode}
                            onChange={e => setApprovalCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                            placeholder="123456"
                            maxLength={6}
                            className={s.otpInput}
                        />
                        {request.code_expires_at && (
                            <small style={{ color: "var(--text-muted)", fontSize: 11 }}>
                                Code expires {new Date(request.code_expires_at).toLocaleTimeString()}
                            </small>
                        )}

                        <label className={s.fieldLabel} style={{ marginTop: 12 }}>
                            <Lock size={12} /> Your platform password (re-auth)
                        </label>
                        <input
                            type="password"
                            autoComplete="current-password"
                            value={password}
                            onChange={e => setPassword(e.target.value)}
                            className={s.inputFull}
                            placeholder="Enter your password"
                        />

                        <div className={s.modalActions}>
                            <button className={s.btnSmall} onClick={handleCancel} disabled={busy}>Cancel</button>
                            <button className={s.btnPrimary} onClick={() => handleEnter(false)} disabled={busy}>
                                {busy ? <Loader2 size={14} className={s.spinner} /> : <Shield size={14} />}
                                Enter tenant
                            </button>
                        </div>
                    </div>
                )}

                {step === "break_glass" && (
                    <div className={s.modalBody}>
                        <div className={s.dangerBanner}>
                            <AlertTriangle size={16} />
                            <div>
                                <strong>Emergency break-glass access</strong>
                                <p style={{ margin: "4px 0 0", fontSize: 12 }}>
                                    Bypassing tenant consent is heavily audited. All tenant super admins will
                                    be notified immediately. Only use this for genuine incidents.
                                </p>
                            </div>
                        </div>

                        <label className={s.fieldLabel} style={{ marginTop: 12 }}>
                            <Lock size={12} /> Your platform password (re-auth required)
                        </label>
                        <input
                            type="password"
                            autoComplete="current-password"
                            value={password}
                            onChange={e => setPassword(e.target.value)}
                            className={s.inputFull}
                        />

                        <div className={s.modalActions}>
                            <button className={s.btnSmall} onClick={() => setStep("reason")} disabled={busy}>Back</button>
                            <button
                                className={s.btnDanger}
                                onClick={() => handleEnter(true)}
                                disabled={busy || !password}
                            >
                                {busy ? <Loader2 size={14} className={s.spinner} /> : <AlertTriangle size={14} />}
                                Break the glass
                            </button>
                        </div>
                    </div>
                )}

                {step === "done" && (
                    <div className={s.modalBody} style={{ textAlign: "center", padding: "20px 4px" }}>
                        <CheckCircle2 size={28} style={{ color: "var(--success)" }} />
                        <h3>Session started</h3>
                        <p style={{ color: "var(--text-secondary)", fontSize: 13 }}>
                            Loading the tenant workspace…
                        </p>
                    </div>
                )}
            </div>
        </div>
    );
}

function StepIndicator({ step, hasGlass }: { step: string; hasGlass?: boolean }) {
    const steps = ["reason", "waiting", "code", "done"];
    const idx = steps.indexOf(step === "break_glass" ? "code" : step);
    return (
        <div className={s.stepIndicator}>
            {["Reason", "Wait", "Code", "Enter"].map((label, i) => (
                <div key={label} className={`${s.step} ${i <= idx ? s.stepActive : ""}`}>
                    <span className={s.stepDot}>{i + 1}</span>
                    <span className={s.stepLabel}>{label}</span>
                </div>
            ))}
        </div>
    );
}
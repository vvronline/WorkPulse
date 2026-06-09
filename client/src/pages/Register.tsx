import React, { useState, useEffect } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useAuth } from "../AuthContext";
import { useBranding } from "../BrandingContext";
import { register as registerApi, getRegistrationMode } from "../api";
import { Lock, Briefcase } from "lucide-react";
import PasswordInput from "../components/common/PasswordInput";
import { useAutoDismiss } from "../hooks/useAutoDismiss";
import s from "./Auth.module.css";

export default function Register() {
    const { saveAuth } = useAuth() as any;
    const { branding } = useBranding() as any;
    const [searchParams] = useSearchParams();
    const tenantSlug = searchParams.get("tenant") || "";
    const inviteFromUrl = searchParams.get("invite") || "";
    const [form, setForm] = useState({ username: "", password: "", full_name: "", email: "", invite_code: inviteFromUrl });
    const [error, setError] = useAutoDismiss("") as [string, (v: string) => void];
    const [loading, setLoading] = useState(false);
    const [regMode, setRegMode] = useState<string | null>(null); // null = loading, safest default

    useEffect(() => {
        getRegistrationMode()
            .then(r => setRegMode((r.data as any).mode))
            .catch(() => setRegMode("closed")); // default to closed on error
    }, []);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setError("");
        setLoading(true);
        try {
            const { data } = await registerApi({ ...form, tenant_slug: tenantSlug || undefined } as any);
            saveAuth((data as any).user);
        } catch (err: any) {
            setError(err.response?.data?.error || "Registration failed");
        } finally {
            setLoading(false);
        }
    };

    if (regMode === null) {
        return (
            <div className={s["auth-container"]}>
                <div className={s["auth-card"]}>
                    <div className="loading-spinner"><div className="spinner"></div></div>
                </div>
            </div>
        );
    }

    if (regMode === "closed") {
        return (
            <div className={s["auth-container"]}>
                <div className={s["auth-card"]}>
                    <div className={s["auth-icon"]}><Lock size={28} strokeWidth={1.5} /></div>
                    <h2>Registration Closed</h2>
                    <p>New registrations are currently not being accepted. Contact your administrator for access.</p>
                    <div className={s["auth-switch"]}>
                        Already have an account? <Link to="/login">Sign in</Link>
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div className={s["auth-container"]}>
            <div className={s["auth-card"]}>
                <div className={s["auth-icon"]}><Briefcase size={28} strokeWidth={1.5} /></div>
                <h2>Create Account</h2>
                <p>Register to get started with {branding?.org_name || "WorkPulse"}</p>
                {error && <div className="error-msg">{error}</div>}
                <form onSubmit={handleSubmit}>
                    <div className="form-group">
                        <label htmlFor="reg-fullname">Full Name</label>
                        <input
                            id="reg-fullname"
                            type="text"
                            value={form.full_name}
                            onChange={e => setForm({ ...form, full_name: e.target.value })}
                            placeholder="Enter your full name"
                            required
                        />
                    </div>
                    <div className="form-group">
                        <label htmlFor="reg-email">Email</label>
                        <input
                            id="reg-email"
                            type="email"
                            value={form.email}
                            onChange={e => setForm({ ...form, email: e.target.value })}
                            placeholder="Enter your email"
                            required
                        />
                    </div>
                    <div className="form-group">
                        <label htmlFor="reg-username">Username</label>
                        <input
                            id="reg-username"
                            type="text"
                            value={form.username}
                            onChange={e => setForm({ ...form, username: e.target.value.replace(/[^a-zA-Z0-9._-]/g, "") })}
                            placeholder="Letters, numbers, dots, hyphens, underscores"
                            required
                            minLength={3}
                            maxLength={50}
                            pattern="[a-zA-Z0-9._\-]+"
                            title="Only letters, numbers, dots, hyphens and underscores"
                        />
                    </div>
                    <div className="form-group">
                        <label htmlFor="reg-password">Password</label>
                        <PasswordInput
                            id="reg-password"
                            value={form.password}
                            onChange={e => setForm({ ...form, password: e.target.value })}
                            placeholder="Min 8 chars, upper+lower+digit+special"
                            required
                            minLength={8}
                        />
                    </div>
                    {regMode === "invite_only" && (
                        <div className="form-group">
                            <label htmlFor="reg-invite">Invite Code</label>
                            <input
                                id="reg-invite"
                                type="text"
                                value={form.invite_code}
                                onChange={e => setForm({ ...form, invite_code: e.target.value.toUpperCase() })}
                                placeholder="Enter your invite code"
                                required
                            />
                        </div>
                    )}
                    <button type="submit" className="btn btn-primary btn-fullwidth" disabled={loading}>
                        {loading ? "Creating..." : "Create Account"}
                    </button>
                </form>
                <div className={s["auth-switch"]}>
                    Already registered? <Link to="/login">Sign in</Link>
                </div>
            </div>
        </div>
    );
}
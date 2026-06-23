import React, { useState, useEffect } from "react";
import { Link, useLocation } from "react-router-dom";
import { useAuth } from "../AuthContext";
import { useBranding } from "../BrandingContext";
import { login as loginApi, serverURL } from "../api";
import { ShieldCheck, ArrowRight, Fingerprint } from "lucide-react";
import PasswordInput from "../components/common/PasswordInput";
import { useAutoDismiss } from "../hooks/useAutoDismiss";
import { isPasskeySupported, isConditionalMediationAvailable, loginWithPasskey } from "../auth/webauthn";
import {
    isDesktopBiometricBridge,
    desktopBiometricStatus,
    desktopBiometricLogin,
} from "../auth/desktopBiometric";
import s from "./Auth.module.css";

export default function Login() {
    const { saveAuth } = useAuth() as any;
    const { branding } = useBranding() as any;
    const location = useLocation();
    const [form, setForm] = useState({ username: "", password: "" });
    const [error, setError] = useAutoDismiss("") as [string, (v: string) => void];
    const [loading, setLoading] = useState(false);
    const [passkeyLoading, setPasskeyLoading] = useState(false);
    // Desktop (Electron) biometric: only offered when running in the desktop
    // app AND a credential is already enrolled on this device. On web this stays
    // false and we fall back to WebAuthn passkeys below.
    const isDesktop = isDesktopBiometricBridge();
    const [desktopBioEnrolled, setDesktopBioEnrolled] = useState(false);
    const [desktopBioLoading, setDesktopBioLoading] = useState(false);
    // Hide the passkey button in the desktop app (Electron uses Hello/Touch ID
    // via the bridge instead of WebAuthn).
    const passkeySupported = !isDesktop && isPasskeySupported();

    const slug = new URLSearchParams(window.location.search).get("org") || "";
    const logoSrc = branding?.logo_url
        ? `${serverURL}/api/public/branding/logo${slug ? `?slug=${slug}` : ""}`
        : null;

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setError("");
        setLoading(true);
        try {
            const { data } = await loginApi(form);
            saveAuth((data as any).user);
        } catch (err: any) {
            setError(err.response?.data?.error || "Login failed");
        } finally {
            setLoading(false);
        }
    };

    // Desktop: detect an enrolled biometric credential on mount so we can show
    // the "Sign in with Windows Hello / Touch ID" button.
    useEffect(() => {
        if (!isDesktop) return;
        let cancelled = false;
        (async () => {
            const status = await desktopBiometricStatus();
            if (!cancelled) setDesktopBioEnrolled(status.available && status.enrolled);
        })();
        return () => {
            cancelled = true;
        };
    }, [isDesktop]);

    // Conditional mediation (passkey autofill): when the browser supports it,
    // silently arm a background passkey request on mount. The browser surfaces
    // saved passkeys inline in the username field; if the user picks one we get
    // a successful assertion and sign them in without any button click. If the
    // browser/user ignores it, nothing happens (and the manual button remains).
    useEffect(() => {
        let aborted = false;
        const controller = new AbortController();
        (async () => {
            if (!passkeySupported) return;
            if (!(await isConditionalMediationAvailable())) return;
            try {
                const { user } = await loginWithPasskey({ conditional: true, signal: controller.signal });
                if (!aborted) saveAuth(user);
            } catch {
                // Aborted / unsupported / no passkey chosen — fall back to the
                // manual button + password form silently.
            }
        })();
        return () => {
            aborted = true;
            controller.abort();
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [passkeySupported]);

    // Desktop biometric login: prompts Windows Hello / Touch ID via the
    // Electron bridge, unlocks the stored device secret, and exchanges it for
    // a session (identical to a password login from here).
    const handleDesktopBiometricLogin = async () => {
        setError("");
        setDesktopBioLoading(true);
        try {
            const { user } = await desktopBiometricLogin();
            saveAuth(user);
        } catch (err: any) {
            setError(err?.response?.data?.error || err?.message || "Biometric sign-in failed. Use your password instead.");
        } finally {
            setDesktopBioLoading(false);
        }
    };

    // Passkey (WebAuthn) login: the browser's platform authenticator prompts
    // for the OS biometric, signs the server challenge, and on success the
    // server sets the auth cookie — identical to a password login from here.
    const handlePasskeyLogin = async () => {
        setError("");
        setPasskeyLoading(true);
        try {
            const { user } = await loginWithPasskey();
            saveAuth(user);
        } catch (err: any) {
            // A NotAllowedError / AbortError means the user cancelled the OS
            // prompt — stay silent in that case.
            const name = err?.name;
            if (name === "NotAllowedError" || name === "AbortError") {
                // user cancelled — no-op
            } else {
                setError(err.response?.data?.error || "Passkey sign-in failed. Use your password instead.");
            }
        } finally {
            setPasskeyLoading(false);
        }
    };

    return (
        <div className={s["auth-container"]}>
            <div className={s["auth-card"]}>

                {logoSrc
                    ? <img src={logoSrc} alt="Organization" className={s["auth-logo"]} />
                    : <div className={s["auth-icon"]}><ShieldCheck size={28} strokeWidth={1.5} /></div>
                }
                <h2>Welcome Back</h2>
                <p>Sign in to {branding?.org_name || "WorkPulse"}</p>
                {(location.state as any)?.message && <div className="success-msg">{(location.state as any).message}</div>}
                {error && <div className="error-msg">{error}</div>}

                <form onSubmit={handleSubmit}>
                    <div className="form-group">
                        <label htmlFor="login-username">Username</label>
                        <input
                            id="login-username"
                            type="text"
                            autoComplete="username webauthn"
                            value={form.username}
                            onChange={e => setForm({ ...form, username: e.target.value })}
                            placeholder="Enter your username"
                            required
                        />
                    </div>
                    <div className="form-group">
                        <label htmlFor="login-password">Password</label>
                        <PasswordInput
                            id="login-password"
                            value={form.password}
                            onChange={e => setForm({ ...form, password: e.target.value })}
                            placeholder="Enter your password"
                            required
                        />
                    </div>
                    <div className={s["auth-forgot"]}>
                        <Link to="/forgot-password">Forgot password?</Link>
                    </div>
                    <button type="submit" className="btn btn-primary btn-fullwidth" disabled={loading}>
                        {loading ? "Signing in..." : <span style={{ display: "inline-flex", alignItems: "center", gap: "0.4rem" }}>Sign In <ArrowRight size={16} /></span>}
                    </button>
                </form>
                {isDesktop && desktopBioEnrolled && (
                    <>
                        <div className={s["auth-divider"]}><span>or</span></div>
                        <button
                            type="button"
                            className="btn btn-secondary btn-fullwidth"
                            onClick={handleDesktopBiometricLogin}
                            disabled={desktopBioLoading}
                        >
                            <span style={{ display: "inline-flex", alignItems: "center", gap: "0.4rem", justifyContent: "center" }}>
                                <Fingerprint size={16} />
                                {desktopBioLoading ? "Waiting for biometrics..." : "Sign in with biometrics"}
                            </span>
                        </button>
                    </>
                )}
                {passkeySupported && (
                    <>
                        <div className={s["auth-divider"]}><span>or</span></div>
                        <button
                            type="button"
                            className="btn btn-secondary btn-fullwidth"
                            onClick={handlePasskeyLogin}
                            disabled={passkeyLoading}
                        >
                            <span style={{ display: "inline-flex", alignItems: "center", gap: "0.4rem", justifyContent: "center" }}>
                                <Fingerprint size={16} />
                                {passkeyLoading ? "Waiting for passkey..." : "Sign in with a passkey"}
                            </span>
                        </button>
                    </>
                )}
                <div className={s["auth-switch"]}>
                    Don't have an account? <Link to="/register">Register</Link>
                </div>
            </div>
        </div>
    );
}
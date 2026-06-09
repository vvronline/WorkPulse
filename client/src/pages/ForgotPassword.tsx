import React, { useState } from "react";
import { Link } from "react-router-dom";
import { forgotPassword } from "../api";
import { KeyRound } from "lucide-react";
import { useAutoDismiss } from "../hooks/useAutoDismiss";
import s from "./Auth.module.css";

export default function ForgotPassword() {
    const [email, setEmail] = useState("");
    const [error, setError] = useAutoDismiss("") as [string, (v: string) => void];
    const [success, setSuccess] = useAutoDismiss("") as [string, (v: string) => void];
    const [loading, setLoading] = useState(false);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setError("");
        setSuccess("");
        setLoading(true);
        try {
            const { data } = await forgotPassword({ email });
            setSuccess((data as any).message);
        } catch (err: any) {
            setError(err.response?.data?.error || "Something went wrong");
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className={s["auth-container"]}>
            <div className={s["auth-card"]}>
                <div className={s["auth-icon"]}><KeyRound size={28} strokeWidth={1.5} /></div>
                <h2>Forgot Password</h2>
                <p>Enter your email and we'll send you a reset link</p>

                {error && <div className="error-msg">{error}</div>}
                {success && <div className={s["success-msg"]}>{success}</div>}

                {!success ? (
                    <form onSubmit={handleSubmit}>
                        <div className="form-group">
                            <label htmlFor="forgot-email">Email Address</label>
                            <input
                                id="forgot-email"
                                type="email"
                                value={email}
                                onChange={e => setEmail(e.target.value)}
                                placeholder="Enter your registered email"
                                required
                            />
                        </div>
                        <button type="submit" className="btn btn-primary btn-fullwidth" disabled={loading}>
                            {loading ? "Sending..." : "Send Reset Link"}
                        </button>
                    </form>
                ) : (
                    <div className={s["reset-sent"]}>
                        <div className={s["reset-sent-icon"]}>✉️</div>
                        <p>Check your inbox for the reset link. It will expire in 1 hour.</p>
                    </div>
                )}

                <div className={s["auth-switch"]}>
                    Remember your password? <Link to="/login">Sign in</Link>
                </div>
            </div>
        </div>
    );
}
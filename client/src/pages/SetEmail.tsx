import React, { useState } from "react";
import { useAuth } from "../AuthContext";
import { updateEmail } from "../api";
import { useAutoDismiss } from "../hooks/useAutoDismiss";
import s from "./Auth.module.css";

export default function SetEmail() {
    const { user, updateUser } = useAuth() as any;
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
            await updateEmail(email);
            updateUser({ email });
            setSuccess("Email saved successfully!");
        } catch (err: any) {
            setError(err.response?.data?.error || "Failed to save email");
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className={s["auth-container"]}>
            <div className={s["auth-card"]}>
                <div className={s["auth-icon"]}>📧</div>
                <h2>Add Your Email</h2>
                <p>Hi {user?.full_name || user?.username}, an email address is now required for account recovery.</p>

                {error && <div className="error-msg">{error}</div>}
                {success && <div className="success-msg">{success}</div>}

                <form onSubmit={handleSubmit}>
                    <div className="form-group">
                        <label htmlFor="set-email">Email Address</label>
                        <input
                            id="set-email"
                            type="email"
                            value={email}
                            onChange={e => setEmail(e.target.value)}
                            placeholder="Enter your email address"
                            required
                        />
                    </div>
                    <button type="submit" className="btn btn-primary btn-fullwidth" disabled={loading}>
                        {loading ? "Saving..." : "Continue"}
                    </button>
                </form>
            </div>
        </div>
    );
}
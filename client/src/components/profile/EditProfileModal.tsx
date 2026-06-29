import { useState, useEffect, useRef, useCallback } from "react";
import ReactDOM from "react-dom";
import { X, User, Mail, Lock, AlertTriangle, Trash2, Fingerprint, Plus, Smartphone, Monitor } from "lucide-react";
import { useAuth } from "../../AuthContext";
import {
    updateProfile,
    updateEmail,
    updatePassword,
    deleteAccount,
    listBiometricDevices,
    revokeBiometricDevice,
} from "../../api";
import PasswordInput from "../common/PasswordInput";
import { useAsyncAction } from "../../hooks/useAsyncAction";
import {
    isPasskeySupported,
    registerPasskey,
    listPasskeys,
    removePasskey,
    type PasskeyDevice,
} from "../../auth/webauthn";
import {
    isDesktopBiometricBridge,
    desktopBiometricStatus,
    enableDesktopBiometric,
    disableDesktopBiometric,
} from "../../auth/desktopBiometric";
import s from "./EditProfileModal.module.css";

interface EditProfileModalProps {
    onClose: () => void;
}

export default function EditProfileModal({ onClose }: EditProfileModalProps) {
    const { user, updateUser, logout } = useAuth() as any;
    const modalRef = useRef<HTMLDivElement | null>(null);

    // Focus trap and Escape key handler
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === "Escape") {
                onClose();
                return;
            }
            if (e.key === "Tab") {
                const focusable = modalRef.current?.querySelectorAll<HTMLElement>(
                    'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
                );
                if (!focusable || focusable.length === 0) return;
                const first = focusable[0];
                const last = focusable[focusable.length - 1];
                if (e.shiftKey) {
                    if (document.activeElement === first) {
                        e.preventDefault();
                        last.focus();
                    }
                } else {
                    if (document.activeElement === last) {
                        e.preventDefault();
                        first.focus();
                    }
                }
            }
        };

        document.addEventListener("keydown", handleKeyDown);
        return () => document.removeEventListener("keydown", handleKeyDown);
    }, [onClose]);

    // Section: profile
    const [fullName, setFullName] = useState(user?.full_name || "");
    const [username, setUsername] = useState(user?.username || "");
    const profileAction = useAsyncAction() as any;

    // Section: email
    const [email, setEmail] = useState(user?.email || "");
    const emailAction = useAsyncAction() as any;

    // Section: password
    const [curPw, setCurPw] = useState("");
    const [newPw, setNewPw] = useState("");
    const [confirmPw, setConfirmPw] = useState("");
    const pwAction = useAsyncAction() as any;

    // Section: passkeys (WebAuthn)
    const passkeySupported = isPasskeySupported();
    const [passkeys, setPasskeys] = useState<PasskeyDevice[]>([]);
    const passkeyAction = useAsyncAction() as any;

    const loadPasskeys = useCallback(async () => {
        if (!passkeySupported) return;
        try {
            setPasskeys(await listPasskeys());
        } catch {
            /* non-fatal — list stays empty */
        }
    }, [passkeySupported]);

    useEffect(() => {
        loadPasskeys();
    }, [loadPasskeys]);

    const handleAddPasskey = () => {
        passkeyAction.run(async () => {
            await registerPasskey();
            await loadPasskeys();
            return "Passkey added! You can now sign in with it.";
        });
    };

    const handleRemovePasskey = (id: number) => {
        passkeyAction.run(async () => {
            await removePasskey(id);
            await loadPasskeys();
            return "Passkey removed.";
        });
    };

    // Section: registered biometric devices (mobile Face ID / desktop Windows
    // Hello / Touch ID). These are `device_credentials` rows — distinct from
    // WebAuthn passkeys. Listing them here gives a single "Manage devices"
    // view so a user can see and revoke every device that can biometric-login
    // to their account, from any platform.
    interface BiometricDevice {
        id: string;
        device_label: string | null;
        platform: string;
        created_at: string;
        last_used_at: string | null;
    }
    const [bioDevices, setBioDevices] = useState<BiometricDevice[]>([]);
    const bioDevicesAction = useAsyncAction() as any;

    const loadBioDevices = useCallback(async () => {
        try {
            const { data } = await listBiometricDevices();
            setBioDevices(data.devices || []);
        } catch {
            /* non-fatal — list stays empty */
        }
    }, []);

    useEffect(() => {
        loadBioDevices();
    }, [loadBioDevices]);

    const handleRevokeBioDevice = (id: string) => {
        bioDevicesAction.run(async () => {
            await revokeBiometricDevice(id);
            await loadBioDevices();
            await loadDesktopBio();
            return "Device removed.";
        });
    };

    const platformLabel = (p: string): string => {
        switch (p) {
            case "ios": return "iPhone / iPad";
            case "android": return "Android device";
            case "desktop": return "Desktop app";
            case "web": return "Web browser";
            default: return p;
        }
    };

    // Section: desktop biometric (Electron — Windows Hello / Touch ID).
    // Distinct from web passkeys: it gates a device secret behind the OS
    // biometric via the Electron bridge (see desktop/biometric.ts).
    const isDesktop = isDesktopBiometricBridge();
    const [desktopBio, setDesktopBio] = useState<{ available: boolean; enrolled: boolean }>({
        available: false,
        enrolled: false,
    });
    const desktopBioAction = useAsyncAction() as any;

    const loadDesktopBio = useCallback(async () => {
        if (!isDesktop) return;
        const status = await desktopBiometricStatus();
        setDesktopBio({ available: status.available, enrolled: status.enrolled });
    }, [isDesktop]);

    useEffect(() => {
        loadDesktopBio();
    }, [loadDesktopBio]);

    const handleEnableDesktopBio = () => {
        desktopBioAction.run(async () => {
            await enableDesktopBiometric();
            await loadDesktopBio();
            return "Biometric sign-in enabled on this device.";
        });
    };

    const handleDisableDesktopBio = () => {
        desktopBioAction.run(async () => {
            await disableDesktopBiometric();
            await loadDesktopBio();
            return "Biometric sign-in disabled on this device.";
        });
    };

    // Section: delete
    const [deletePw, setDeletePw] = useState("");
    const [deleteConfirm, setDeleteConfirm] = useState(false);
    const deleteAction = useAsyncAction() as any;

    const handleProfileSave = (e: React.FormEvent) => {
        e.preventDefault();
        profileAction.run(async () => {
            const { data } = await updateProfile({ full_name: fullName, username });
            updateUser({ full_name: data.full_name, username: data.username });
            return "Profile updated!";
        });
    };

    const handleEmailSave = (e: React.FormEvent) => {
        e.preventDefault();
        emailAction.run(async () => {
            await updateEmail(email);
            updateUser({ email });
            return "Email updated!";
        });
    };

    const handlePasswordSave = (e: React.FormEvent) => {
        e.preventDefault();
        if (newPw !== confirmPw) {
            pwAction.run(async () => {
                throw { response: { data: { error: "New passwords do not match" } } };
            });
            return;
        }
        if (newPw.length < 8) {
            pwAction.run(async () => {
                throw { response: { data: { error: "Password must be at least 8 characters" } } };
            });
            return;
        }
        pwAction.run(async () => {
            await updatePassword({ current_password: curPw, new_password: newPw });
            setCurPw("");
            setNewPw("");
            setConfirmPw("");
            return "Password changed successfully!";
        });
    };

    const handleDeleteAccount = () => {
        if (!deletePw) {
            deleteAction.run(async () => {
                throw { response: { data: { error: "Please enter your password to confirm" } } };
            });
            return;
        }
        deleteAction.run(async () => {
            await deleteAccount(deletePw);
            logout();
        });
    };

    return ReactDOM.createPortal(
        <div className={s.overlay} onClick={(e) => e.target === e.currentTarget && onClose()}>
            <div
                className={s.modal}
                ref={modalRef}
                role="dialog"
                aria-modal="true"
                aria-labelledby="edit-profile-title"
            >
                {/* Header */}
                <div className={s.header}>
                    <h2 className={s.title} id="edit-profile-title">
                        Edit Profile
                    </h2>
                    <button className={s.closeBtn} onClick={onClose} aria-label="Close">
                        <X size={16} />
                    </button>
                </div>

                <div className={s.body}>
                    {/* ── Name & Username ── */}
                    <section className={s.section}>
                        <h3 className={s.sectionTitle}>
                            <User
                                size={15}
                                style={{ verticalAlign: "middle", marginRight: 6 }}
                            />
                            Name & Username
                        </h3>
                        <form onSubmit={handleProfileSave} className={s.form}>
                            <div className={s.field}>
                                <label>Full Name</label>
                                <input
                                    type="text"
                                    value={fullName}
                                    onChange={(e) => setFullName(e.target.value)}
                                    placeholder="Your full name"
                                    required
                                />
                            </div>
                            <div className={s.field}>
                                <label>Username</label>
                                <div className={s.inputPrefix}>
                                    <span>@</span>
                                    <input
                                        type="text"
                                        value={username}
                                        onChange={(e) =>
                                            setUsername(
                                                e.target.value.toLowerCase().replace(/\s/g, "")
                                            )
                                        }
                                        placeholder="username"
                                        required
                                    />
                                </div>
                            </div>
                            {profileAction.msg && (
                                <p className={profileAction.msg.ok ? s.success : s.error}>
                                    {profileAction.msg.text}
                                </p>
                            )}
                            <button
                                type="submit"
                                className={s.saveBtn}
                                disabled={profileAction.loading}
                            >
                                {profileAction.loading ? "Saving…" : "Save Changes"}
                            </button>
                        </form>
                    </section>

                    <div className={s.divider} />

                    {/* ── Email ── */}
                    <section className={s.section}>
                        <h3 className={s.sectionTitle}>
                            <Mail
                                size={15}
                                style={{ verticalAlign: "middle", marginRight: 6 }}
                            />
                            Email Address
                        </h3>
                        <form onSubmit={handleEmailSave} className={s.form}>
                            <div className={s.field}>
                                <label>Email</label>
                                <input
                                    type="email"
                                    value={email}
                                    onChange={(e) => setEmail(e.target.value)}
                                    placeholder="you@example.com"
                                    required
                                />
                            </div>
                            {emailAction.msg && (
                                <p className={emailAction.msg.ok ? s.success : s.error}>
                                    {emailAction.msg.text}
                                </p>
                            )}
                            <button
                                type="submit"
                                className={s.saveBtn}
                                disabled={emailAction.loading}
                            >
                                {emailAction.loading ? "Saving…" : "Update Email"}
                            </button>
                        </form>
                    </section>

                    <div className={s.divider} />

                    {/* ── Password ── */}
                    <section className={s.section}>
                        <h3 className={s.sectionTitle}>
                            <Lock
                                size={15}
                                style={{ verticalAlign: "middle", marginRight: 6 }}
                            />
                            Change Password
                        </h3>
                        <form onSubmit={handlePasswordSave} className={s.form}>
                            <div className={s.field}>
                                <label>Current Password</label>
                                <PasswordInput
                                    value={curPw}
                                    onChange={(e) => setCurPw(e.target.value)}
                                    placeholder="Enter current password"
                                    required
                                />
                            </div>
                            <div className={s.field}>
                                <label>New Password</label>
                                <PasswordInput
                                    value={newPw}
                                    onChange={(e) => setNewPw(e.target.value)}
                                    placeholder="Min 8 characters"
                                    required
                                />
                            </div>
                            <div className={s.field}>
                                <label>Confirm New Password</label>
                                <PasswordInput
                                    value={confirmPw}
                                    onChange={(e) => setConfirmPw(e.target.value)}
                                    placeholder="Repeat new password"
                                    required
                                />
                            </div>
                            {pwAction.msg && (
                                <p className={pwAction.msg.ok ? s.success : s.error}>
                                    {pwAction.msg.text}
                                </p>
                            )}
                            <button
                                type="submit"
                                className={s.saveBtn}
                                disabled={pwAction.loading}
                            >
                                {pwAction.loading ? "Saving…" : "Change Password"}
                            </button>
                        </form>
                    </section>

                    {isDesktop && (
                        <>
                            <div className={s.divider} />
                            {/* ── Desktop biometric (Windows Hello / Touch ID) ── */}
                            <section className={s.section}>
                                <h3 className={s.sectionTitle}>
                                    <Fingerprint
                                        size={15}
                                        style={{ verticalAlign: "middle", marginRight: 6 }}
                                    />
                                    Biometric Login (this device)
                                </h3>
                                <p className={s.dangerDesc} style={{ color: "var(--text-secondary)" }}>
                                    Sign in to the desktop app with Windows Hello / Touch ID instead
                                    of a password. The credential is stored encrypted on this device
                                    and your biometric never leaves it.
                                </p>
                                {!desktopBio.available && (
                                    // Surface WHY the toggle is unavailable rather than hiding the
                                    // whole section — the silent hide was the #1 "I can't find
                                    // biometric login" confusion. Windows Hello / Touch ID must be
                                    // set up in the OS first (PIN + face/fingerprint enrolled).
                                    <p className={s.error} style={{ marginTop: 0 }}>
                                        No biometric hardware is set up on this device. Enable Windows
                                        Hello (Settings → Accounts → Sign-in options) or Touch ID in
                                        macOS, then reopen this dialog.
                                    </p>
                                )}
                                {desktopBioAction.msg && (
                                    <p className={desktopBioAction.msg.ok ? s.success : s.error}>
                                        {desktopBioAction.msg.text}
                                    </p>
                                )}
                                {!desktopBio.available ? null : desktopBio.enrolled ? (
                                    <button
                                        className={s.cancelBtn}
                                        onClick={handleDisableDesktopBio}
                                        disabled={desktopBioAction.loading}
                                    >
                                        <span style={{ display: "inline-flex", alignItems: "center", gap: "0.4rem" }}>
                                            <Trash2 size={14} />
                                            {desktopBioAction.loading ? "Working…" : "Disable biometric sign-in"}
                                        </span>
                                    </button>
                                ) : (
                                    <button
                                        className={s.saveBtn}
                                        onClick={handleEnableDesktopBio}
                                        disabled={desktopBioAction.loading}
                                    >
                                        <span style={{ display: "inline-flex", alignItems: "center", gap: "0.4rem" }}>
                                            <Plus size={14} />
                                            {desktopBioAction.loading ? "Working…" : "Enable biometric sign-in"}
                                        </span>
                                    </button>
                                )}
                            </section>
                        </>
                    )}

                    {!isDesktop && (
                        <>
                            <div className={s.divider} />
                            {/* ── Passkeys (biometric login) ── */}
                            <section className={s.section}>
                                <h3 className={s.sectionTitle}>
                                    <Fingerprint
                                        size={15}
                                        style={{ verticalAlign: "middle", marginRight: 6 }}
                                    />
                                    Passkeys &amp; Biometric Login
                                </h3>
                                <p className={s.dangerDesc} style={{ color: "var(--text-secondary)" }}>
                                    Sign in with your fingerprint, face, or device PIN instead of a
                                    password. Your biometric never leaves this device.
                                </p>
                                {!passkeySupported && (
                                    // WebAuthn requires a secure context (HTTPS or localhost). On a
                                    // plain-HTTP origin the API is absent and the button would
                                    // silently disappear — explain why instead.
                                    <p className={s.error} style={{ marginTop: 0 }}>
                                        Passkeys aren't available in this browser. They require a
                                        secure (HTTPS) connection and a device that supports
                                        Touch ID / Windows Hello / a screen-lock. Open Loops over
                                        HTTPS and try again.
                                    </p>
                                )}
                                {passkeys.length > 0 && (
                                    <ul style={{ listStyle: "none", padding: 0, margin: "0 0 0.75rem" }}>
                                        {passkeys.map((pk) => (
                                            <li
                                                key={pk.id}
                                                style={{
                                                    display: "flex",
                                                    alignItems: "center",
                                                    justifyContent: "space-between",
                                                    gap: "0.5rem",
                                                    padding: "0.5rem 0",
                                                    borderBottom: "1px solid var(--glass-border)",
                                                }}
                                            >
                                                <span style={{ display: "inline-flex", alignItems: "center", gap: "0.5rem" }}>
                                                    <Fingerprint size={14} />
                                                    <span>
                                                        {pk.device_label || "Passkey"}
                                                        {pk.last_used_at && (
                                                            <span style={{ color: "var(--text-secondary)", fontSize: "0.8rem", marginLeft: 6 }}>
                                                                last used {new Date(pk.last_used_at).toLocaleDateString()}
                                                            </span>
                                                        )}
                                                    </span>
                                                </span>
                                                <button
                                                    className={s.cancelBtn}
                                                    onClick={() => handleRemovePasskey(pk.id)}
                                                    disabled={passkeyAction.loading}
                                                    aria-label="Remove passkey"
                                                >
                                                    <Trash2 size={14} />
                                                </button>
                                            </li>
                                        ))}
                                    </ul>
                                )}
                                {passkeyAction.msg && (
                                    <p className={passkeyAction.msg.ok ? s.success : s.error}>
                                        {passkeyAction.msg.text}
                                    </p>
                                )}
                                {passkeySupported && (
                                    <button
                                        className={s.saveBtn}
                                        onClick={handleAddPasskey}
                                        disabled={passkeyAction.loading}
                                    >
                                        <span style={{ display: "inline-flex", alignItems: "center", gap: "0.4rem" }}>
                                            <Plus size={14} />
                                            {passkeyAction.loading ? "Working…" : "Add a passkey"}
                                        </span>
                                    </button>
                                )}
                            </section>
                        </>
                    )}

                    {bioDevices.length > 0 && (
                        <>
                            <div className={s.divider} />
                            {/* ── Manage devices (all biometric-login devices) ── */}
                            <section className={s.section}>
                                <h3 className={s.sectionTitle}>
                                    <Smartphone
                                        size={15}
                                        style={{ verticalAlign: "middle", marginRight: 6 }}
                                    />
                                    Devices with biometric sign-in
                                </h3>
                                <p className={s.dangerDesc} style={{ color: "var(--text-secondary)" }}>
                                    These devices can sign in to your account with Face ID, Touch ID,
                                    or Windows Hello. Remove any you no longer use — removing a device
                                    forces it back to password sign-in.
                                </p>
                                {bioDevicesAction.msg && (
                                    <p className={bioDevicesAction.msg.ok ? s.success : s.error}>
                                        {bioDevicesAction.msg.text}
                                    </p>
                                )}
                                <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
                                    {bioDevices.map((d) => (
                                        <li
                                            key={d.id}
                                            style={{
                                                display: "flex",
                                                alignItems: "center",
                                                justifyContent: "space-between",
                                                gap: "0.5rem",
                                                padding: "0.5rem 0",
                                                borderBottom: "1px solid var(--glass-border)",
                                            }}
                                        >
                                            <span style={{ display: "inline-flex", alignItems: "center", gap: "0.5rem" }}>
                                                {d.platform === "desktop" ? <Monitor size={14} /> : <Smartphone size={14} />}
                                                <span>
                                                    {d.device_label || platformLabel(d.platform)}
                                                    <span style={{ color: "var(--text-secondary)", fontSize: "0.8rem", marginLeft: 6 }}>
                                                        {platformLabel(d.platform)}
                                                        {d.last_used_at && (
                                                            <> · last used {new Date(d.last_used_at).toLocaleDateString()}</>
                                                        )}
                                                    </span>
                                                </span>
                                            </span>
                                            <button
                                                className={s.cancelBtn}
                                                onClick={() => handleRevokeBioDevice(d.id)}
                                                disabled={bioDevicesAction.loading}
                                                aria-label="Remove device"
                                            >
                                                <Trash2 size={14} />
                                            </button>
                                        </li>
                                    ))}
                                </ul>
                            </section>
                        </>
                    )}

                    <div className={s.divider} />

                    {/* ── Danger Zone ── */}
                    <section className={`${s.section} ${s.dangerSection}`}>
                        <h3 className={`${s.sectionTitle} ${s.dangerTitle}`}>
                            <AlertTriangle
                                size={15}
                                style={{ verticalAlign: "middle", marginRight: 6 }}
                            />
                            Danger Zone
                        </h3>
                        <p className={s.dangerDesc}>
                            Permanently delete your account and all associated data. This action
                            cannot be undone.
                        </p>
                        {!deleteConfirm ? (
                            <button
                                className={s.dangerBtn}
                                onClick={() => setDeleteConfirm(true)}
                            >
                                Delete My Account
                            </button>
                        ) : (
                            <div className={s.deleteConfirmBox}>
                                <p className={s.deleteConfirmLabel}>
                                    Enter your password to confirm deletion:
                                </p>
                                <PasswordInput
                                    value={deletePw}
                                    onChange={(e) => setDeletePw(e.target.value)}
                                    placeholder="Your password"
                                    className={s.deleteInput}
                                />
                                {deleteAction.msg && (
                                    <p className={s.error}>{deleteAction.msg.text}</p>
                                )}
                                <div className={s.deleteActions}>
                                    <button
                                        className={s.dangerBtnConfirm}
                                        onClick={handleDeleteAccount}
                                        disabled={deleteAction.loading}
                                    >
                                        {deleteAction.loading ? (
                                            "Deleting…"
                                        ) : (
                                            <>
                                                <Trash2
                                                    size={14}
                                                    style={{
                                                        marginRight: 5,
                                                        verticalAlign: "middle",
                                                    }}
                                                />
                                                Yes, Delete Forever
                                            </>
                                        )}
                                    </button>
                                    <button
                                        className={s.cancelBtn}
                                        onClick={() => {
                                            setDeleteConfirm(false);
                                            setDeletePw("");
                                        }}
                                    >
                                        Cancel
                                    </button>
                                </div>
                            </div>
                        )}
                    </section>
                </div>
            </div>
        </div>,
        document.body
    );
}
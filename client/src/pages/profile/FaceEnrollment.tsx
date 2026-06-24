import { useEffect, useState } from "react";
import { ShieldCheck, ShieldOff, RefreshCw, Trash2, ChevronLeft } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { getFaceStatus, enrollFace, clearFaceEnrollment } from "../../api";
import FaceCapture from "../../components/attendance/FaceCapture";
import s from "./FaceEnrollment.module.css";

interface FaceStatus {
    loading: boolean;
    enrolled: boolean;
    enrolled_at: string | null;
}

interface ToastState {
    kind: "ok" | "err";
    text: string;
}

/**
 * Profile → Face Enrollment.
 *
 * Lets the user enrol (or re-enrol) a single face descriptor for
 * attendance verification. The actual image stays in the browser; only
 * the 128-float embedding is sent to the server.
 */
export default function FaceEnrollment() {
    const navigate = useNavigate();
    const [status, setStatus] = useState<FaceStatus>({ loading: true, enrolled: false, enrolled_at: null });
    const [mode, setMode] = useState<"view" | "capture">("view"); // 'view' | 'capture'
    const [busy, setBusy] = useState(false);
    const [toast, setToast] = useState<ToastState | null>(null);

    async function refreshStatus() {
        try {
            const r = await getFaceStatus();
            setStatus({
                loading: false,
                enrolled: !!(r.data as any).enrolled,
                enrolled_at: (r.data as any).enrolled_at,
            });
        } catch {
            setStatus({ loading: false, enrolled: false, enrolled_at: null });
        }
    }

    useEffect(() => {
        refreshStatus();
    }, []);

    async function handleEnroll(descriptor: any) {
        setBusy(true);
        setToast(null);
        try {
            await enrollFace(descriptor);
            setToast({ kind: "ok", text: "Face enrolled successfully." });
            setMode("view");
            await refreshStatus();
        } catch (err: any) {
            const msg = err?.response?.data?.error || "Failed to enrol face. Try again.";
            setToast({ kind: "err", text: msg });
        } finally {
            setBusy(false);
        }
    }

    async function handleClear() {
        if (
            !window.confirm(
                "Clear your face enrollment? You will need to re-enroll to clock in when attendance verification is on."
            )
        )
            return;
        setBusy(true);
        setToast(null);
        try {
            await clearFaceEnrollment();
            setToast({ kind: "ok", text: "Face enrollment cleared." });
            setMode("view");
            await refreshStatus();
        } catch {
            setToast({ kind: "err", text: "Failed to clear enrollment." });
        } finally {
            setBusy(false);
        }
    }

    return (
        <div className={s.page}>
            <div className={s.header}>
                <button onClick={() => navigate(-1)} className={s.back} style={{ background: "none", border: "none", cursor: "pointer", display: "flex", alignItems: "center", gap: "0.25rem" }}>
                    <ChevronLeft size={16} /> Profile
                </button>
                <h1>Face Enrollment</h1>
                <p className={s.lede}>
                    Enrol your face so you can clock in when your organization requires attendance verification. Your
                    photo never leaves this device — only a numerical representation is stored.
                </p>
            </div>

            <div className={`${s.statusCard} ${status.enrolled ? s.ok : s.notEnrolled}`}>
                {status.enrolled ? (
                    <>
                        <ShieldCheck size={20} />{" "}
                        <span>
                            Enrolled
                            {status.enrolled_at ? ` on ${new Date(status.enrolled_at).toLocaleDateString()}` : ""}
                        </span>
                    </>
                ) : (
                    <>
                        <ShieldOff size={20} /> <span>Not enrolled yet</span>
                    </>
                )}
            </div>

            {toast && <div className={`${s.toast} ${s[toast.kind]}`}>{toast.text}</div>}

            {mode === "view" && (
                <div className={s.actions}>
                    {status.enrolled ? (
                        <>
                            <button className="btn btn-secondary" onClick={() => setMode("capture")} disabled={busy}>
                                <RefreshCw size={14} /> Re-enroll
                            </button>
                            <button className="btn btn-danger" onClick={handleClear} disabled={busy}>
                                <Trash2 size={14} /> Clear Enrollment
                            </button>
                        </>
                    ) : (
                        <button className="btn btn-primary" onClick={() => setMode("capture")} disabled={busy}>
                            Start Enrollment
                        </button>
                    )}
                </div>
            )}

            {mode === "capture" && (
                <div className={s.captureBox}>
                    <h3>
                        Position your face inside the circle and click <em>Enroll Face</em>.
                    </h3>
                    <FaceCapture
                        autoStart
                        captureLabel="Enroll Face"
                        capturingLabel="Enrolling..."
                        onCapture={handleEnroll}
                        disabled={busy}
                    />
                    <div className={s.captureFoot}>
                        <button className="btn btn-secondary btn-sm" onClick={() => setMode("view")} disabled={busy}>
                            Cancel
                        </button>
                    </div>
                </div>
            )}

            <div className={s.tips}>
                <h4>Tips for a good enrollment</h4>
                <ul>
                    <li>Face the camera straight on with even lighting.</li>
                    <li>Remove sunglasses, hats, or masks that cover your face.</li>
                    <li>Keep only one face in frame.</li>
                </ul>
            </div>
        </div>
    );
}
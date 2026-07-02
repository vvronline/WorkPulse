import { useEffect, useState } from "react";
import { ShieldCheck, Loader2, X, AlertTriangle, CheckCircle2, Wifi, WifiOff, MapPin, ScanFace } from "lucide-react";
import FaceCapture from "./FaceCapture";
import { preloadFaceModels } from "../../utils/faceApi";
import { getOfficeSignals, geolocationErrorMessage } from "../../utils/geolocation";
import type { Position, WifiInfo, PositionSource } from "../../utils/geolocation";
import { getCurrentOrg } from "../../api";
import s from "./ClockInVerifyModal.module.css";

type WorkMode = "office" | "remote" | "hybrid";

interface OrgWifiState {
    enabled: boolean;
    bssids: Set<string>;
}

interface LocErrState {
    message: string;
    code?: string;
    accuracy?: number;
    source?: PositionSource;
}

interface SubmitErrState {
    message: string;
    code?: string;
}

type SubmitErrKind = "location" | "face" | "generic";

const LOCATION_CODES = new Set([
    "OUTSIDE_GEOFENCE",
    "LOCATION_REQUIRED",
    "OFFICE_LOCATION_NOT_CONFIGURED",
    "LOCATION_TOO_COARSE",
]);
const FACE_CODES = new Set([
    "FACE_MISMATCH",
    "FACE_NOT_ENROLLED",
    "FACE_REQUIRED",
    "FACE_REPLAY",
    "FACE_ATTEMPTS_LOCKED",
]);

/**
 * Classify a server clock-in error (code + message) so the modal can show a
 * specific "Location Mismatch" / "Face Mismatch" title + icon instead of a
 * single flat red line. Falls back to keyword sniffing when no code is sent.
 */
function classifySubmitErr(message: string, code?: string): { kind: SubmitErrKind; title: string } {
    const lower = message.toLowerCase();
    const isLocation =
        (code && LOCATION_CODES.has(code)) ||
        (!code && (lower.includes("office") || lower.includes("geofence") || lower.includes("location") || lower.includes(" m from")));
    const isFace =
        (code && FACE_CODES.has(code)) ||
        (!code && lower.includes("face"));
    if (isLocation) return { kind: "location", title: "Location Mismatch" };
    if (isFace) return { kind: "face", title: "Face Mismatch" };
    return { kind: "generic", title: "Login Failed" };
}

interface ClockInPayload {
    work_mode: WorkMode;
    face_descriptor: number[] | Float32Array;
    latitude?: number;
    longitude?: number;
    accuracy?: number;
    wifi_bssid?: string;
}

interface ClockInVerifyModalProps {
    workMode: WorkMode;
    submitClockIn: (payload: ClockInPayload) => Promise<unknown>;
    onSuccess?: () => void;
    onClose?: () => void;
}

/** Normalise any MAC-ish string to canonical AA:BB:CC:DD:EE:FF (or null). */
function normaliseBssid(raw: unknown): string | null {
    if (typeof raw !== "string") return null;
    const cleaned = raw.replace(/[^0-9a-fA-F]/g, "").toUpperCase();
    if (cleaned.length !== 12) return null;
    return cleaned.match(/.{2}/g)!.join(":");
}

/**
 * Pre-flight verification before a `POST /tracker/clock-in` call.
 *
 * Steps:
 *   1. (office / hybrid) Collect "office signals" — Wi-Fi BSSID + geolocation
 *      in parallel. If the org has the office Wi-Fi allow-list configured
 *      and the user is connected to one of those APs, the server can
 *      verify on-site presence by BSSID alone and skip the geofence
 *      entirely (more reliable than GPS on packaged Electron builds).
 *   2. Open the webcam and extract a 128-float face descriptor.
 *   3. Call `submitClockIn({ work_mode, latitude, longitude, accuracy,
 *      wifi_bssid, face_descriptor })`.
 *
 * `submitClockIn` returns the API response on success, or throws with an
 * AxiosError that we surface in the modal so the user can retry.
 */
export default function ClockInVerifyModal({ workMode, submitClockIn, onSuccess, onClose }: ClockInVerifyModalProps) {
    const needsLocation = workMode === "office" || workMode === "hybrid";

    const [step, setStep] = useState<"location" | "face" | "submitting">(needsLocation ? "location" : "face");
    const [location, setLocation] = useState<Position | null>(null);
    const [wifi, setWifi] = useState<WifiInfo | null>(null);
    // locErr is { message, code, accuracy, source } once set — `accuracy` /
    // `source` are populated when we got a fix but it was too coarse to use,
    // so the UI can offer the "Open Windows Location Settings" remediation.
    const [locErr, setLocErr] = useState<LocErrState | null>(null);
    const [submitErr, setSubmitErr] = useState<SubmitErrState | null>(null);
    const [busy, setBusy] = useState(false);
    // Org-level office Wi-Fi config (used to decide whether the BSSID we
    // collected actually matches a registered office AP — the server is
    // authoritative, but we want to give the user accurate UI feedback
    // *before* they hit submit).
    const [orgWifi, setOrgWifi] = useState<OrgWifiState | null>(null);

    // Warm the face-api models the moment the modal opens, in parallel with
    // the Wi-Fi/location collection — by the time the user reaches the face
    // step the ~6 MB of weights are already loaded (or served from cache).
    useEffect(() => {
        preloadFaceModels();
    }, []);

    useEffect(() => {
        let cancelled = false;
        getCurrentOrg()
            .then(res => {
                if (cancelled) return;
                const data = res?.data as Record<string, unknown> | undefined;
                const rawList = data?.office_wifi_bssids;
                const list = Array.isArray(rawList) ? rawList : [];
                const set = new Set<string>(
                    list
                        .map((e: unknown) => normaliseBssid(typeof e === "string" ? e : (e as { bssid?: string })?.bssid))
                        .filter((v): v is string => Boolean(v))
                );
                setOrgWifi({
                    enabled: !!data?.office_wifi_verification_enabled,
                    bssids: set,
                });
            })
            .catch(() => { /* leave null — fall back to geofence-only UI */ });
        return () => { cancelled = true; };
    }, []);

    async function requestSignals() {
        setLocErr(null);
        setBusy(true);
        try {
            const { wifi: wifiRes, location: locRes, locError } = await getOfficeSignals();
            setWifi(wifiRes);
            setLocation(locRes);
            // If we got at least one usable signal we can move on. The server
            // will decide whether either is sufficient given the org config.
            const haveWifi = !!(wifiRes && wifiRes.ok && wifiRes.bssid);
            const haveLoc = !!locRes;
            if (haveWifi || haveLoc) {
                setStep("face");
            } else {
                // Only fail hard when both signals failed. Pass the accuracy
                // and source from the rejected fix (if any) so the message
                // can be specific — see geolocationErrorMessage().
                setLocErr({
                    message: geolocationErrorMessage(locError?.code ?? "", {
                        accuracy: locError?.accuracy,
                        source: locError?.source,
                    }),
                    code: locError?.code,
                    accuracy: locError?.accuracy,
                    source: locError?.source,
                });
            }
        } catch (e) {
            const err = e as { code?: string; accuracy?: number; source?: PositionSource };
            setLocErr({
                message: geolocationErrorMessage(err?.code ?? "", {
                    accuracy: err?.accuracy,
                    source: err?.source,
                }),
                code: err?.code,
                accuracy: err?.accuracy,
                source: err?.source,
            });
        } finally {
            setBusy(false);
        }
    }

    // Open the OS-level Location privacy settings (Windows / macOS) so the
    // user can flip Location Services on. Only exposed inside Electron.
    function openLocationSettings() {
        try {
            if (window?.electronAPI?.openLocationSettings) {
                window.electronAPI.openLocationSettings();
            }
        } catch { /* swallow — non-critical */ }
    }
    const inElectron = !!(window?.electronAPI?.openLocationSettings);

    // Auto-collect signals as soon as the modal opens for office/hybrid.
    useEffect(() => {
        if (needsLocation && step === "location" && !location && !wifi) {
            requestSignals();
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    async function handleFaceCapture(descriptor: number[] | Float32Array) {
        setStep("submitting");
        setSubmitErr(null);
        try {
            const payload: ClockInPayload = {
                work_mode: workMode,
                face_descriptor: descriptor,
                latitude: location?.latitude,
                longitude: location?.longitude,
                accuracy: location?.accuracy,
                wifi_bssid: (wifi && wifi.ok) ? wifi.bssid : undefined,
            };
            await submitClockIn(payload);
            onSuccess?.();
        } catch (e) {
            const err = e as { response?: { data?: { error?: string; code?: string } } };
            const data = err?.response?.data;
            const msg = data?.error || "Login failed. Please try again.";
            setSubmitErr({ message: msg, code: data?.code });
            setStep("face");
        }
    }

    // Did our current BSSID actually match one of the org's registered
    // office access points? The server-side check is authoritative; this is
    // just so the modal can render an accurate label ("office network
    // detected" vs "connected to Wi-Fi, but it's not an office AP").
    const currentBssid = wifi?.ok ? normaliseBssid(wifi.bssid) : null;
    const wifiMatchesOffice = !!(
        currentBssid &&
        orgWifi?.enabled &&
        orgWifi.bssids.has(currentBssid)
    );
    // "Wi-Fi verified" UI — only true when the BSSID is in the allow-list
    // (and Wi-Fi verification is enabled for the org). A bare Wi-Fi
    // connection without a matching BSSID does NOT count as office-verified.
    const wifiVerified = wifiMatchesOffice;
    const wifiConnected = !!(wifi && wifi.ok && wifi.bssid);

    return (
        <div className={s.backdrop} onClick={(e) => { if (e.target === e.currentTarget && !busy) onClose?.(); }}>
            <div className={s.modal} role="dialog" aria-modal="true">
                <div className={s.head}>
                    <h3><ShieldCheck size={18} /> Verify Login</h3>
                    <button className={s.close} onClick={onClose} disabled={busy} aria-label="Close">
                        <X size={18} />
                    </button>
                </div>

                {/* Step indicator */}
                <ol className={s.steps}>
                    {needsLocation && (
                        <li className={`${s.step} ${(step === "location") ? s.active : ((location || wifiVerified) ? s.done : "")}`}>
                            <span className={s.stepNum}>
                                {(location || wifiVerified) ? <CheckCircle2 size={14} /> : "1"}
                            </span>
                            <span className={s.stepLabel}>Location</span>
                        </li>
                    )}
                    {needsLocation && <li className={s.stepConnector} aria-hidden="true" />}
                    <li className={`${s.step} ${(step === "face" || step === "submitting") ? s.active : ""}`}>
                        <span className={s.stepNum}>
                            {needsLocation ? "2" : "1"}
                        </span>
                        <span className={s.stepLabel}>Face Match</span>
                    </li>
                </ol>

                <div className={s.body}>
                    {step === "location" && (
                        <div className={s.locBox}>
                            {locErr ? (
                                <>
                                    <div className={s.errMsg}><AlertTriangle size={16} /> {locErr.message}</div>
                                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "center" }}>
                                        <button className="btn btn-primary" onClick={requestSignals} disabled={busy}>
                                            {busy ? <><Loader2 size={14} className={s.spin} /> Requesting…</> : "Try again"}
                                        </button>
                                        {inElectron && (locErr.code === "POSITION_UNAVAILABLE" || locErr.code === "PERMISSION_DENIED" || (Number.isFinite(locErr.accuracy) && (locErr.accuracy ?? 0) > 200)) && (
                                            <button className="btn btn-secondary" onClick={openLocationSettings} disabled={busy}>
                                                Open Location Settings
                                            </button>
                                        )}
                                    </div>
                                </>
                            ) : (
                                <>
                                    <Loader2 size={28} className={s.spin} />
                                    <div>Detecting your office signals…</div>
                                </>
                            )}
                        </div>
                    )}

                    {(step === "face" || step === "submitting") && (
                        <>
                            <p className={s.helpText}>
                                Look at the camera. We'll compare this image to your enrolled face.
                            </p>
                            {needsLocation && wifiVerified && (
                                <div className={s.locDone}>
                                    <Wifi size={14} /> Connected to&nbsp;<strong>{wifi?.ssid || "office Wi-Fi"}</strong>
                                    <span className={s.acc}> — office network detected ✓</span>
                                </div>
                            )}
                            {needsLocation && !wifiVerified && wifiConnected && (
                                <div className={s.locInfo}>
                                    <WifiOff size={14} /> Connected to&nbsp;<strong>{wifi?.ssid || "Wi-Fi"}</strong>
                                    <span className={s.acc}> — not a registered office AP, using location instead</span>
                                </div>
                            )}
                            {needsLocation && location && !wifiVerified && (
                                location.accuracy > 200 ? (
                                    <div className={s.locInfo}>
                                        <MapPin size={14} /> Approximate location
                                        <span className={s.acc}> (±{Math.round(location.accuracy)} m) — may be too coarse for the office geofence. Connect to office Wi-Fi if this fails.</span>
                                    </div>
                                ) : (
                                    <div className={s.locDone}>
                                        <CheckCircle2 size={14} /> Location verified
                                        {location.accuracy && (
                                            <span className={s.acc}> (±{Math.round(location.accuracy)} m)</span>
                                        )}
                                    </div>
                                )
                            )}
                            {submitErr && (() => {
                                const { kind, title } = classifySubmitErr(submitErr.message, submitErr.code);
                                const Icon = kind === "location" ? MapPin : kind === "face" ? ScanFace : AlertTriangle;
                                return (
                                    <div className={s.errMsg} style={{ alignItems: "flex-start" }}>
                                        <Icon size={16} style={{ flexShrink: 0, marginTop: 2 }} />
                                        <span>
                                            <strong style={{ display: "block" }}>{title}</strong>
                                            {submitErr.message}
                                        </span>
                                    </div>
                                );
                            })()}
                            <FaceCapture
                                autoStart
                                // Auto-capture as soon as a face is steadily in
                                // frame — but only until the first server
                                // rejection, so a mismatch doesn't auto-retry
                                // into the face-attempt rate limit.
                                autoCapture={!submitErr}
                                captureLabel="Verify & Login"
                                capturingLabel="Verifying..."
                                onCapture={handleFaceCapture}
                                disabled={step === "submitting"}
                            />
                        </>
                    )}
                </div>

                <div className={s.foot}>
                    <button className="btn btn-secondary btn-sm" onClick={onClose} disabled={busy || step === "submitting"}>
                        Cancel
                    </button>
                </div>
            </div>
        </div>
    );
}
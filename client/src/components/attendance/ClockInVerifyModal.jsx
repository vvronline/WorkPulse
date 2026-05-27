import { useEffect, useState } from 'react';
import { ShieldCheck, Loader2, X, AlertTriangle, CheckCircle2, Wifi, WifiOff } from 'lucide-react';
import FaceCapture from './FaceCapture';
import { getOfficeSignals, geolocationErrorMessage } from '../../utils/geolocation';
import { getCurrentOrg } from '../../api';
import s from './ClockInVerifyModal.module.css';

/** Normalise any MAC-ish string to canonical AA:BB:CC:DD:EE:FF (or null). */
function normaliseBssid(raw) {
    if (typeof raw !== 'string') return null;
    const cleaned = raw.replace(/[^0-9a-fA-F]/g, '').toUpperCase();
    if (cleaned.length !== 12) return null;
    return cleaned.match(/.{2}/g).join(':');
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
 *
 * Props:
 *   - workMode:      'office' | 'remote' | 'hybrid'
 *   - submitClockIn: async (payload) => apiResponse
 *   - onSuccess:     called after a successful clock-in
 *   - onClose:       close the modal
 */
export default function ClockInVerifyModal({ workMode, submitClockIn, onSuccess, onClose }) {
    const needsLocation = workMode === 'office' || workMode === 'hybrid';

    const [step, setStep] = useState(needsLocation ? 'location' : 'face'); // 'location' | 'face' | 'submitting'
    const [location, setLocation] = useState(null);
    const [wifi, setWifi] = useState(null); // { ok, bssid, ssid, signal } or null
    const [locErr, setLocErr] = useState(null);
    const [submitErr, setSubmitErr] = useState(null);
    const [busy, setBusy] = useState(false);
    // Org-level office Wi-Fi config (used to decide whether the BSSID we
    // collected actually matches a registered office AP — the server is
    // authoritative, but we want to give the user accurate UI feedback
    // *before* they hit submit).
    const [orgWifi, setOrgWifi] = useState(null); // { enabled: bool, bssids: Set<string> }

    useEffect(() => {
        let cancelled = false;
        getCurrentOrg()
            .then(res => {
                if (cancelled) return;
                const list = Array.isArray(res?.data?.office_wifi_bssids) ? res.data.office_wifi_bssids : [];
                const set = new Set(
                    list
                        .map(e => normaliseBssid(typeof e === 'string' ? e : e?.bssid))
                        .filter(Boolean)
                );
                setOrgWifi({
                    enabled: !!res?.data?.office_wifi_verification_enabled,
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
                setStep('face');
            } else {
                // Only fail hard when both signals failed.
                setLocErr(geolocationErrorMessage(locError?.code));
            }
        } catch (err) {
            setLocErr(geolocationErrorMessage(err?.code));
        } finally {
            setBusy(false);
        }
    }

    // Auto-collect signals as soon as the modal opens for office/hybrid.
    useEffect(() => {
        if (needsLocation && step === 'location' && !location && !wifi) {
            requestSignals();
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    async function handleFaceCapture(descriptor) {
        setStep('submitting');
        setSubmitErr(null);
        try {
            const payload = {
                work_mode: workMode,
                face_descriptor: descriptor,
                latitude: location?.latitude,
                longitude: location?.longitude,
                accuracy: location?.accuracy,
                wifi_bssid: (wifi && wifi.ok) ? wifi.bssid : undefined,
            };
            await submitClockIn(payload);
            onSuccess?.();
        } catch (err) {
            const data = err?.response?.data;
            const msg = data?.error || 'Clock-in failed. Please try again.';
            setSubmitErr({ message: msg, code: data?.code });
            setStep('face');
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
                    <h3><ShieldCheck size={18} /> Verify Clock-In</h3>
                    <button className={s.close} onClick={onClose} disabled={busy} aria-label="Close">
                        <X size={18} />
                    </button>
                </div>

                {/* Step indicator */}
                <ol className={s.steps}>
                    {needsLocation && (
                        <li className={`${s.step} ${(step === 'location') ? s.active : ((location || wifiVerified) ? s.done : '')}`}>
                            <span className={s.stepNum}>
                                {(location || wifiVerified) ? <CheckCircle2 size={14} /> : '1'}
                            </span>
                            <span className={s.stepLabel}>Location</span>
                        </li>
                    )}
                    {needsLocation && <li className={s.stepConnector} aria-hidden="true" />}
                    <li className={`${s.step} ${(step === 'face' || step === 'submitting') ? s.active : ''}`}>
                        <span className={s.stepNum}>
                            {needsLocation ? '2' : '1'}
                        </span>
                        <span className={s.stepLabel}>Face Match</span>
                    </li>
                </ol>

                <div className={s.body}>
                    {step === 'location' && (
                        <div className={s.locBox}>
                            {locErr ? (
                                <>
                                    <div className={s.errMsg}><AlertTriangle size={16} /> {locErr}</div>
                                    <button className="btn btn-primary" onClick={requestSignals} disabled={busy}>
                                        {busy ? <><Loader2 size={14} className={s.spin} /> Requesting…</> : 'Try again'}
                                    </button>
                                </>
                            ) : (
                                <>
                                    <Loader2 size={28} className={s.spin} />
                                    <div>Detecting your office signals…</div>
                                </>
                            )}
                        </div>
                    )}

                    {(step === 'face' || step === 'submitting') && (
                        <>
                            <p className={s.helpText}>
                                Look at the camera. We'll compare this image to your enrolled face.
                            </p>
                            {needsLocation && wifiVerified && (
                                <div className={s.locDone}>
                                    <Wifi size={14} /> Connected to&nbsp;<strong>{wifi.ssid || 'office Wi-Fi'}</strong>
                                    <span className={s.acc}> — office network detected ✓</span>
                                </div>
                            )}
                            {needsLocation && !wifiVerified && wifiConnected && (
                                <div className={s.locInfo}>
                                    <WifiOff size={14} /> Connected to&nbsp;<strong>{wifi.ssid || 'Wi-Fi'}</strong>
                                    <span className={s.acc}> — not a registered office AP, using location instead</span>
                                </div>
                            )}
                            {needsLocation && location && !wifiVerified && (
                                <div className={s.locDone}>
                                    <CheckCircle2 size={14} /> Location verified
                                    {location.accuracy && (
                                        <span className={s.acc}> (±{Math.round(location.accuracy)} m)</span>
                                    )}
                                </div>
                            )}
                            {submitErr && (
                                <div className={s.errMsg}>
                                    <AlertTriangle size={16} /> {submitErr.message}
                                </div>
                            )}
                            <FaceCapture
                                autoStart
                                captureLabel="Verify & Clock In"
                                capturingLabel="Verifying..."
                                onCapture={handleFaceCapture}
                                disabled={step === 'submitting'}
                            />
                        </>
                    )}
                </div>

                <div className={s.foot}>
                    <button className="btn btn-secondary btn-sm" onClick={onClose} disabled={busy || step === 'submitting'}>
                        Cancel
                    </button>
                </div>
            </div>
        </div>
    );
}
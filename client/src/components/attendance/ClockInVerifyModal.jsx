import { useEffect, useState } from 'react';
import { MapPin, ShieldCheck, Loader2, X, AlertTriangle, CheckCircle2 } from 'lucide-react';
import FaceCapture from './FaceCapture';
import { getCurrentPosition, geolocationErrorMessage } from '../../utils/geolocation';
import s from './ClockInVerifyModal.module.css';

/**
 * Pre-flight verification before a `POST /tracker/clock-in` call.
 *
 * Steps:
 *   1. (office / hybrid) Get the user's geolocation via the browser.
 *   2. Open the webcam and extract a 128-float face descriptor.
 *   3. Call `submitClockIn({ work_mode, latitude, longitude, accuracy, face_descriptor })`.
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
    const [locErr, setLocErr] = useState(null);
    const [submitErr, setSubmitErr] = useState(null);
    const [busy, setBusy] = useState(false);

    async function requestLocation() {
        setLocErr(null);
        setBusy(true);
        try {
            const pos = await getCurrentPosition();
            setLocation(pos);
            setStep('face');
        } catch (err) {
            setLocErr(geolocationErrorMessage(err?.code));
        } finally {
            setBusy(false);
        }
    }

    // Auto-request location as soon as the modal opens for office/hybrid.
    useEffect(() => {
        if (needsLocation && step === 'location' && !location) {
            requestLocation();
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
                        <li className={`${s.step} ${(step === 'location') ? s.active : (location ? s.done : '')}`}>
                            <span className={s.stepIcon}>{location ? <CheckCircle2 size={14} /> : <MapPin size={14} />}</span>
                            Location
                        </li>
                    )}
                    <li className={`${s.step} ${(step === 'face' || step === 'submitting') ? s.active : ''}`}>
                        <span className={s.stepIcon}><ShieldCheck size={14} /></span>
                        Face Match
                    </li>
                </ol>

                <div className={s.body}>
                    {step === 'location' && (
                        <div className={s.locBox}>
                            {locErr ? (
                                <>
                                    <div className={s.errMsg}><AlertTriangle size={16} /> {locErr}</div>
                                    <button className="btn btn-primary" onClick={requestLocation} disabled={busy}>
                                        {busy ? <><Loader2 size={14} className={s.spin} /> Requesting…</> : 'Try again'}
                                    </button>
                                </>
                            ) : (
                                <>
                                    <Loader2 size={28} className={s.spin} />
                                    <div>Detecting your location…</div>
                                </>
                            )}
                        </div>
                    )}

                    {(step === 'face' || step === 'submitting') && (
                        <>
                            <p className={s.helpText}>
                                Look at the camera. We'll compare this image to your enrolled face.
                            </p>
                            {location && needsLocation && (
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
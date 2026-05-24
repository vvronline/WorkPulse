import { useEffect, useRef, useState } from 'react';
import { MapContainer, TileLayer, Marker, Circle, useMap, useMapEvents } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { MapPin, Crosshair, ShieldCheck, ShieldOff, Save, Loader2 } from 'lucide-react';
import { updateOrgSettings } from '../../api';
import { getCurrentPosition, geolocationErrorMessage } from '../../utils/geolocation';
import s from './OfficeLocationSettings.module.css';

// Leaflet's default marker icon URLs are broken when bundled by Vite/Webpack,
// so we point them at the CDN copy that ships with the npm package.
const defaultIcon = new L.Icon({
    iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
    iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
    shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
    iconSize: [25, 41],
    iconAnchor: [12, 41],
    popupAnchor: [1, -34],
    shadowSize: [41, 41],
});

function ClickHandler({ onPick }) {
    useMapEvents({
        click(e) {
            onPick(e.latlng.lat, e.latlng.lng);
        },
    });
    return null;
}

function Recenter({ lat, lng }) {
    const map = useMap();
    useEffect(() => {
        if (Number.isFinite(lat) && Number.isFinite(lng)) {
            map.setView([lat, lng], map.getZoom());
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [lat, lng]);
    return null;
}

/**
 * Force Leaflet to recompute its container size. When the map mounts
 * inside a flex/grid layout (or behind a scroll-anchored section) the
 * container can briefly have 0x0 dimensions, leaving tiles blank until
 * the user pans. We re-invalidate on mount + on every parent resize so
 * the tiles always render even after layout shifts.
 */
function ResizeFixer() {
    const map = useMap();
    useEffect(() => {
        // Run a few times in the first second to catch slow layouts
        // (collapsed accordions, lazy-mounted sections, etc.).
        const timers = [50, 200, 600, 1200].map(ms =>
            setTimeout(() => { try { map.invalidateSize(); } catch { } }, ms)
        );

        const ro = new ResizeObserver(() => {
            try { map.invalidateSize(); } catch { }
        });
        const container = map.getContainer();
        if (container) ro.observe(container);

        return () => {
            timers.forEach(clearTimeout);
            ro.disconnect();
        };
    }, [map]);
    return null;
}

/**
 * Tenant office location + attendance-verification toggle.
 *
 * Lets an HR admin / super admin:
 *   - Pick the office location by clicking on the map or pasting coords.
 *   - Set a geofence radius (10..10000 m).
 *   - Type a human-readable office address.
 *   - Flip the "Require face + location for clock-in" master switch.
 *
 * Persists everything through PUT /org/settings.
 */
export default function OfficeLocationSettings({ org, onUpdate }) {
    const initialLat = Number.isFinite(Number(org?.office_latitude)) ? Number(org.office_latitude) : null;
    const initialLng = Number.isFinite(Number(org?.office_longitude)) ? Number(org.office_longitude) : null;

    const [lat, setLat] = useState(initialLat);
    const [lng, setLng] = useState(initialLng);
    const [radius, setRadius] = useState(Number(org?.office_radius_m) || 150);
    const [address, setAddress] = useState(org?.office_address || '');
    const [verifyOn, setVerifyOn] = useState(!!org?.attendance_verification_enabled);
    const [busy, setBusy] = useState(false);
    const [toast, setToast] = useState(null);
    const [gpsErr, setGpsErr] = useState(null);

    // Fall back to a sensible default centre (Mumbai) when nothing is set yet.
    const centre = lat != null && lng != null ? [lat, lng] : [19.0760, 72.8777];
    const hasLocation = lat != null && lng != null;

    async function handleUseMyLocation() {
        setGpsErr(null);
        try {
            const pos = await getCurrentPosition();
            setLat(Number(pos.latitude.toFixed(6)));
            setLng(Number(pos.longitude.toFixed(6)));
        } catch (err) {
            setGpsErr(geolocationErrorMessage(err?.code));
        }
    }

    async function handleSave() {
        setBusy(true);
        setToast(null);
        try {
            const payload = {
                office_latitude: lat == null ? null : lat,
                office_longitude: lng == null ? null : lng,
                office_radius_m: Number(radius) || 150,
                office_address: address.trim() === '' ? null : address.trim(),
                attendance_verification_enabled: !!verifyOn,
            };
            await updateOrgSettings(payload);
            setToast({ kind: 'ok', text: 'Attendance settings saved.' });
            onUpdate?.();
        } catch (err) {
            setToast({ kind: 'err', text: err?.response?.data?.error || 'Failed to save settings.' });
        } finally {
            setBusy(false);
        }
    }

    return (
        <div className={s.wrap}>
            <div className={s.header}>
                <h3>
                    {verifyOn ? <ShieldCheck size={18} className={s.iconOn} /> : <ShieldOff size={18} className={s.iconOff} />}
                    Attendance Verification (Face + Location)
                </h3>
                <p className={s.lede}>
                    When enabled, employees clocking in from <strong>office</strong> must be within the geofence
                    AND pass a face check. <strong>Remote</strong> clock-ins still require a face check.
                    Each employee must enroll their face from <strong>Profile → Face Enrollment</strong>.
                </p>
            </div>

            {toast && <div className={`${s.toast} ${s[toast.kind]}`}>{toast.text}</div>}

            <div className={s.row}>
                <label className={s.toggle}>
                    <input
                        type="checkbox"
                        checked={verifyOn}
                        onChange={e => setVerifyOn(e.target.checked)}
                    />
                    <span>Require face + location for clock-in</span>
                </label>
            </div>

            <div className={s.fieldGrid}>
                <div className={s.field}>
                    <label>Office Address (optional)</label>
                    <input
                        type="text"
                        placeholder="e.g. 5th Floor, Tech Park, Pune"
                        value={address}
                        onChange={e => setAddress(e.target.value)}
                        maxLength={500}
                    />
                </div>
                <div className={s.field}>
                    <label>Latitude</label>
                    <input
                        type="number"
                        step="0.000001"
                        min="-90"
                        max="90"
                        placeholder="e.g. 19.076000"
                        value={lat ?? ''}
                        onChange={e => {
                            const v = e.target.value;
                            setLat(v === '' ? null : Number(v));
                        }}
                    />
                </div>
                <div className={s.field}>
                    <label>Longitude</label>
                    <input
                        type="number"
                        step="0.000001"
                        min="-180"
                        max="180"
                        placeholder="e.g. 72.877700"
                        value={lng ?? ''}
                        onChange={e => {
                            const v = e.target.value;
                            setLng(v === '' ? null : Number(v));
                        }}
                    />
                </div>
                <div className={s.field}>
                    <label>Geofence Radius (metres)</label>
                    <input
                        type="number"
                        min="10"
                        max="10000"
                        step="10"
                        value={radius}
                        onChange={e => setRadius(e.target.value)}
                    />
                    <small className={s.hint}>Allowed: 10–10000 m. Smaller is stricter.</small>
                </div>
            </div>

            <div className={s.row}>
                <button type="button" className="btn btn-secondary btn-sm" onClick={handleUseMyLocation}>
                    <Crosshair size={14} /> Use my current location
                </button>
                {gpsErr && <span className={s.gpsErr}>{gpsErr}</span>}
                <span className={s.mapHint}><MapPin size={14} /> Click the map to set the office location</span>
            </div>

            <div className={s.mapBox}>
                <MapContainer
                    center={centre}
                    zoom={hasLocation ? 16 : 12}
                    scrollWheelZoom
                    style={{ height: '360px', width: '100%' }}
                    className={s.map}
                >
                    <TileLayer
                        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
                        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                    />
                    <ResizeFixer />
                    <ClickHandler onPick={(la, lo) => { setLat(Number(la.toFixed(6))); setLng(Number(lo.toFixed(6))); }} />
                    {hasLocation && <Recenter lat={lat} lng={lng} />}
                    {hasLocation && (
                        <>
                            <Marker position={[lat, lng]} icon={defaultIcon} />
                            <Circle
                                center={[lat, lng]}
                                radius={Number(radius) || 150}
                                pathOptions={{ color: '#2383e2', fillColor: '#2383e2', fillOpacity: 0.12 }}
                            />
                        </>
                    )}
                </MapContainer>
            </div>

            <div className={s.row}>
                <button type="button" className="btn btn-primary" onClick={handleSave} disabled={busy}>
                    {busy ? <><Loader2 size={14} className={s.spin} /> Saving…</> : <><Save size={14} /> Save Attendance Settings</>}
                </button>
            </div>
        </div>
    );
}
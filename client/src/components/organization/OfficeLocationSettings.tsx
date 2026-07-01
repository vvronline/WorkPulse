import { useEffect, useRef, useState } from "react";
import { MapContainer, TileLayer, Marker, Circle, useMap, useMapEvents } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import {
    MapPin,
    Crosshair,
    ShieldCheck,
    ShieldOff,
    Save,
    Loader2,
    Search,
    X,
    Wifi,
    Plus,
    Trash2,
} from "lucide-react";
import { updateOrgSettings } from "../../api";
import {
    getCurrentPosition,
    geolocationErrorMessage,
    getWifiInfo,
    reverseGeocode,
} from "../../utils/geolocation";
import s from "./OfficeLocationSettings.module.css";

// Leaflet's default marker icon URLs are broken when bundled by Vite/Webpack,
// so we point them at the CDN copy that ships with the npm package.
const defaultIcon = new L.Icon({
    iconUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png",
    iconRetinaUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png",
    shadowUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
    iconSize: [25, 41],
    iconAnchor: [12, 41],
    popupAnchor: [1, -34],
    shadowSize: [41, 41],
});

interface WifiAp {
    bssid: string;
    label?: string;
    ssid?: string | null;
    added_by?: string;
    added_at?: string;
    [key: string]: unknown;
}

interface OrgData {
    office_latitude?: number | string | null;
    office_longitude?: number | string | null;
    office_radius_m?: number | string;
    office_address?: string;
    attendance_verification_enabled?: boolean;
    office_wifi_bssids?: WifiAp[];
    office_wifi_verification_enabled?: boolean;
    updated_at?: string;
    [key: string]: unknown;
}

interface SearchResult {
    place_id: number | string;
    lat: string;
    lon: string;
    display_name?: string;
    [key: string]: unknown;
}

function ClickHandler({ onPick }: { onPick: (lat: number, lng: number) => void }) {
    useMapEvents({
        click(e) {
            onPick(e.latlng.lat, e.latlng.lng);
        },
    });
    return null;
}

function Recenter({ lat, lng }: { lat: number; lng: number }) {
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
        const timers = [50, 200, 600, 1200].map((ms) =>
            setTimeout(() => {
                try {
                    map.invalidateSize();
                } catch {
                    /* ignore */
                }
            }, ms)
        );

        const ro = new ResizeObserver(() => {
            try {
                map.invalidateSize();
            } catch {
                /* ignore */
            }
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

interface OfficeLocationSettingsProps {
    org?: OrgData;
    onUpdate?: () => void;
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
export default function OfficeLocationSettings({ org, onUpdate }: OfficeLocationSettingsProps) {
    const initialLat = Number.isFinite(Number(org?.office_latitude))
        ? Number(org!.office_latitude)
        : null;
    const initialLng = Number.isFinite(Number(org?.office_longitude))
        ? Number(org!.office_longitude)
        : null;

    const [lat, setLat] = useState<number | null>(initialLat);
    const [lng, setLng] = useState<number | null>(initialLng);
    const [radius, setRadius] = useState<number | string>(Number(org?.office_radius_m) || 150);
    const [address, setAddress] = useState(org?.office_address || "");
    const [verifyOn, setVerifyOn] = useState(!!org?.attendance_verification_enabled);
    const [busy, setBusy] = useState(false);
    const [toast, setToast] = useState<{ kind: string; text: string } | null>(null);
    const [gpsErr, setGpsErr] = useState<string | null>(null);
    // "Use my current location" progress + a short-lived success note so the
    // admin sees the fix accuracy after the button resolves.
    const [locating, setLocating] = useState(false);
    const [locNote, setLocNote] = useState<string | null>(null);
    // Abort any in-flight reverse-geocode when a newer pick supersedes it, so
    // an older (slower) lookup can't clobber the address of a newer location.
    const reverseAbortRef = useRef<AbortController | null>(null);

    // Office Wi-Fi BSSID allow-list (Stage 7: Wi-Fi-first attendance).
    // Each entry: { bssid, label, ssid?, added_by?, added_at? }
    const [wifiBssids, setWifiBssids] = useState<WifiAp[]>(
        Array.isArray(org?.office_wifi_bssids) ? org!.office_wifi_bssids : []
    );
    const [wifiVerifyOn, setWifiVerifyOn] = useState(!!org?.office_wifi_verification_enabled);

    // Re-sync from props whenever the parent reloads the org (post-save
    // refetch in OrgSettingsPage). Without this, a successful save would
    // appear to "clear" the list because the component would keep its old
    // (or initial) local state even though the server now has the new data.
    // We track the org's updated_at as a fingerprint — only resync when the
    // server row actually changed, so we don't clobber in-progress edits.
    const lastSyncedAtRef = useRef<string | null>(null);
    useEffect(() => {
        const stamp = org?.updated_at || null;
        if (!org) return;
        if (lastSyncedAtRef.current === stamp) return;
        lastSyncedAtRef.current = stamp;
        if (Array.isArray(org.office_wifi_bssids)) {
            setWifiBssids(org.office_wifi_bssids);
        }
        setWifiVerifyOn(!!org.office_wifi_verification_enabled);
    }, [org]);
    const [wifiAddBusy, setWifiAddBusy] = useState(false);
    const [wifiAddErr, setWifiAddErr] = useState<string | null>(null);
    const [currentWifi, setCurrentWifi] = useState<any>(null); // { ok, bssid, ssid, signal }
    // Inline manual-BSSID add form (replaces window.prompt which is blocked in Electron).
    const [manualOpen, setManualOpen] = useState(false);
    const [manualBssid, setManualBssid] = useState("");
    const [manualLabel, setManualLabel] = useState("");
    // Inline label editor for an existing row.
    const [editingBssid, setEditingBssid] = useState<string | null>(null);
    const [editingLabel, setEditingLabel] = useState("");

    // Probe the desktop's current Wi-Fi info once on mount so the admin can
    // see (and one-click add) the AP they're connected to right now.
    useEffect(() => {
        let cancelled = false;
        (async () => {
            const info = await getWifiInfo();
            if (!cancelled) setCurrentWifi(info);
        })();
        return () => {
            cancelled = true;
        };
    }, []);

    async function handleAddCurrentWifi() {
        setWifiAddErr(null);
        setWifiAddBusy(true);
        try {
            const info = await getWifiInfo();
            setCurrentWifi(info);
            if (!info?.ok || !info.bssid) {
                setWifiAddErr(
                    info?.error === "unavailable"
                        ? "Wi-Fi BSSID lookup is only available in the Loops desktop app. Open the desktop app from the office network to register an AP."
                        : info?.error === "wifi_disconnected"
                          ? "You're not connected to any Wi-Fi network. Connect to the office Wi-Fi first."
                          : "Could not read the current Wi-Fi BSSID. Make sure Windows Location Services is on."
                );
                return;
            }
            const mac = info.bssid.toUpperCase();
            if (wifiBssids.some((b) => (b.bssid || "").toUpperCase() === mac)) {
                setWifiAddErr("This access point is already registered.");
                return;
            }
            const defaultLabel = info.ssid
                ? `${info.ssid} (${mac.slice(-5)})`
                : `Office AP (${mac.slice(-5)})`;
            setWifiBssids((prev) => [
                ...prev,
                {
                    bssid: mac,
                    label: defaultLabel.slice(0, 100),
                    ssid: info.ssid || null,
                    added_at: new Date().toISOString(),
                },
            ]);
            // Open inline editor so the admin can immediately rename it.
            setEditingBssid(mac);
            setEditingLabel(defaultLabel);
        } catch (err: any) {
            setWifiAddErr(err?.message || "Failed to read Wi-Fi info.");
        } finally {
            setWifiAddBusy(false);
        }
    }

    function handleSubmitManualBssid() {
        setWifiAddErr(null);
        const cleaned = manualBssid.replace(/[^0-9a-fA-F]/g, "").toUpperCase();
        if (cleaned.length !== 12) {
            setWifiAddErr("Invalid MAC. Expected 12 hex digits (e.g. AA:BB:CC:DD:EE:FF).");
            return;
        }
        const mac = cleaned.match(/.{2}/g)!.join(":");
        if (wifiBssids.some((b) => (b.bssid || "").toUpperCase() === mac)) {
            setWifiAddErr("This access point is already registered.");
            return;
        }
        const label = (manualLabel.trim() || `Office AP (${mac.slice(-5)})`).slice(0, 100);
        setWifiBssids((prev) => [
            ...prev,
            {
                bssid: mac,
                label,
                added_at: new Date().toISOString(),
            },
        ]);
        setManualBssid("");
        setManualLabel("");
        setManualOpen(false);
    }

    function handleRemoveBssid(mac: string) {
        setWifiBssids((prev) =>
            prev.filter((b) => (b.bssid || "").toUpperCase() !== mac.toUpperCase())
        );
        if (editingBssid && editingBssid.toUpperCase() === mac.toUpperCase()) {
            setEditingBssid(null);
        }
    }

    function startEditLabel(ap: WifiAp) {
        setEditingBssid(ap.bssid);
        setEditingLabel(ap.label || "");
    }

    function commitEditLabel() {
        const trimmed = (editingLabel || "").trim().slice(0, 100);
        setWifiBssids((prev) =>
            prev.map((b) =>
                (b.bssid || "").toUpperCase() === (editingBssid || "").toUpperCase()
                    ? { ...b, label: trimmed || b.label || "Office AP" }
                    : b
            )
        );
        setEditingBssid(null);
    }

    // Place search (OpenStreetMap Nominatim — free, no API key required).
    const [searchQuery, setSearchQuery] = useState("");
    const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
    const [searching, setSearching] = useState(false);
    const [searchOpen, setSearchOpen] = useState(false);
    const [searchErr, setSearchErr] = useState<string | null>(null);
    // Index of the keyboard-highlighted result (-1 = none). Enables ↑/↓/Enter
    // navigation of the results dropdown.
    const [activeIndex, setActiveIndex] = useState(-1);
    const searchAbortRef = useRef<AbortController | null>(null);
    const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const searchBoxRef = useRef<HTMLDivElement | null>(null);
    const searchListRef = useRef<HTMLUListElement | null>(null);

    // Debounced Nominatim lookup. Polite usage: small delay + abort on retype.
    useEffect(() => {
        if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
        const q = searchQuery.trim();
        if (q.length < 3) {
            setSearchResults([]);
            setSearching(false);
            setSearchErr(null);
            return;
        }
        searchDebounceRef.current = setTimeout(async () => {
            try {
                if (searchAbortRef.current) searchAbortRef.current.abort();
                const ac = new AbortController();
                searchAbortRef.current = ac;
                setSearching(true);
                setSearchErr(null);
                const url = `https://nominatim.openstreetmap.org/search?format=json&addressdetails=1&limit=6&q=${encodeURIComponent(
                    q
                )}`;
                const res = await fetch(url, {
                    signal: ac.signal,
                    headers: { Accept: "application/json" },
                });
                if (!res.ok) throw new Error("search_failed");
                const data = await res.json();
                setSearchResults(Array.isArray(data) ? data : []);
                setActiveIndex(-1);
                setSearchOpen(true);
            } catch (err: any) {
                if (err.name !== "AbortError") {
                    setSearchResults([]);
                    setSearchErr("Search failed. Please try again.");
                }
            } finally {
                setSearching(false);
            }
        }, 400);
        return () => {
            if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
        };
    }, [searchQuery]);

    // Close the results dropdown when clicking outside the search box.
    useEffect(() => {
        function onDocClick(e: MouseEvent) {
            if (searchBoxRef.current && !searchBoxRef.current.contains(e.target as Node)) {
                setSearchOpen(false);
            }
        }
        document.addEventListener("mousedown", onDocClick);
        return () => document.removeEventListener("mousedown", onDocClick);
    }, []);

    function pickSearchResult(r: SearchResult) {
        const la = Number(r.lat);
        const lo = Number(r.lon);
        if (!Number.isFinite(la) || !Number.isFinite(lo)) return;
        const roundedLat = Number(la.toFixed(6));
        const roundedLng = Number(lo.toFixed(6));
        setLat(roundedLat);
        setLng(roundedLng);
        if (r.display_name) setAddress(r.display_name);
        setSearchQuery(r.display_name || searchQuery);
        setSearchOpen(false);
        setActiveIndex(-1);
    }

    // Keyboard navigation for the results dropdown: ↑/↓ move the highlight,
    // Enter selects the highlighted (or first) result, Escape closes it.
    function handleSearchKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
        if (!searchOpen || searchResults.length === 0) {
            if (e.key === "Escape") setSearchOpen(false);
            return;
        }
        if (e.key === "ArrowDown") {
            e.preventDefault();
            setActiveIndex((i) => (i + 1) % searchResults.length);
        } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActiveIndex((i) => (i <= 0 ? searchResults.length - 1 : i - 1));
        } else if (e.key === "Enter") {
            e.preventDefault();
            const idx = activeIndex >= 0 ? activeIndex : 0;
            const chosen = searchResults[idx];
            if (chosen) pickSearchResult(chosen);
        } else if (e.key === "Escape") {
            e.preventDefault();
            setSearchOpen(false);
            setActiveIndex(-1);
        }
    }

    function clearSearch() {
        setSearchQuery("");
        setSearchResults([]);
        setSearchOpen(false);
        setSearchErr(null);
        setActiveIndex(-1);
    }

    /**
     * Apply a freshly-picked location (from "use my location" or a map click):
     * store the rounded coords, then reverse-geocode to fill the exact office
     * address + search box so the pin and the human-readable address stay in
     * sync however the location was chosen. Aborts any older lookup so a slow
     * response can't overwrite a newer pick.
     */
    async function applyPickedLocation(rawLat: number, rawLng: number) {
        const roundedLat = Number(rawLat.toFixed(6));
        const roundedLng = Number(rawLng.toFixed(6));
        setLat(roundedLat);
        setLng(roundedLng);

        if (reverseAbortRef.current) reverseAbortRef.current.abort();
        const ac = new AbortController();
        reverseAbortRef.current = ac;
        const resolved = await reverseGeocode(roundedLat, roundedLng, {
            signal: ac.signal,
        });
        if (ac.signal.aborted) return;
        if (resolved) {
            setAddress(resolved);
            setSearchQuery(resolved);
        }
    }

    // Fall back to a sensible default centre (Mumbai) when nothing is set yet.
    const centre: [number, number] = lat != null && lng != null ? [lat, lng] : [19.076, 72.8777];
    const hasLocation = lat != null && lng != null;

    async function handleUseMyLocation() {
        setGpsErr(null);
        setLocNote(null);
        setLocating(true);
        try {
            const pos = await getCurrentPosition();
            await applyPickedLocation(pos.latitude, pos.longitude);
            setLocNote(
                `Location set (±${Math.round(pos.accuracy)} m). Address filled from the pin — adjust if needed.`
            );
        } catch (err: any) {
            setGpsErr(
                geolocationErrorMessage(err?.code, {
                    accuracy: err?.accuracy,
                    source: err?.source,
                })
            );
        } finally {
            setLocating(false);
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
                office_address: address.trim() === "" ? null : address.trim(),
                attendance_verification_enabled: !!verifyOn,
                office_wifi_bssids: wifiBssids,
                office_wifi_verification_enabled: !!wifiVerifyOn,
            };
            const res = await updateOrgSettings(payload);
            // The server returns the saved row — adopt it locally so the UI
            // reflects exactly what was persisted (including any normalisation
            // the server did on BSSIDs, label trimming, etc.). This also
            // guards against a stale parent refetch clobbering the list.
            const saved = res?.data;
            if (saved && Array.isArray(saved.office_wifi_bssids)) {
                setWifiBssids(saved.office_wifi_bssids);
                lastSyncedAtRef.current = saved.updated_at || lastSyncedAtRef.current;
            }
            if (saved && typeof saved.office_wifi_verification_enabled === "boolean") {
                setWifiVerifyOn(saved.office_wifi_verification_enabled);
            }
            setToast({ kind: "ok", text: "Attendance settings saved." });
            onUpdate?.();
        } catch (err: any) {
            setToast({
                kind: "err",
                text: err?.response?.data?.error || "Failed to save settings.",
            });
        } finally {
            setBusy(false);
        }
    }

    return (
        <div className={s.wrap}>
            <div className={s.header}>
                <h3>
                    {verifyOn ? (
                        <ShieldCheck size={18} className={s.iconOn} />
                    ) : (
                        <ShieldOff size={18} className={s.iconOff} />
                    )}
                    Attendance Verification (Face + Location)
                </h3>
                <p className={s.lede}>
                    When enabled, employees clocking in from <strong>office</strong> must be within
                    the geofence AND pass a face check. <strong>Remote</strong> clock-ins still
                    require a face check. Each employee must enroll their face from{" "}
                    <strong>Profile → Face Enrollment</strong>.
                </p>
            </div>

            {toast && <div className={`${s.toast} ${s[toast.kind]}`}>{toast.text}</div>}

            <div className={s.row}>
                <label className={s.toggle}>
                    <input
                        type="checkbox"
                        checked={verifyOn}
                        onChange={(e) => setVerifyOn(e.target.checked)}
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
                        onChange={(e) => setAddress(e.target.value)}
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
                        value={lat ?? ""}
                        onChange={(e) => {
                            const v = e.target.value;
                            setLat(v === "" ? null : Number(v));
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
                        value={lng ?? ""}
                        onChange={(e) => {
                            const v = e.target.value;
                            setLng(v === "" ? null : Number(v));
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
                        onChange={(e) => setRadius(e.target.value)}
                    />
                    <small className={s.hint}>Allowed: 10–10000 m. Smaller is stricter.</small>
                </div>
            </div>

            {/* ─── Office Wi-Fi allow-list (recommended) ────────────────── */}
            <div className={s.wifiSection}>
                <div className={s.wifiHeader}>
                    <h4>
                        <Wifi size={16} /> Office Wi-Fi (recommended)
                    </h4>
                    <label className={s.toggle}>
                        <input
                            type="checkbox"
                            checked={wifiVerifyOn}
                            onChange={(e) => setWifiVerifyOn(e.target.checked)}
                        />
                        <span>Trust office Wi-Fi for clock-in</span>
                    </label>
                </div>
                <p className={s.wifiHint}>
                    When an employee is connected to one of these access points, they're treated as{" "}
                    <strong>at the office</strong> regardless of GPS accuracy. The geofence below acts
                    as a fallback for browsers, ethernet, and mobile network clock-ins.
                </p>

                {wifiBssids.length === 0 && (
                    <div className={s.wifiEmpty}>
                        No office access points registered yet. Add one from the desktop app while
                        connected to the office Wi-Fi.
                    </div>
                )}

                {wifiBssids.length > 0 && (
                    <ul className={s.wifiList}>
                        {wifiBssids.map((ap) => {
                            const isEditing =
                                editingBssid &&
                                editingBssid.toUpperCase() === (ap.bssid || "").toUpperCase();
                            return (
                                <li key={ap.bssid} className={s.wifiItem}>
                                    <div className={s.wifiItemMain}>
                                        <Wifi size={14} className={s.wifiItemIcon} />
                                        <div className={s.wifiItemText}>
                                            {isEditing ? (
                                                <input
                                                    type="text"
                                                    className={s.wifiInlineInput}
                                                    value={editingLabel}
                                                    onChange={(e) => setEditingLabel(e.target.value)}
                                                    onBlur={commitEditLabel}
                                                    onKeyDown={(e) => {
                                                        if (e.key === "Enter") commitEditLabel();
                                                        if (e.key === "Escape") setEditingBssid(null);
                                                    }}
                                                    maxLength={100}
                                                    autoFocus
                                                />
                                            ) : (
                                                <div
                                                    className={s.wifiItemLabel}
                                                    onClick={() => startEditLabel(ap)}
                                                    title="Click to rename"
                                                >
                                                    {ap.label || "Office AP"}
                                                </div>
                                            )}
                                            <div className={s.wifiItemMeta}>
                                                <code>{ap.bssid}</code>
                                                {ap.ssid && (
                                                    <span className={s.wifiItemSsid}>
                                                        SSID: {ap.ssid}
                                                    </span>
                                                )}
                                            </div>
                                        </div>
                                    </div>
                                    <button
                                        type="button"
                                        className={s.wifiRemove}
                                        onClick={() => handleRemoveBssid(ap.bssid)}
                                        aria-label={`Remove ${ap.label || ap.bssid}`}
                                    >
                                        <Trash2 size={14} />
                                    </button>
                                </li>
                            );
                        })}
                    </ul>
                )}

                {manualOpen && (
                    <div className={s.wifiManualForm}>
                        <div className={s.wifiManualRow}>
                            <input
                                type="text"
                                placeholder="BSSID (AA:BB:CC:DD:EE:FF)"
                                value={manualBssid}
                                onChange={(e) => setManualBssid(e.target.value)}
                                className={s.wifiManualInput}
                                autoFocus
                            />
                            <input
                                type="text"
                                placeholder="Label (e.g. Floor 5 AP)"
                                value={manualLabel}
                                onChange={(e) => setManualLabel(e.target.value)}
                                className={s.wifiManualInput}
                                maxLength={100}
                                onKeyDown={(e) => {
                                    if (e.key === "Enter") handleSubmitManualBssid();
                                }}
                            />
                        </div>
                        <div className={s.wifiManualActions}>
                            <button
                                type="button"
                                className="btn btn-primary btn-sm"
                                onClick={handleSubmitManualBssid}
                            >
                                Add
                            </button>
                            <button
                                type="button"
                                className="btn btn-secondary btn-sm"
                                onClick={() => {
                                    setManualOpen(false);
                                    setManualBssid("");
                                    setManualLabel("");
                                    setWifiAddErr(null);
                                }}
                            >
                                Cancel
                            </button>
                        </div>
                    </div>
                )}

                <div className={s.wifiActions}>
                    <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        onClick={handleAddCurrentWifi}
                        disabled={wifiAddBusy}
                    >
                        {wifiAddBusy ? (
                            <>
                                <Loader2 size={14} className={s.spin} /> Reading…
                            </>
                        ) : (
                            <>
                                <Plus size={14} /> Add this network's Wi-Fi
                            </>
                        )}
                    </button>
                    <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        onClick={() => {
                            setManualOpen((o) => !o);
                            setWifiAddErr(null);
                        }}
                    >
                        <Plus size={14} /> {manualOpen ? "Hide manual entry" : "Enter BSSID manually"}
                    </button>
                    {currentWifi?.ok && currentWifi.bssid && (
                        <span className={s.wifiCurrent}>
                            Currently connected to <strong>{currentWifi.ssid || "Wi-Fi"}</strong>
                            {currentWifi.signal != null && <> ({currentWifi.signal}% signal)</>}
                        </span>
                    )}
                </div>
                {wifiAddErr && <div className={s.wifiErr}>{wifiAddErr}</div>}
            </div>

            <div className={s.searchRow} ref={searchBoxRef}>
                <div className={s.searchInputWrap}>
                    <Search size={14} className={s.searchIcon} />
                    <input
                        type="text"
                        className={s.searchInput}
                        placeholder="Search for a place or address (e.g. Tech Park Pune)"
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        onKeyDown={handleSearchKeyDown}
                        onFocus={() => {
                            if (searchResults.length > 0) setSearchOpen(true);
                        }}
                        role="combobox"
                        aria-expanded={searchOpen}
                        aria-controls="office-search-results"
                        aria-autocomplete="list"
                        aria-activedescendant={
                            activeIndex >= 0 ? `office-search-opt-${activeIndex}` : undefined
                        }
                    />
                    {searching && <Loader2 size={14} className={`${s.searchSpin} ${s.spin}`} />}
                    {!!searchQuery && !searching && (
                        <button
                            type="button"
                            className={s.searchClear}
                            onClick={clearSearch}
                            aria-label="Clear search"
                        >
                            <X size={14} />
                        </button>
                    )}
                    {searchOpen && (searchResults.length > 0 || searchErr) && (
                        <ul
                            className={s.searchDropdown}
                            ref={searchListRef}
                            id="office-search-results"
                            role="listbox"
                        >
                            {searchErr && <li className={s.searchError}>{searchErr}</li>}
                            {searchResults.map((r, idx) => (
                                <li
                                    key={r.place_id}
                                    id={`office-search-opt-${idx}`}
                                    role="option"
                                    aria-selected={idx === activeIndex}
                                    className={`${s.searchItem} ${idx === activeIndex ? s.searchItemActive : ""}`}
                                    onMouseEnter={() => setActiveIndex(idx)}
                                    onClick={() => pickSearchResult(r)}
                                >
                                    <MapPin size={12} className={s.searchItemIcon} />
                                    <span className={s.searchItemText}>{r.display_name}</span>
                                </li>
                            ))}
                            {!searchErr && searchResults.length === 0 && !searching && (
                                <li className={s.searchEmpty}>No matches found</li>
                            )}
                        </ul>
                    )}
                </div>
            </div>

            <div className={s.row}>
                <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={handleUseMyLocation}
                    disabled={locating}
                >
                    {locating ? (
                        <>
                            <Loader2 size={14} className={s.spin} /> Locating…
                        </>
                    ) : (
                        <>
                            <Crosshair size={14} /> Use my current location
                        </>
                    )}
                </button>
                {gpsErr && <span className={s.gpsErr}>{gpsErr}</span>}
                {!gpsErr && locNote && <span className={s.locNote}>{locNote}</span>}
                <span className={s.mapHint}>
                    <MapPin size={14} /> Click the map to set the office location
                </span>
            </div>

            <div className={s.mapBox}>
                <MapContainer
                    center={centre}
                    zoom={hasLocation ? 16 : 12}
                    scrollWheelZoom
                    style={{ height: "360px", width: "100%" }}
                    className={s.map}
                >
                    <TileLayer
                        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
                        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                    />
                    <ResizeFixer />
                    <ClickHandler
                        onPick={(la, lo) => {
                            setGpsErr(null);
                            setLocNote(null);
                            void applyPickedLocation(la, lo);
                        }}
                    />
                    {hasLocation && <Recenter lat={lat!} lng={lng!} />}
                    {hasLocation && (
                        <>
                            <Marker position={[lat!, lng!]} icon={defaultIcon} />
                            <Circle
                                center={[lat!, lng!]}
                                radius={Number(radius) || 150}
                                pathOptions={{
                                    color: "#2383e2",
                                    fillColor: "#2383e2",
                                    fillOpacity: 0.12,
                                }}
                            />
                        </>
                    )}
                </MapContainer>
            </div>

            <div className={s.row}>
                <button
                    type="button"
                    className="btn btn-primary"
                    onClick={handleSave}
                    disabled={busy}
                >
                    {busy ? (
                        <>
                            <Loader2 size={14} className={s.spin} /> Saving…
                        </>
                    ) : (
                        <>
                            <Save size={14} /> Save Attendance Settings
                        </>
                    )}
                </button>
            </div>
        </div>
    );
}
/**
 * Promise-based wrapper around navigator.geolocation, plus an Electron
 * fallback used by the attendance clock-in flow.
 *
 * Why the fallback exists:
 *   In the WorkPulse desktop app (Electron), navigator.geolocation is
 *   routed through Chromium's network-based geolocation, which calls
 *   Google's Geolocation API and *requires* a Google API key. Packaged
 *   builds don't ship one (it would be a public secret), so every call
 *   fails with POSITION_UNAVAILABLE and the user sees
 *     "Couldn't determine your location. Check your GPS / Wi-Fi …"
 *   even though Windows location is on. To unblock those users we ask
 *   the main process for an IP-based approximation
 *   (window.electronAPI.getIpLocation, wired in desktop/main.js).
 *
 *   In a regular browser (or in Electron with GOOGLE_API_KEY configured)
 *   navigator.geolocation works normally and we never hit the fallback.
 *
 * The server-side geofence radius (org.office_radius_m) is still the
 * authoritative check, so a wide-accuracy IP-based fix can only succeed
 * for orgs whose office radius is at least as wide as the fix accuracy.
 */

/**
 * Request the user's current position. Returns
 *   { latitude, longitude, accuracy, source }
 * where `source` is one of:
 *   'gps'       – came from navigator.geolocation
 *   'ip'        – came from the Electron IP-based fallback
 *
 * Rejects with `{ code, message }` where code is one of:
 *   'UNSUPPORTED' | 'PERMISSION_DENIED' | 'POSITION_UNAVAILABLE' | 'TIMEOUT'
 */
export async function getCurrentPosition(opts = {}) {
    // Primary path: browser/Chromium geolocation.
    try {
        const pos = await getBrowserPosition(opts);
        console.log('[Geolocation] Browser geolocation succeeded:', {
            lat: pos.latitude, lng: pos.longitude, accuracy: pos.accuracy, source: pos.source,
        });
        return pos;
    } catch (err) {
        console.warn('[Geolocation] Browser geolocation failed:', { code: err?.code, message: err?.message });

        // Try the Electron IP-based fallback only when:
        //   - We're actually running inside Electron (preload exposed it).
        //   - The browser failed for a "couldn't figure it out" reason.
        //     We do *not* fall back on PERMISSION_DENIED, because the user
        //     explicitly denied location and we should respect that.
        const fallbackEligible =
            err && err.code !== 'PERMISSION_DENIED' &&
            typeof window !== 'undefined' &&
            window.electronAPI &&
            typeof window.electronAPI.getIpLocation === 'function';

        console.log('[Geolocation] IP fallback eligible:', fallbackEligible, {
            errCode: err?.code, hasElectronAPI: !!window?.electronAPI,
            hasGetIpLocation: typeof window?.electronAPI?.getIpLocation,
        });

        if (!fallbackEligible) throw err;

        try {
            console.log('[Geolocation] Calling electronAPI.getIpLocation()...');
            const ipFix = await window.electronAPI.getIpLocation();
            console.log('[Geolocation] IP fallback response:', ipFix);
            if (ipFix && ipFix.ok && Number.isFinite(ipFix.latitude) && Number.isFinite(ipFix.longitude)) {
                const result = {
                    latitude: ipFix.latitude,
                    longitude: ipFix.longitude,
                    accuracy: ipFix.accuracy || 5000,
                    source: 'ip',
                };
                console.log('[Geolocation] Using IP-based location:', result);
                return result;
            }
            console.warn('[Geolocation] IP fallback returned unusable data:', ipFix);
        } catch (ipErr) {
            console.error('[Geolocation] IP fallback threw:', ipErr);
        }

        throw err;
    }
}

function getBrowserPosition(opts = {}) {
    return new Promise((resolve, reject) => {
        if (!('geolocation' in navigator)) {
            return reject({ code: 'UNSUPPORTED', message: 'Geolocation is not supported by this browser' });
        }
        navigator.geolocation.getCurrentPosition(
            (pos) => {
                const { latitude, longitude, accuracy } = pos.coords;
                resolve({ latitude, longitude, accuracy, source: 'gps' });
            },
            (err) => {
                let code = 'POSITION_UNAVAILABLE';
                if (err.code === 1) code = 'PERMISSION_DENIED';
                else if (err.code === 3) code = 'TIMEOUT';
                reject({ code, message: err.message || 'Could not determine your location' });
            },
            {
                enableHighAccuracy: true,
                timeout: 15000,
                maximumAge: 0,
                ...opts,
            }
        );
    });
}

/**
 * Read the BSSID of the Wi-Fi access point the OS is currently associated
 * with via the Electron preload bridge. Returns:
 *   { ok: true,  bssid, ssid, signal }   — connected to Wi-Fi
 *   { ok: false, error }                  — not on Wi-Fi / not Electron
 *
 * In a regular browser there is no privacy-preserving way to read the
 * BSSID, so we resolve `{ ok: false, error: 'unavailable' }` and the
 * server falls back to the geofence path.
 */
export async function getWifiInfo() {
    try {
        if (typeof window !== 'undefined' &&
            window.electronAPI &&
            typeof window.electronAPI.getWifiInfo === 'function') {
            console.log('[Geolocation] Calling electronAPI.getWifiInfo()...');
            const res = await window.electronAPI.getWifiInfo();
            console.log('[Geolocation] Wi-Fi info result:', res);
            if (res && res.ok) return res;
            return { ok: false, error: res?.error || 'unavailable' };
        }
        console.log('[Geolocation] getWifiInfo: not in Electron, returning unavailable');
        return { ok: false, error: 'unavailable' };
    } catch (err) {
        console.error('[Geolocation] getWifiInfo error:', err);
        return { ok: false, error: err?.message || 'unavailable' };
    }
}

/**
 * Gather every signal the server can use to verify the user is at the
 * office, in priority order:
 *   1. Wi-Fi BSSID (proves physical presence on the office network —
 *      the most reliable signal on laptops where GPS is bad).
 *   2. Geolocation (GPS / Wi-Fi-trilateration / IP fallback, in that
 *      order, as provided by `getCurrentPosition()`).
 *
 * Both are best-effort: the server decides whether either is sufficient
 * based on the org's configuration. Callers should send both fields in
 * the clock-in payload so the server can pick whichever proves the user
 * is on-site.
 *
 * Returns `{ wifi, location, locError }` where:
 *   - `wifi`     is the result of `getWifiInfo()`
 *   - `location` is the result of `getCurrentPosition()` (or null on error)
 *   - `locError` is the rejection from getCurrentPosition (or null)
 */
export async function getOfficeSignals(opts = {}) {
    console.log('[Geolocation] getOfficeSignals: starting parallel Wi-Fi + location collection...');
    // Kick off both in parallel — they're independent and the Wi-Fi
    // lookup typically resolves in <50 ms, well before the geolocation
    // permission prompt has even rendered.
    const wifiP = getWifiInfo();
    const locP = getCurrentPosition(opts).then(
        (loc) => ({ loc, err: null }),
        (err) => ({ loc: null, err }),
    );
    const [wifi, locRes] = await Promise.all([wifiP, locP]);
    console.log('[Geolocation] getOfficeSignals result:', {
        wifi: { ok: wifi?.ok, bssid: wifi?.bssid, ssid: wifi?.ssid, error: wifi?.error },
        location: locRes.loc ? { lat: locRes.loc.latitude, lng: locRes.loc.longitude, accuracy: locRes.loc.accuracy, source: locRes.loc.source } : null,
        locError: locRes.err ? { code: locRes.err.code, message: locRes.err.message } : null,
    });
    return { wifi, location: locRes.loc, locError: locRes.err };
}

/** Human-friendly message for a getCurrentPosition error code. */
export function geolocationErrorMessage(code) {
    switch (code) {
        case 'UNSUPPORTED':
            return 'Your browser does not support location access. Try a modern browser.';
        case 'PERMISSION_DENIED':
            return 'Location access was denied. Please allow location in your browser settings to clock in from office.';
        case 'POSITION_UNAVAILABLE':
            return "Couldn't determine your location. Check your GPS / Wi-Fi and try again.";
        case 'TIMEOUT':
            return 'Location request timed out. Please try again with a stronger signal.';
        default:
            return 'Failed to get your location. Please try again.';
    }
}
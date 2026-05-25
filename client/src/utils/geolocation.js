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
        return await getBrowserPosition(opts);
    } catch (err) {
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

        if (!fallbackEligible) throw err;

        try {
            const ipFix = await window.electronAPI.getIpLocation();
            if (ipFix && ipFix.ok && Number.isFinite(ipFix.latitude) && Number.isFinite(ipFix.longitude)) {
                return {
                    latitude: ipFix.latitude,
                    longitude: ipFix.longitude,
                    accuracy: ipFix.accuracy || 5000,
                    source: 'ip',
                };
            }
        } catch { /* swallow — surface original error below */ }

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
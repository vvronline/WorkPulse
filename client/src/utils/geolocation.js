/**
 * Promise-based wrapper around navigator.geolocation.
 * Used by the attendance clock-in flow to validate office presence.
 */

/**
 * Request the user's current position. Returns
 *   { latitude, longitude, accuracy }
 * Rejects with `{ code, message }` where code is one of:
 *   'UNSUPPORTED' | 'PERMISSION_DENIED' | 'POSITION_UNAVAILABLE' | 'TIMEOUT'
 */
export function getCurrentPosition(opts = {}) {
    return new Promise((resolve, reject) => {
        if (!('geolocation' in navigator)) {
            return reject({ code: 'UNSUPPORTED', message: 'Geolocation is not supported by this browser' });
        }
        navigator.geolocation.getCurrentPosition(
            (pos) => {
                const { latitude, longitude, accuracy } = pos.coords;
                resolve({ latitude, longitude, accuracy });
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
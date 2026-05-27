/**
 * Promise-based wrapper around navigator.geolocation, plus an Electron
 * fallback used by the attendance clock-in flow.
 *
 * ── Why this is more complicated than it should be ──
 *
 * Getting a useful {lat,lng,accuracy} fix in our desktop app is hard
 * because none of the available providers is reliable on its own:
 *
 *   1. `navigator.geolocation` in Chromium calls Google's Geolocation
 *      API (network-based: Wi-Fi BSSIDs + cell towers + IP). With a
 *      valid GOOGLE_API_KEY it returns ~20-500 m on Wi-Fi laptops, but
 *      WITHOUT a key Chromium silently falls back to a very coarse
 *      built-in path that can return city-level accuracy (60+ km).
 *      Either way, this call *succeeds* — it just lies about accuracy.
 *      That's why we can't rely on "the browser path threw" to decide
 *      whether to try other providers.
 *
 *   2. The native Windows Location API (System.Device.Location) is
 *      exposed via `window.electronAPI.getNativeLocation()` and uses
 *      the OS's own GPS/Wi-Fi triangulation service. Typically 20-100 m
 *      when Windows Location Services is ON, but returns "NoData" or
 *      blocks for 15 seconds when it isn't.
 *
 *   3. IP geolocation via `window.electronAPI.getIpLocation()` is the
 *      last-resort fallback. City-level (~5 km), useless for any
 *      geofence tighter than that, but at least proves the user is in
 *      the right country.
 *
 * Strategy: kick off all three in parallel, wait for the fastest "good
 * enough" fix, then pick the most accurate result overall. We define
 * "good enough" as accuracy ≤ ACCEPTABLE_ACCURACY_M — anything worse
 * is held as a fallback in case nothing better arrives.
 *
 * Mobile browsers and Chrome/Edge always go straight through path #1
 * and get accurate fixes because they have working API keys / real GPS
 * hardware. Our extra logic is only really exercised inside Electron.
 *
 * The server-side geofence radius (org.office_radius_m) is still the
 * authoritative check, so a wide-accuracy fallback fix can only succeed
 * for orgs whose office radius is at least as wide as the fix accuracy.
 */

// Accuracy (in metres) at or below which we consider a fix "trustworthy
// enough" to return without waiting for slower providers. Anything worse
// than this is still kept around as a fallback if no provider beats it.
//
// Picked at 200 m because:
//   - Native Windows Location API typically returns 20-100 m on Wi-Fi laptops.
//   - Google-keyed Chromium typically returns 30-500 m on the same hardware.
//   - IP geolocation always returns 5000 m.
// So 200 m sits in the gap that separates "real Wi-Fi triangulation" from
// "I'm guessing from your IP/timezone".
const ACCEPTABLE_ACCURACY_M = 200;

// Hard ceiling — fixes worse than this are treated as garbage and not
// returned at all, even as a last resort. The renderer will surface a
// "couldn't determine your location" error instead of silently giving
// the server a useless 60-km fix that's guaranteed to fail the geofence
// check anyway.
const UNUSABLE_ACCURACY_M = 50000;

/**
 * Request the user's current position. Returns
 *   { latitude, longitude, accuracy, source }
 * where `source` is one of:
 *   'gps'    – navigator.geolocation (browser/Chromium)
 *   'native' – native Windows Location API (Electron)
 *   'ip'     – IP geolocation (Electron fallback)
 *
 * Rejects with `{ code, message, accuracy?, source? }` where code is:
 *   'UNSUPPORTED' | 'PERMISSION_DENIED' | 'POSITION_UNAVAILABLE' | 'TIMEOUT'
 *
 * Note: `accuracy` and `source` are included on rejection when we got
 * *some* fix but it was too coarse to use, so the UI can tell the user
 * "we got a fix from $source with ±N km accuracy — please enable
 * Windows Location Services for a more accurate fix".
 */
export async function getCurrentPosition(opts = {}) {
    const inElectron =
        typeof window !== 'undefined' &&
        window.electronAPI &&
        typeof window.electronAPI.getIpLocation === 'function';

    // Single-provider fast path for real browsers — no need to spin up
    // the native / IP fallbacks (they don't exist anyway). On any error
    // we surface the browser error directly.
    if (!inElectron) {
        try {
            const pos = await getBrowserPosition(opts);
            console.log('[Geolocation] Browser geolocation (non-Electron):', pos);
            if (pos.accuracy > UNUSABLE_ACCURACY_M) {
                console.warn('[Geolocation] Browser accuracy > UNUSABLE — rejecting');
                throw {
                    code: 'POSITION_UNAVAILABLE',
                    message: 'Location is too coarse to use.',
                    accuracy: pos.accuracy,
                    source: pos.source,
                };
            }
            return pos;
        } catch (err) {
            console.warn('[Geolocation] Browser-only geolocation failed:', err);
            throw err;
        }
    }

    // ── Electron path: race all providers in parallel ────────────────
    console.log('[Geolocation] Electron path: running browser + native + IP in parallel...');

    const browserP = getBrowserPosition(opts).then(
        (pos) => ({ ok: true, pos }),
        (err) => ({ ok: false, err })
    );
    const nativeP = typeof window.electronAPI.getNativeLocation === 'function'
        ? window.electronAPI.getNativeLocation().then(
            (res) => res && res.ok && Number.isFinite(res.latitude) && Number.isFinite(res.longitude)
                ? { ok: true, pos: { latitude: res.latitude, longitude: res.longitude, accuracy: res.accuracy ?? 100, source: 'native' } }
                : { ok: false, err: { code: 'POSITION_UNAVAILABLE', message: res?.error || 'native_unavailable' } },
            (err) => ({ ok: false, err })
        )
        : Promise.resolve({ ok: false, err: { code: 'UNSUPPORTED', message: 'getNativeLocation unavailable' } });

    // IP is intentionally NOT awaited here — it's only consulted at the
    // very end if everything else came back unusable. Starting it now
    // means it's ready by the time we need it without delaying the fast
    // path. We swallow its errors entirely.
    const ipP = window.electronAPI.getIpLocation().then(
        (res) => res && res.ok && Number.isFinite(res.latitude) && Number.isFinite(res.longitude)
            ? { ok: true, pos: { latitude: res.latitude, longitude: res.longitude, accuracy: res.accuracy ?? 5000, source: 'ip' } }
            : { ok: false, err: { code: 'POSITION_UNAVAILABLE', message: res?.error || 'ip_unavailable' } },
        (err) => ({ ok: false, err })
    );

    // Wait for both browser and native to settle (they can both take up
    // to ~15 s for a cold fix). We don't short-circuit on the first
    // "good enough" result because the slower provider is often more
    // accurate (native Windows beats Chromium when Location Services
    // is on; the reverse is true when it isn't).
    const [browserRes, nativeRes, ipRes] = await Promise.all([browserP, nativeP, ipP]);

    console.log('[Geolocation] Provider results:', {
        browser: browserRes.ok ? { ...browserRes.pos } : { err: browserRes.err },
        native: nativeRes.ok ? { ...nativeRes.pos } : { err: nativeRes.err },
        ip: ipRes.ok ? { ...ipRes.pos } : { err: ipRes.err },
    });

    // Respect explicit permission denial — don't second-guess the user.
    if (browserRes.ok === false && browserRes.err && browserRes.err.code === 'PERMISSION_DENIED') {
        // Permission was denied in the browser layer. We still allow the
        // native Windows path (it's not browser-permission-gated) but if
        // that also failed, surface the original PERMISSION_DENIED so
        // the UI explains how to re-enable it.
        if (!nativeRes.ok) {
            throw browserRes.err;
        }
    }

    // Collect every usable fix and pick the most accurate.
    const fixes = [
        browserRes.ok ? browserRes.pos : null,
        nativeRes.ok ? nativeRes.pos : null,
        ipRes.ok ? ipRes.pos : null,
    ].filter(Boolean);

    if (fixes.length === 0) {
        const err = browserRes.err || nativeRes.err || ipRes.err || {
            code: 'POSITION_UNAVAILABLE',
            message: 'All location providers failed',
        };
        console.error('[Geolocation] All providers failed:', err);
        throw err;
    }

    // Sort by accuracy ascending (smallest accuracy = best fix).
    fixes.sort((a, b) => (a.accuracy ?? Infinity) - (b.accuracy ?? Infinity));
    const best = fixes[0];

    console.log('[Geolocation] Selected best fix:', best, '(out of', fixes.length, 'candidates)');

    if (best.accuracy > UNUSABLE_ACCURACY_M) {
        console.warn(`[Geolocation] Best fix is ${best.accuracy} m — > UNUSABLE_ACCURACY_M (${UNUSABLE_ACCURACY_M}) — rejecting`);
        throw {
            code: 'POSITION_UNAVAILABLE',
            message: `Location is too coarse to use (±${Math.round(best.accuracy)} m). Enable Windows Location Services for a more accurate fix.`,
            accuracy: best.accuracy,
            source: best.source,
        };
    }

    if (best.accuracy > ACCEPTABLE_ACCURACY_M) {
        // Still usable, but warn the caller so the UI can hint at how
        // to improve it. We don't reject here — the server will decide
        // whether the geofence radius is wide enough.
        console.warn(`[Geolocation] Best fix is ${best.accuracy} m — > ACCEPTABLE_ACCURACY_M (${ACCEPTABLE_ACCURACY_M}). Server may still reject.`);
    }

    return best;
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
 *   2. Geolocation (best of GPS / Wi-Fi-trilateration / native Windows /
 *      IP fallback, as provided by `getCurrentPosition()`).
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
        locError: locRes.err ? { code: locRes.err.code, message: locRes.err.message, accuracy: locRes.err.accuracy, source: locRes.err.source } : null,
    });
    return { wifi, location: locRes.loc, locError: locRes.err };
}

/** Human-friendly message for a getCurrentPosition error code. */
export function geolocationErrorMessage(code, extra = {}) {
    const { accuracy, source } = extra || {};
    switch (code) {
        case 'UNSUPPORTED':
            return 'Your browser does not support location access. Try a modern browser.';
        case 'PERMISSION_DENIED':
            return 'Location access was denied. Please allow location in your browser settings to clock in from office.';
        case 'POSITION_UNAVAILABLE':
            if (Number.isFinite(accuracy) && accuracy > 1000) {
                const km = (accuracy / 1000).toFixed(1);
                const sourceLabel =
                    source === 'ip' ? 'your network IP' :
                        source === 'native' ? 'Windows Location Services' :
                            source === 'gps' ? 'Chromium' : 'your device';
                return `We could only narrow your location to ±${km} km using ${sourceLabel}. Enable Windows Location Services (Settings → Privacy & Security → Location) for an accurate fix, or connect to office Wi-Fi.`;
            }
            return "Couldn't determine your location. Check your GPS / Wi-Fi and try again.";
        case 'TIMEOUT':
            return 'Location request timed out. Please try again with a stronger signal.';
        default:
            return 'Failed to get your location. Please try again.';
    }
}
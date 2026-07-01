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

export type PositionSource = "gps" | "native" | "ip";

export interface Position {
    latitude: number;
    longitude: number;
    accuracy: number;
    source: PositionSource;
}

export interface GeolocationError {
    code: "UNSUPPORTED" | "PERMISSION_DENIED" | "POSITION_UNAVAILABLE" | "TIMEOUT";
    message: string;
    accuracy?: number;
    source?: PositionSource;
}

export interface WifiInfo {
    ok: boolean;
    bssid?: string;
    ssid?: string;
    signal?: number;
    error?: string;
}

interface ElectronLocationResult {
    ok?: boolean;
    latitude?: number;
    longitude?: number;
    accuracy?: number;
    error?: string;
}

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
// the server a useless coarse fix that's guaranteed to fail the geofence
// check anyway.
//
// Set to 1000 m: a fix coarser than 1 km can never satisfy a realistic
// office geofence (org.office_radius_m is typically 50–300 m), and
// returning it only produces the misleading "Location verified (±50000 m)"
// → "you are 19843 m from the office" contradiction. Anything coarser is
// rejected client-side with an actionable message (turn on Location
// Services / connect to office Wi-Fi) instead.
const UNUSABLE_ACCURACY_M = 1000;

type ProviderResult =
    | { ok: true; pos: Position }
    | { ok: false; err: GeolocationError };

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
export async function getCurrentPosition(opts: PositionOptions = {}): Promise<Position> {
    const electronAPI = typeof window !== "undefined" ? window.electronAPI : undefined;
    const inElectron =
        !!electronAPI && typeof electronAPI.getIpLocation === "function";

    // Single-provider fast path for real browsers — no need to spin up
    // the native / IP fallbacks (they don't exist anyway). On any error
    // we surface the browser error directly.
    if (!inElectron) {
        try {
            const pos = await getBrowserPosition(opts);
            console.log("[Geolocation] Browser geolocation (non-Electron):", pos);
            if (pos.accuracy >= UNUSABLE_ACCURACY_M) {
                console.warn("[Geolocation] Browser accuracy >= UNUSABLE — rejecting");
                throw {
                    code: "POSITION_UNAVAILABLE",
                    message: `Location is too coarse to use (±${Math.round(pos.accuracy)} m).`,
                    accuracy: pos.accuracy,
                    source: pos.source,
                } as GeolocationError;
            }
            return pos;
        } catch (err) {
            console.warn("[Geolocation] Browser-only geolocation failed:", err);
            throw err;
        }
    }

    // ── Electron path: native-first, mirroring the mobile app ────────
    //
    // On mobile, `expo-location` reads the device's native OS location
    // service (GPS + Wi-Fi triangulation) and returns an accurate fix
    // without any Google API key. The desktop equivalent is the native
    // Windows Location API exposed via `getNativeLocation()` (see
    // desktop/main.ts → ipcMain.handle('get-native-location'), which uses
    // System.Device.Location.GeoCoordinateWatcher).
    //
    // We therefore treat the providers as a PRIORITY LIST, not a
    // best-accuracy race:
    //   1. Native OS location  — the true mobile-equivalent; accurate and
    //      keyless when Windows Location Services is ON.
    //   2. Browser geolocation — Chromium's network path; only useful when
    //      a GOOGLE_API_KEY is configured, otherwise coarse.
    //   3. IP geolocation      — country/city level ONLY. Deliberately NOT
    //      treated as a geofence-usable fix, because a ~5 km (or worse) IP
    //      guess that "succeeds" produces the misleading "Location verified
    //      (±3579 m)" → "you are 253 km from the office" contradiction.
    console.log("[Geolocation] Electron path: native-first provider chain...");

    const browserP: Promise<ProviderResult> = getBrowserPosition(opts).then(
        (pos) => ({ ok: true, pos }),
        (err: GeolocationError) => ({ ok: false, err }),
    );
    const nativeP: Promise<ProviderResult> = typeof electronAPI!.getNativeLocation === "function"
        ? (electronAPI!.getNativeLocation() as Promise<ElectronLocationResult>).then(
            (res): ProviderResult => res && res.ok && Number.isFinite(res.latitude) && Number.isFinite(res.longitude)
                ? { ok: true, pos: { latitude: res.latitude!, longitude: res.longitude!, accuracy: res.accuracy ?? 100, source: "native" } }
                : { ok: false, err: { code: "POSITION_UNAVAILABLE", message: res?.error || "native_unavailable" } },
            (err: GeolocationError): ProviderResult => ({ ok: false, err }),
        )
        : Promise.resolve<ProviderResult>({ ok: false, err: { code: "UNSUPPORTED", message: "getNativeLocation unavailable" } });

    // IP is started in parallel but only ever used as a last-resort,
    // non-geofence signal (see below). We swallow its errors entirely.
    const ipP: Promise<ProviderResult> = (electronAPI!.getIpLocation() as Promise<ElectronLocationResult>).then(
        (res): ProviderResult => res && res.ok && Number.isFinite(res.latitude) && Number.isFinite(res.longitude)
            ? { ok: true, pos: { latitude: res.latitude!, longitude: res.longitude!, accuracy: res.accuracy ?? 5000, source: "ip" } }
            : { ok: false, err: { code: "POSITION_UNAVAILABLE", message: res?.error || "ip_unavailable" } },
        (err: GeolocationError): ProviderResult => ({ ok: false, err }),
    );

    // Wait for native + browser to settle (both can take up to ~15 s for a
    // cold fix). IP is awaited too but only consulted at the very end.
    const [nativeRes, browserRes, ipRes] = await Promise.all([nativeP, browserP, ipP]);

    console.log("[Geolocation] Provider results:", {
        native: nativeRes.ok ? { ...nativeRes.pos } : { err: nativeRes.err },
        browser: browserRes.ok ? { ...browserRes.pos } : { err: browserRes.err },
        ip: ipRes.ok ? { ...ipRes.pos } : { err: ipRes.err },
    });

    // ── Priority 1 & 2: real location providers (native, then browser) ──
    // Collect only the "real" fixes (native + browser). IP is intentionally
    // excluded here — it can never prove on-site presence for a tight
    // geofence and including it is what caused the false "Location verified"
    // followed by a geofence rejection.
    const realFixes: Position[] = [
        nativeRes.ok ? nativeRes.pos : null,
        browserRes.ok ? browserRes.pos : null,
    ].filter((p): p is Position => p !== null);

    if (realFixes.length > 0) {
        // Among real providers, pick the most accurate.
        realFixes.sort((a, b) => (a.accuracy ?? Infinity) - (b.accuracy ?? Infinity));
        const best = realFixes[0];
        console.log("[Geolocation] Selected best real fix:", best, "(out of", realFixes.length, "candidates)");

        if (best.accuracy < UNUSABLE_ACCURACY_M) {
            if (best.accuracy > ACCEPTABLE_ACCURACY_M) {
                console.warn(`[Geolocation] Best fix is ${best.accuracy} m — > ACCEPTABLE_ACCURACY_M (${ACCEPTABLE_ACCURACY_M}). Server may still reject.`);
            }
            return best;
        }
        console.warn(`[Geolocation] Best real fix is ${best.accuracy} m — > UNUSABLE_ACCURACY_M (${UNUSABLE_ACCURACY_M}) — rejecting`);
        throw {
            code: "POSITION_UNAVAILABLE",
            message: `Location is too coarse to use (±${Math.round(best.accuracy)} m). Turn on Windows Location Services (Settings → Privacy & Security → Location) for an accurate fix, or connect to the office Wi-Fi.`,
            accuracy: best.accuracy,
            source: best.source,
        } as GeolocationError;
    }

    // ── Both real providers failed ──
    // Respect explicit permission denial first so the UI can explain how to
    // re-enable it. The native path isn't browser-permission-gated, so we
    // only surface PERMISSION_DENIED when native also failed (which it has
    // if we reached here).
    if (browserRes.ok === false && browserRes.err && browserRes.err.code === "PERMISSION_DENIED") {
        throw browserRes.err;
    }

    // No usable real fix. We do NOT silently fall back to the IP guess for
    // the geofence — that's the bug we're fixing. Instead surface a clear,
    // actionable error pointing at Windows Location Services (the desktop
    // analog of granting location permission on a phone). The IP fix, if
    // any, is attached as context so the message can mention how coarse it
    // was, but it is never returned as a usable Position.
    const ipAccuracy = ipRes.ok ? ipRes.pos.accuracy : undefined;
    const nativeErr = !nativeRes.ok ? nativeRes.err : null;
    console.error("[Geolocation] No usable real fix.", {
        native: nativeErr,
        ipAccuracy,
    });
    throw {
        code: "POSITION_UNAVAILABLE",
        message:
            "Couldn't get an accurate location. Turn on Windows Location Services " +
            "(Settings → Privacy & Security → Location) and allow desktop apps to " +
            "access your location, or connect to the office Wi-Fi to clock in.",
        accuracy: ipAccuracy,
        source: ipRes.ok ? "ip" : nativeErr?.source,
    } as GeolocationError;
}

function getBrowserPosition(opts: PositionOptions = {}): Promise<Position> {
    return new Promise((resolve, reject) => {
        if (!("geolocation" in navigator)) {
            return reject({ code: "UNSUPPORTED", message: "Geolocation is not supported by this browser" } as GeolocationError);
        }
        navigator.geolocation.getCurrentPosition(
            (pos) => {
                const { latitude, longitude, accuracy } = pos.coords;
                resolve({ latitude, longitude, accuracy, source: "gps" });
            },
            (err) => {
                let code: GeolocationError["code"] = "POSITION_UNAVAILABLE";
                if (err.code === 1) code = "PERMISSION_DENIED";
                else if (err.code === 3) code = "TIMEOUT";
                reject({ code, message: err.message || "Could not determine your location" } as GeolocationError);
            },
            {
                enableHighAccuracy: true,
                timeout: 15000,
                maximumAge: 0,
                ...opts,
            },
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
export async function getWifiInfo(): Promise<WifiInfo> {
    try {
        const electronAPI = typeof window !== "undefined" ? window.electronAPI : undefined;
        if (electronAPI && typeof electronAPI.getWifiInfo === "function") {
            console.log("[Geolocation] Calling electronAPI.getWifiInfo()...");
            const res = await electronAPI.getWifiInfo() as WifiInfo;
            console.log("[Geolocation] Wi-Fi info result:", res);
            if (res && res.ok) return res;
            return { ok: false, error: res?.error || "unavailable" };
        }
        console.log("[Geolocation] getWifiInfo: not in Electron, returning unavailable");
        return { ok: false, error: "unavailable" };
    } catch (err) {
        console.error("[Geolocation] getWifiInfo error:", err);
        return { ok: false, error: (err as Error)?.message || "unavailable" };
    }
}

export interface OfficeSignals {
    wifi: WifiInfo;
    location: Position | null;
    locError: GeolocationError | null;
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
export async function getOfficeSignals(opts: PositionOptions = {}): Promise<OfficeSignals> {
    console.log("[Geolocation] getOfficeSignals: starting parallel Wi-Fi + location collection...");
    // Kick off both in parallel — they're independent and the Wi-Fi
    // lookup typically resolves in <50 ms, well before the geolocation
    // permission prompt has even rendered.
    const wifiP = getWifiInfo();
    const locP = getCurrentPosition(opts).then(
        (loc): { loc: Position | null; err: GeolocationError | null } => ({ loc, err: null }),
        (err: GeolocationError): { loc: Position | null; err: GeolocationError | null } => ({ loc: null, err }),
    );
    const [wifi, locRes] = await Promise.all([wifiP, locP]);
    console.log("[Geolocation] getOfficeSignals result:", {
        wifi: { ok: wifi?.ok, bssid: wifi?.bssid, ssid: wifi?.ssid, error: wifi?.error },
        location: locRes.loc ? { lat: locRes.loc.latitude, lng: locRes.loc.longitude, accuracy: locRes.loc.accuracy, source: locRes.loc.source } : null,
        locError: locRes.err ? { code: locRes.err.code, message: locRes.err.message, accuracy: locRes.err.accuracy, source: locRes.err.source } : null,
    });
    return { wifi, location: locRes.loc, locError: locRes.err };
}

/**
 * Reverse-geocode a lat/lng pair into a human-readable address using the
 * free OpenStreetMap Nominatim service (no API key required). Returns the
 * `display_name` string on success, or `null` when the lookup fails / the
 * caller aborts. Polite usage: single request, honours the abort signal.
 */
export async function reverseGeocode(
    lat: number,
    lng: number,
    opts: { signal?: AbortSignal } = {},
): Promise<string | null> {
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    try {
        const url = `https://nominatim.openstreetmap.org/reverse?format=json&addressdetails=1&lat=${encodeURIComponent(
            String(lat),
        )}&lon=${encodeURIComponent(String(lng))}`;
        const res = await fetch(url, {
            signal: opts.signal,
            headers: { Accept: "application/json" },
        });
        if (!res.ok) return null;
        const data = await res.json();
        const name = data?.display_name;
        return typeof name === "string" && name.trim() ? name.trim() : null;
    } catch {
        return null;
    }
}

/** Human-friendly message for a getCurrentPosition error code. */
export function geolocationErrorMessage(
    code: string,
    extra: { accuracy?: number; source?: PositionSource } = {},
): string {
    const { accuracy, source } = extra || {};
    switch (code) {
        case "UNSUPPORTED":
            return "Your browser does not support location access. Try a modern browser.";
        case "PERMISSION_DENIED":
            return "Location access was denied. Please allow location in your browser settings to clock in from office.";
        case "POSITION_UNAVAILABLE":
            if (Number.isFinite(accuracy) && accuracy! > 1000) {
                const km = (accuracy! / 1000).toFixed(1);
                const sourceLabel =
                    source === "ip" ? "your network IP" :
                        source === "native" ? "Windows Location Services" :
                            source === "gps" ? "Chromium" : "your device";
                return `We could only narrow your location to ±${km} km using ${sourceLabel}. Enable Windows Location Services (Settings → Privacy & Security → Location) for an accurate fix, or connect to office Wi-Fi.`;
            }
            return "Couldn't determine your location. Check your GPS / Wi-Fi and try again.";
        case "TIMEOUT":
            return "Location request timed out. Please try again with a stronger signal.";
        default:
            return "Failed to get your location. Please try again.";
    }
}
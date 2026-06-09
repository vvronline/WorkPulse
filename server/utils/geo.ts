/**
 * Geolocation utilities for attendance verification.
 *
 * Used by the tracker clock-in flow to validate that a user clocking in
 * with work_mode === 'office' is physically within the tenant-configured
 * geofence around the office.
 */

const EARTH_RADIUS_M = 6371000; // mean Earth radius in metres

function toRad(deg: number): number {
    return (deg * Math.PI) / 180;
}

/**
 * Distance between two lat/lng points using the haversine formula.
 * Returns metres (always >= 0). Returns NaN if any input is invalid.
 */
function haversineMeters(
    lat1: number | string,
    lng1: number | string,
    lat2: number | string,
    lng2: number | string,
): number {
    const a1 = Number(lat1);
    const o1 = Number(lng1);
    const a2 = Number(lat2);
    const o2 = Number(lng2);
    if (!Number.isFinite(a1) || !Number.isFinite(o1) || !Number.isFinite(a2) || !Number.isFinite(o2)) {
        return NaN;
    }
    const φ1 = toRad(a1);
    const φ2 = toRad(a2);
    const Δφ = toRad(a2 - a1);
    const Δλ = toRad(o2 - o1);
    const h = Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
    const c = 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
    return EARTH_RADIUS_M * c;
}

/**
 * Validate a latitude value: number in [-90, 90].
 */
function isValidLat(lat: number | string): boolean {
    const n = Number(lat);
    return Number.isFinite(n) && n >= -90 && n <= 90;
}

/**
 * Validate a longitude value: number in [-180, 180].
 */
function isValidLng(lng: number | string): boolean {
    const n = Number(lng);
    return Number.isFinite(n) && n >= -180 && n <= 180;
}

/**
 * Returns true when the user point is within `radiusM` metres of the
 * office point. Returns false on any invalid input (defensive — caller
 * should validate before calling).
 */
function isWithinGeofence(
    userLat: number | string,
    userLng: number | string,
    orgLat: number | string,
    orgLng: number | string,
    radiusM: number | string,
): boolean {
    if (!isValidLat(userLat) || !isValidLng(userLng)) return false;
    if (!isValidLat(orgLat) || !isValidLng(orgLng)) return false;
    const r = Number(radiusM);
    if (!Number.isFinite(r) || r <= 0) return false;
    const d = haversineMeters(userLat, userLng, orgLat, orgLng);
    return Number.isFinite(d) && d <= r;
}

export {
    haversineMeters,
    isWithinGeofence,
    isValidLat,
    isValidLng,
};
/**
 * OpenStreetMap Nominatim helpers (free, no API key) — the mobile
 * counterpart of the web client's place search + `reverseGeocode()` in
 * client/src/utils/geolocation.ts / OfficeLocationSettings.tsx.
 *
 * Polite-usage notes:
 *   - Callers should debounce forward searches (≥400 ms) and abort
 *     superseded requests via the AbortSignal.
 *   - Results are capped at 6 like the web UI.
 */

export interface PlaceResult {
  place_id: number | string;
  lat: string;
  lon: string;
  display_name?: string;
  [key: string]: unknown;
}

const NOMINATIM_BASE = "https://nominatim.openstreetmap.org";

/** Forward geocode: free-text place/address search. */
export async function searchPlaces(
  query: string,
  opts?: { signal?: AbortSignal; limit?: number },
): Promise<PlaceResult[]> {
  const q = query.trim();
  if (q.length < 3) return [];
  const url = `${NOMINATIM_BASE}/search?format=json&addressdetails=1&limit=${
    opts?.limit ?? 6
  }&q=${encodeURIComponent(q)}`;
  const res = await fetch(url, {
    signal: opts?.signal,
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw new Error("search_failed");
  const data = await res.json();
  return Array.isArray(data) ? (data as PlaceResult[]) : [];
}

/**
 * Reverse geocode: coordinates → human-readable address. Returns null on any
 * failure (callers treat the address as optional).
 */
export async function reverseGeocode(
  lat: number,
  lng: number,
  opts?: { signal?: AbortSignal },
): Promise<string | null> {
  try {
    const url = `${NOMINATIM_BASE}/reverse?format=json&lat=${encodeURIComponent(
      lat,
    )}&lon=${encodeURIComponent(lng)}&zoom=18&addressdetails=1`;
    const res = await fetch(url, {
      signal: opts?.signal,
      headers: { Accept: "application/json" },
    });
    if (!res.ok) return null;
    const data = await res.json();
    const name = data?.display_name;
    return typeof name === "string" && name.trim() !== "" ? name : null;
  } catch {
    return null;
  }
}
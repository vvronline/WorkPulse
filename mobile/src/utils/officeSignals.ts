import * as Location from "expo-location";

/**
 * Mobile equivalent of client/src/utils/geolocation.ts `getOfficeSignals()`.
 *
 * The server's clock-in geofence accepts EITHER a matching office Wi-Fi BSSID
 * OR a GPS fix inside the office radius. On a standard managed Expo app we
 * cannot read the connected Wi-Fi BSSID without extra native modules /
 * permissions, so this helper focuses on GPS and leaves `wifi_bssid`
 * undefined — the server falls back to the geofence check, which is the
 * common case for mobile.
 */

export type Position = {
  latitude: number;
  longitude: number;
  accuracy?: number;
};

export type OfficeSignals = {
  location: Position | null;
  wifiBssid: string | null;
  error: { code: string; message: string } | null;
};

// Hard ceiling for the whole location acquisition. Indoors (the common case
// for an *office* clock-in) a high-accuracy GPS satellite fix can take a very
// long time or never resolve, which previously left the clock-in modal stuck
// on "Detecting your location…" forever. We always settle within this window.
const LOCATION_TIMEOUT_MS = 12000;
// A cached fix older than this is considered stale and ignored.
const LAST_KNOWN_MAX_AGE_MS = 60000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("Location request timed out. Move near a window or switch to remote."));
    }, ms);
    promise.then(
      (val) => {
        clearTimeout(timer);
        resolve(val);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

function toPosition(pos: Location.LocationObject): Position {
  return {
    latitude: pos.coords.latitude,
    longitude: pos.coords.longitude,
    accuracy: pos.coords.accuracy ?? undefined,
  };
}

export async function getOfficeSignals(): Promise<OfficeSignals> {
  try {
    const { status } = await Location.requestForegroundPermissionsAsync();
    if (status !== "granted") {
      return {
        location: null,
        wifiBssid: null,
        error: {
          code: "PERMISSION_DENIED",
          message:
            "Location permission is required to clock in from the office. Allow location access or switch to remote.",
        },
      };
    }

    // Fast path: a recent cached fix returns instantly and works indoors.
    try {
      const last = await Location.getLastKnownPositionAsync({
        maxAge: LAST_KNOWN_MAX_AGE_MS,
      });
      if (last) {
        return { location: toPosition(last), wifiBssid: null, error: null };
      }
    } catch {
      /* fall through to an active request */
    }

    // Active request: use Balanced accuracy (cell/Wi-Fi based) instead of
    // High (GPS satellites) so it resolves indoors, and race it against a
    // hard timeout so the promise always settles.
    const pos = await withTimeout(
      Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Balanced,
      }),
      LOCATION_TIMEOUT_MS,
    );

    return { location: toPosition(pos), wifiBssid: null, error: null };
  } catch (e: any) {
    return {
      location: null,
      wifiBssid: null,
      error: {
        code: "POSITION_UNAVAILABLE",
        message:
          e?.message ||
          "Could not get your location. Move to an area with better signal or switch to remote.",
      },
    };
  }
}
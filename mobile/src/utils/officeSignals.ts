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

    const pos = await Location.getCurrentPositionAsync({
      accuracy: Location.Accuracy.High,
    });

    return {
      location: {
        latitude: pos.coords.latitude,
        longitude: pos.coords.longitude,
        accuracy: pos.coords.accuracy ?? undefined,
      },
      wifiBssid: null,
      error: null,
    };
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
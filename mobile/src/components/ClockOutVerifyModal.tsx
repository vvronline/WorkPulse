import { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { AlertTriangle, LogOut, MapPin, X } from "../icons";
import type { Theme } from "../theme";
import { useTheme } from "../theme/ThemeProvider";
import { getOfficeSignals, type Position } from "../utils/officeSignals";
import { getCurrentOrg } from "../features";
import { clockOut, getTrackerStatus, type ClockOutPayload } from "../tracker";
import {
  clockInErrorInfo,
  type ClockInErrorInfo,
} from "../utils/clockInError";

type Props = {
  visible: boolean;
  onClose: () => void;
  onSuccess: () => void;
};

type OfficeGeofence = { lat: number; lng: number; radiusM: number };

function haversineM(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function formatDistance(m: number): string {
  if (m >= 1000) return `${(m / 1000).toFixed(1)} km`;
  return `${Math.round(m)} m`;
}

/**
 * Verification-enabled orgs restrict clock-out to the office. This modal
 * collects the current GPS fix, runs a client-side geofence pre-check, then
 * POSTs /tracker/clock-out with { latitude, longitude, accuracy }. The server
 * is authoritative and re-verifies the office presence.
 */
export default function ClockOutVerifyModal({
  visible,
  onClose,
  onSuccess,
}: Props) {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);

  const [location, setLocation] = useState<Position | null>(null);
  const [locErr, setLocErr] = useState<string | null>(null);
  const [outsideGeofence, setOutsideGeofence] = useState(false);
  const [busy, setBusy] = useState(false);
  const [submitErr, setSubmitErr] = useState<ClockInErrorInfo | null>(null);
  const orgGeoRef = useRef<Promise<OfficeGeofence | null> | null>(null);

  useEffect(() => {
    if (!visible) return;
    setLocation(null);
    setLocErr(null);
    setOutsideGeofence(false);
    setBusy(false);
    setSubmitErr(null);
    orgGeoRef.current = fetchOrgGeofence();
    requestSignals();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  async function fetchOrgGeofence(): Promise<OfficeGeofence | null> {
    try {
      const { data } = await getCurrentOrg();
      const lat = Number(data?.office_latitude);
      const lng = Number(data?.office_longitude);
      const radius = Number(data?.office_radius_m);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
      return {
        lat,
        lng,
        radiusM: Number.isFinite(radius) && radius > 0 ? radius : 200,
      };
    } catch {
      return null;
    }
  }
  async function requestSignals() {
    setLocErr(null);
    setOutsideGeofence(false);
    setSubmitErr(null);
    setBusy(true);
    try {
      const { location: loc, error } = await getOfficeSignals();
      if (loc) {
        setLocation(loc);
        const office = await (orgGeoRef.current ?? Promise.resolve(null));
        if (office) {
          const dist = haversineM(
            loc.latitude,
            loc.longitude,
            office.lat,
            office.lng,
          );
          const acc = loc.accuracy ?? 0;
          if (dist - acc > office.radiusM) {
            setOutsideGeofence(true);
            setLocErr(
              `You are not at the office - you are ~${formatDistance(dist)} away ` +
                `(allowed radius ${office.radiusM} m). Clock-out is only allowed ` +
                `from the office. Move closer and try again.`,
            );
            return;
          }
        }
      } else {
        setLocErr(error?.message || "Could not get your location.");
      }
    } finally {
      setBusy(false);
    }
  }

  async function submit() {
    if (!location) {
      setLocErr("Location is required to clock out from the office.");
      return;
    }
    setBusy(true);
    setSubmitErr(null);
    try {
      const payload: ClockOutPayload = {
        latitude: location.latitude,
        longitude: location.longitude,
        accuracy: location.accuracy,
      };
      await clockOut(payload);
      onSuccess();
    } catch (e: any) {
      if (!e?.response) {
        try {
          const { data } = await getTrackerStatus();
          if (data?.state === "logged_out") {
            onSuccess();
            return;
          }
        } catch {
          /* fall through */
        }
      }
      const info = clockInErrorInfo(e);
      setSubmitErr(info);
      if (info.kind === "location") {
        setOutsideGeofence(true);
        setLocErr(info.message);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      <View style={styles.overlay}>
        <View style={styles.card}>
          <View style={styles.header}>
            <View style={styles.headerLeft}>
              <LogOut size={18} color={theme.danger} />
              <Text style={styles.title}>Verify Clock-out</Text>
            </View>
            <Pressable onPress={onClose} hitSlop={8} disabled={busy}>
              <X size={22} color={theme.textSecondary} />
            </Pressable>
          </View>

          <View style={styles.body}>
            <Text style={styles.helpText}>
              Clock-out is only allowed from the office. We will verify your
              location before logging you out.
            </Text>

            {locErr ? (
              <View style={styles.locBox}>
                {outsideGeofence ? (
                  <MapPin size={28} color={theme.danger} />
                ) : (
                  <AlertTriangle size={28} color={theme.danger} />
                )}
                {outsideGeofence ? (
                  <Text style={styles.locErrTitle}>Not at the office</Text>
                ) : null}
                <Text style={styles.locErr}>{locErr}</Text>
                <Pressable
                  style={styles.primaryBtn}
                  onPress={requestSignals}
                  disabled={busy}
                >
                  <Text style={styles.primaryBtnText}>
                    {busy ? "Requesting..." : "Try again"}
                  </Text>
                </Pressable>
              </View>
            ) : location ? (
              <View style={styles.locBox}>
                <MapPin size={28} color={theme.success} />
                <Text style={styles.locDoneText}>
                  Location verified
                  {location.accuracy
                    ? ` (~${Math.round(location.accuracy)} m)`
                    : ""}
                </Text>
                {submitErr ? (
                  <View style={styles.submitErr}>
                    <AlertTriangle size={16} color={theme.danger} />
                    <View style={styles.submitErrTextWrap}>
                      <Text style={styles.submitErrTitle}>
                        {submitErr.title}
                      </Text>
                      <Text style={styles.submitErrText}>
                        {submitErr.message}
                      </Text>
                    </View>
                  </View>
                ) : null}
                <Pressable
                  style={styles.dangerBtn}
                  onPress={submit}
                  disabled={busy}
                >
                  <LogOut size={16} color="#fff" />
                  <Text style={styles.dangerBtnText}>
                    {busy ? "Logging out..." : "Confirm Logout"}
                  </Text>
                </Pressable>
              </View>
            ) : (
              <View style={styles.locBox}>
                <ActivityIndicator size="large" color={theme.primary} />
                <Text style={styles.locText}>Detecting your location...</Text>
              </View>
            )}
          </View>
        </View>
      </View>
    </Modal>
  );
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
    overlay: {
      flex: 1,
      backgroundColor: "rgba(0,0,0,0.5)",
      justifyContent: "flex-end",
    },
    card: {
      backgroundColor: theme.bgElevated,
      borderTopLeftRadius: 20,
      borderTopRightRadius: 20,
      padding: 20,
      maxHeight: "92%",
    },
    header: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
      marginBottom: 14,
    },
    headerLeft: { flexDirection: "row", alignItems: "center", gap: 8 },
    title: { fontSize: 18, fontWeight: "700", color: theme.text },
    body: { gap: 14 },
    helpText: {
      fontSize: 13,
      color: theme.textSecondary,
      textAlign: "center",
    },
    locBox: { alignItems: "center", gap: 14, paddingVertical: 20 },
    locText: { color: theme.textSecondary, fontSize: 14 },
    locErrTitle: { color: theme.danger, fontSize: 15, fontWeight: "700" },
    locErr: { color: theme.danger, fontSize: 13, textAlign: "center" },
    locDoneText: { color: theme.success, fontSize: 13, fontWeight: "600" },
    primaryBtn: {
      backgroundColor: theme.primary,
      borderRadius: theme.radiusSm,
      paddingVertical: 11,
      paddingHorizontal: 18,
    },
    primaryBtnText: { color: "#fff", fontSize: 14, fontWeight: "600" },
    dangerBtn: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 8,
      backgroundColor: theme.danger,
      borderRadius: theme.radiusSm,
      paddingVertical: 12,
      paddingHorizontal: 24,
      alignSelf: "stretch",
    },
    dangerBtnText: { color: "#fff", fontSize: 15, fontWeight: "700" },
    submitErr: {
      flexDirection: "row",
      alignItems: "flex-start",
      gap: 8,
      backgroundColor: "rgba(224, 62, 62, 0.1)",
      borderRadius: theme.radiusSm,
      padding: 10,
      alignSelf: "stretch",
    },
    submitErrTextWrap: { flex: 1, gap: 2 },
    submitErrTitle: { color: theme.danger, fontSize: 13, fontWeight: "700" },
    submitErrText: { color: theme.danger, fontSize: 12 },
  });

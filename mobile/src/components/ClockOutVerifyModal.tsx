import { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import {
  AlertTriangle,
  CheckCircle2,
  Fingerprint,
  LogOut,
  MapPin,
  X,
} from "../icons";
import * as LocalAuthentication from "expo-local-authentication";
import type { Theme } from "../theme";
import { useTheme } from "../theme/ThemeProvider";
import FaceCaptureWebView from "./FaceCaptureWebView";
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
  // "face" (default) shows the face scanner; "fingerprint" is used by employees
  // who have NOT enrolled a face — it skips straight to a device-biometric
  // prompt (the server accepts a fingerprint from the office without a face).
  method?: "face" | "fingerprint";

};

type OfficeGeofence = { lat: number; lng: number; radiusM: number };

/** Great-circle distance between two coordinates, in metres. */
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
 * Office clock-out verification (verification-enabled orgs only, and ONLY for
 * OFFICE sessions - remote sessions skip this modal, see
 * WorkTimerCard.onLogout). Mirrors ClockInVerifyModal:
 *   1. Location: GPS fix + client-side geofence pre-check.
 *   2. Face Match: capture a face descriptor OR fall back to the device
 *      fingerprint after a face failure.
 *   3. POST /tracker/clock-out with location + face_descriptor|fingerprint.
 */
export default function ClockOutVerifyModal({
  visible,
  onClose,
  onSuccess,
  method = "face",
}: Props) {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const fingerprintMode = method === "fingerprint";


  const [step, setStep] = useState<"location" | "face" | "submitting">(
    "location",
  );
  const [location, setLocation] = useState<Position | null>(null);
  const [locErr, setLocErr] = useState<string | null>(null);
  const [outsideGeofence, setOutsideGeofence] = useState(false);
  const [busy, setBusy] = useState(false);
  const [submitErr, setSubmitErr] = useState<ClockInErrorInfo | null>(null);
  const [resetNonce, setResetNonce] = useState(0);
  const lastDescriptorRef = useRef<number[] | null>(null);
  const [fpBusy, setFpBusy] = useState(false);
  const orgGeoRef = useRef<Promise<OfficeGeofence | null> | null>(null);

  useEffect(() => {
    if (!visible) return;
    setStep("location");
    setLocation(null);
    setLocErr(null);
    setOutsideGeofence(false);
    setBusy(false);
    setSubmitErr(null);
    lastDescriptorRef.current = null;
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
                `(allowed radius ${office.radiusM} m). Clock-out is only ` +
                `allowed from the office. Move closer and try again.`,
            );
            return;
          }
        }
        setStep("face");
      } else {
        setLocErr(error?.message || "Could not get your location.");
      }
    } finally {
      setBusy(false);
    }
  }

  async function handleFaceCapture(descriptor: number[]) {
    lastDescriptorRef.current = descriptor;
    await submitClockOut({ descriptor });
  }

  async function handleFingerprintFallback() {
    setFpBusy(true);
    try {
      const hasHardware = await LocalAuthentication.hasHardwareAsync();
      const enrolled = await LocalAuthentication.isEnrolledAsync();
      if (!hasHardware || !enrolled) {
        setSubmitErr({
          kind: "generic",
          title: "Fingerprint unavailable",
          message:
            "No fingerprint / device biometric is set up on this device. Set one up in your device settings, or retry the face scan.",
        });
        return;
      }
      const result = await LocalAuthentication.authenticateAsync({
        promptMessage: "Verify with fingerprint to clock out",
        disableDeviceFallback: false,
      });
      if (!result.success) {
        setSubmitErr({
          kind: "generic",
          title: "Fingerprint not verified",
          message:
            "Fingerprint verification was cancelled or failed. Try again.",
        });
        return;
      }
      await submitClockOut({
        descriptor: lastDescriptorRef.current ?? undefined,
        fingerprintVerified: true,
      });
    } finally {
      setFpBusy(false);
    }
  }

  async function submitClockOut(opts: {
    descriptor?: number[];
    fingerprintVerified?: boolean;
  }) {
    if (!location) {
      setLocErr("Location is required to clock out from the office.");
      setStep("location");
      return;
    }
    setStep("submitting");
    setSubmitErr(null);
    try {
      const payload: ClockOutPayload = {
        latitude: location.latitude,
        longitude: location.longitude,
        accuracy: location.accuracy,
        face_descriptor: opts.descriptor,
        fingerprint_verified: opts.fingerprintVerified,
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
        setStep("location");
      } else {
        setStep("face");
      }
      setResetNonce((n) => n + 1);
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

          <View style={styles.steps}>
            <StepPill
              index="1"
              label="Location"
              active={step === "location"}
              done={!!location && step !== "location"}
            />
            <View style={styles.stepConnector} />
            <StepPill
              index="2"
              label={fingerprintMode ? "Fingerprint" : "Face Match"}
              active={step === "face" || step === "submitting"}
              done={false}
            />
          </View>

          <View style={styles.body}>
            <Text style={styles.helpText}>
              Clock-out is only allowed from the office. We will verify your
              location and identity before logging you out.
            </Text>

            {step === "location" ? (
              <View style={styles.locBox}>
                {locErr ? (
                  <>
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
                        {busy ? "Requesting…" : "Try again"}
                      </Text>
                    </Pressable>
                  </>
                ) : (
                  <>
                    <ActivityIndicator size="large" color={theme.primary} />
                    <Text style={styles.locText}>
                      Detecting your location…
                    </Text>
                  </>
                )}
              </View>
            ) : null}

            {step === "face" || step === "submitting" ? (
              <>
                <Text style={styles.helpText}>
                  {fingerprintMode
                    ? "Verify your identity with your device fingerprint to clock out."
                    : "Look at the camera. We'll compare this to your enrolled face."}
                </Text>
                {fingerprintMode && step !== "submitting" ? (
                  <Pressable
                    style={styles.fingerprintBtn}
                    onPress={handleFingerprintFallback}
                    disabled={fpBusy}
                  >
                    <Fingerprint size={16} color="#fff" />
                    <Text style={styles.fingerprintBtnText}>
                      {fpBusy
                        ? "Verifying fingerprint..."
                        : "Verify with fingerprint"}
                    </Text>
                  </Pressable>
                ) : null}

                {location ? (
                  <View style={styles.locDone}>
                    <CheckCircle2 size={14} color={theme.success} />
                    <Text style={styles.locDoneText}>
                      Location verified
                      {location.accuracy
                        ? ` (±${Math.round(location.accuracy)} m)`
                        : ""}
                    </Text>
                  </View>
                ) : null}
                {submitErr ? (
                  <View style={styles.submitErr}>
                    {submitErr.kind === "location" ? (
                      <MapPin size={16} color={theme.danger} />
                    ) : (
                      <AlertTriangle size={16} color={theme.danger} />
                    )}
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
                {submitErr &&
                submitErr.kind === "face" &&
                step !== "submitting" ? (
                  <Pressable
                    style={styles.fingerprintBtn}
                    onPress={handleFingerprintFallback}
                    disabled={fpBusy}
                  >
                    <Fingerprint size={16} color="#fff" />
                    <Text style={styles.fingerprintBtnText}>
                      {fpBusy
                        ? "Verifying fingerprint…"
                        : "Use fingerprint instead"}
                    </Text>
                  </Pressable>
                ) : null}
                {step === "submitting" ? (
                  <View style={styles.submittingRow}>
                    <ActivityIndicator color={theme.primary} />
                    <Text style={styles.submittingText}>Logging out…</Text>
                  </View>
                ) : null}
              </>
            ) : null}

            {/* Single persistent WebView: mounted (hidden) from the moment the
                modal opens so the CDN library + models + camera warm up in
                parallel with the location step. */}
            <View
              style={step === "location" || fingerprintMode ? styles.warmup : null}
              pointerEvents={step === "location" || fingerprintMode ? "none" : "auto"}
            >
              <FaceCaptureWebView
                autoCapture={!submitErr}
                resetNonce={resetNonce}
                captureLabel="Verify & Logout"
                capturingLabel="Verifying…"
                onCapture={handleFaceCapture}
                disabled={step !== "face" || fingerprintMode}
              />
            </View>
          </View>
        </View>
      </View>
    </Modal>
  );
}


function StepPill({
  index,
  label,
  active,
  done,
}: {
  index: string;
  label: string;
  active: boolean;
  done: boolean;
}) {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  return (
    <View style={styles.stepPill}>
      <View
        style={[
          styles.stepNum,
          active && styles.stepNumActive,
          done && styles.stepNumDone,
        ]}
      >
        {done ? (
          <CheckCircle2 size={14} color="#fff" />
        ) : (
          <Text
            style={[styles.stepNumText, active && styles.stepNumTextActive]}
          >
            {index}
          </Text>
        )}
      </View>
      <Text style={[styles.stepLabel, active && styles.stepLabelActive]}>
        {label}
      </Text>
    </View>
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
    steps: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 8,
      marginBottom: 16,
    },
    stepPill: { flexDirection: "row", alignItems: "center", gap: 6 },
    stepNum: {
      width: 24,
      height: 24,
      borderRadius: 12,
      backgroundColor: theme.surfaceHover,
      alignItems: "center",
      justifyContent: "center",
    },
    stepNumActive: { backgroundColor: theme.primary },
    stepNumDone: { backgroundColor: theme.success },
    stepNumText: {
      fontSize: 12,
      fontWeight: "700",
      color: theme.textSecondary,
    },
    stepNumTextActive: { color: "#fff" },
    stepLabel: { fontSize: 13, color: theme.textSecondary, fontWeight: "500" },
    stepLabelActive: { color: theme.text, fontWeight: "700" },
    stepConnector: { width: 24, height: 1, backgroundColor: theme.border },
    body: { gap: 10 },
    helpText: {
      fontSize: 13,
      color: theme.textSecondary,
      textAlign: "center",
    },
    locBox: { alignItems: "center", gap: 14, paddingVertical: 30 },
    locText: { color: theme.textSecondary, fontSize: 14 },
    locErrTitle: { color: theme.danger, fontSize: 15, fontWeight: "700" },
    locErr: { color: theme.danger, fontSize: 13, textAlign: "center" },
    primaryBtn: {
      backgroundColor: theme.primary,
      borderRadius: theme.radiusSm,
      paddingVertical: 11,
      paddingHorizontal: 18,
    },
    primaryBtnText: { color: "#fff", fontSize: 14, fontWeight: "600" },
    locDone: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 6,
    },
    locDoneText: { color: theme.success, fontSize: 12, fontWeight: "600" },
    fingerprintBtn: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 8,
      backgroundColor: theme.primary,
      borderRadius: theme.radiusSm,
      paddingVertical: 11,
    },
    fingerprintBtnText: { color: "#fff", fontSize: 14, fontWeight: "600" },
    submitErr: {
      flexDirection: "row",
      alignItems: "flex-start",
      gap: 8,
      backgroundColor: "rgba(224, 62, 62, 0.1)",
      borderRadius: theme.radiusSm,
      padding: 10,
    },
    submitErrTextWrap: { flex: 1, gap: 2 },
    submitErrTitle: { color: theme.danger, fontSize: 13, fontWeight: "700" },
    submitErrText: { color: theme.danger, fontSize: 12 },
    submittingRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 8,
    },
    submittingText: { color: theme.textSecondary, fontSize: 13 },
    warmup: {
      height: 1,
      opacity: 0,
      overflow: "hidden",
    },
  });

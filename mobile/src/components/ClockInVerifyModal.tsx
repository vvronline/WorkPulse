
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
  MapPin,
  ShieldCheck,
  X,
} from "../icons";
import * as LocalAuthentication from "expo-local-authentication";
import type { Theme } from "../theme";
import { useTheme } from "../theme/ThemeProvider";
import FaceCaptureWebView from "./FaceCaptureWebView";
import VerifyError from "./VerifyError";
import { getOfficeSignals, type Position } from "../utils/officeSignals";
import { getCurrentOrg } from "../features";
import { clockIn, getTrackerStatus, type ClockInPayload } from "../tracker";
import {
  clockInErrorInfo,
  type ClockInErrorInfo,
} from "../utils/clockInError";

type WorkMode = "office" | "remote" | "hybrid";

type Props = {
  visible: boolean;
  workMode: WorkMode;
  onClose: () => void;
  onSuccess: () => void;
  // Verification method chosen by the user. "face" (default) shows the face
  // scanner; "fingerprint" is used by employees who have NOT enrolled a face —
  // it skips straight to a device-biometric prompt (the server accepts a
  // fingerprint from the office without a face on file).
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
 * RN equivalent of client/src/components/attendance/ClockInVerifyModal.tsx.
 *
 * Steps:
 *   1. (office/hybrid) Collect GPS location. If unavailable, surface the error
 *      but still allow proceeding — the server is authoritative and will
 *      reject if the geofence/wifi check fails.
 *   2. Capture a face descriptor via FaceCaptureWebView (face-api.js).
 *   3. POST /tracker/clock-in with { work_mode, face_descriptor, lat/lng,
 *      accuracy }.
 */
export default function ClockInVerifyModal({
  visible,
  workMode,
  onClose,
  onSuccess,
  method = "face",
}: Props) {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const needsLocation = workMode === "office" || workMode === "hybrid";
  const fingerprintMode = method === "fingerprint";

  const [step, setStep] = useState<"location" | "face" | "submitting">(
    needsLocation ? "location" : "face",
  );
  const [location, setLocation] = useState<Position | null>(null);
  const [locErr, setLocErr] = useState<string | null>(null);
  // True when the client-side geofence pre-check (or a server geofence
  // rejection) determined the user is outside the office radius — the
  // location step then shows a clear "you are X from the office" error
  // instead of the spinner, and hides "Continue anyway" (the server would
  // reject it anyway).
  const [outsideGeofence, setOutsideGeofence] = useState(false);
  const [submitErr, setSubmitErr] = useState<ClockInErrorInfo | null>(null);
  const [busy, setBusy] = useState(false);
  // Bumped after a failed submit to re-arm the WebView capture button.
  const [resetNonce, setResetNonce] = useState(0);
  // Remember the most recent captured descriptor so the fingerprint fallback
  // can re-submit the same office-presence context after a face failure.
  const lastDescriptorRef = useRef<number[] | null>(null);
  // True while the device biometric (fingerprint) prompt is in flight.
  const [fpBusy, setFpBusy] = useState(false);
  // Org office coordinates + radius, fetched in parallel with the GPS
  // request so we can geofence-check locally BEFORE running the face scan.
  const orgGeoRef = useRef<Promise<OfficeGeofence | null> | null>(null);

  useEffect(() => {
    if (!visible) return;
    // Reset state each time the modal opens.
    setStep(needsLocation ? "location" : "face");
    setLocation(null);
    setLocErr(null);
    setOutsideGeofence(false);
    setSubmitErr(null);
    setBusy(false);
    if (needsLocation) {
      // Kick off the org geofence fetch in parallel with the GPS request.
      orgGeoRef.current = fetchOrgGeofence();
      requestSignals();
    }
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
      // Org fetch failed — skip the local pre-check; server stays
      // authoritative on submit.
      return null;
    }
  }

  async function requestSignals() {
    setLocErr(null);
    setOutsideGeofence(false);
    setBusy(true);
    try {
      const { location: loc, error } = await getOfficeSignals();
      if (loc) {
        setLocation(loc);
        // Client-side geofence pre-check: if the org's office coordinates are
        // known and the fix (even allowing for its accuracy) is clearly
        // outside the radius, fail fast with a specific message INSTEAD of
        // wasting the user's time on a face scan the server will reject.
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
              `You're not at the office — you are ~${formatDistance(dist)} away ` +
                `(allowed radius ${office.radiusM} m). Move to the office and ` +
                `try again, or switch to remote mode.`,
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
    await submitClockIn({ descriptor });
  }

  // Fingerprint fallback: after a face failure the user can prove identity with
  // the device's own biometric (fingerprint / OS auth). The office location was
  // already collected in the location step, so we re-submit the SAME location
  // with fingerprint_verified=true. The server still enforces the office
  // geofence/wifi, so this only works from the office.
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
        promptMessage: "Verify with fingerprint to clock in",
        disableDeviceFallback: false,
      });
      if (!result.success) {
        setSubmitErr({
          kind: "generic",
          title: "Fingerprint not verified",
          message: "Fingerprint verification was cancelled or failed. Try again.",
        });
        return;
      }
      await submitClockIn({
        descriptor: lastDescriptorRef.current ?? undefined,
        fingerprintVerified: true,
      });
    } finally {
      setFpBusy(false);
    }
  }

  async function submitClockIn(opts: {
    descriptor?: number[];
    fingerprintVerified?: boolean;
  }) {
    setStep("submitting");
    setSubmitErr(null);
    try {
      const payload: ClockInPayload = {
        work_mode: workMode,
        face_descriptor: opts.descriptor,
        latitude: location?.latitude,
        longitude: location?.longitude,
        accuracy: location?.accuracy,
        fingerprint_verified: opts.fingerprintVerified,
      };
      await clockIn(payload);
      onSuccess();
    } catch (e: any) {
      // Distinguish a genuine server-side rejection (face mismatch,
      // geofence, etc.) from a lost-response transport error. The server
      // writes the clock-in row inside a transaction and only THEN returns
      // its JSON; if the request reaches the server but the response is lost
      // — a dropped/slow connection or the axios timeout firing — axios
      // rejects with NO `response`. Showing the generic "Clock-in failed"
      // in that case is wrong: the user is already clocked in.
      if (!e?.response) {
        try {
          const { data } = await getTrackerStatus();
          if (data?.state === "on_floor" || data?.state === "on_break") {
            // The clock-in actually succeeded server-side.
            onSuccess();
            return;
          }
        } catch {
          /* status re-check failed too — fall through to the error below */
        }
      }
      // Map the structured server error (code + message) into a specific
      // "Location Mismatch" / "Face Mismatch" reason instead of a flat
      // "Clock-in failed". Route the user back to the relevant step so they
      // can fix it (move closer / re-scan their face).
      const info = clockInErrorInfo(e);
      setSubmitErr(info);
      if (info.kind === "location" && needsLocation) {
        // Show the server's geofence rejection ON the location step —
        // previously we switched to the location step without an error, so
        // it rendered the "Detecting your location…" spinner forever.
        setOutsideGeofence(true);
        setLocErr(info.message);
        setStep("location");
      } else {
        setStep("face");
      }
      // Re-arm the capture button; auto-capture stays off after the first
      // rejection (autoCapture prop is now false) so a mismatch doesn't
      // auto-retry into the face-attempt rate limit.
      setResetNonce((n) => n + 1);
    }
  }

  // Skip a failed location step and try the face scan anyway (server decides).
  function skipLocation() {
    setLocErr(null);
    setOutsideGeofence(false);
    setStep("face");
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
          {/* Header */}
          <View style={styles.header}>
            <View style={styles.headerLeft}>
              <ShieldCheck size={18} color={theme.primary} />
              <Text style={styles.title}>Verify Login</Text>
            </View>
            <Pressable onPress={onClose} hitSlop={8} disabled={busy}>
              <X size={22} color={theme.textSecondary} />
            </Pressable>
          </View>

          {/* Step indicator */}
          <View style={styles.steps}>
            {needsLocation ? (
              <>
                <StepPill
                  index="1"
                  label="Location"
                  active={step === "location"}
                  done={!!location}
                />
                <View style={styles.stepConnector} />
              </>
            ) : null}
            <StepPill
              index={needsLocation ? "2" : "1"}
              label={fingerprintMode ? "Fingerprint" : "Face Match"}
              active={step === "face" || step === "submitting"}
              done={false}
            />
          </View>

          {/* Body */}
          <View style={styles.body}>
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
                    <View style={styles.locBtnRow}>
                      <Pressable
                        style={styles.primaryBtn}
                        onPress={requestSignals}
                        disabled={busy}
                      >
                        <Text style={styles.primaryBtnText}>
                          {busy ? "Requesting…" : "Try again"}
                        </Text>
                      </Pressable>
                      {!outsideGeofence ? (
                        <Pressable
                          style={styles.secondaryBtn}
                          onPress={skipLocation}
                          disabled={busy}
                        >
                          <Text style={styles.secondaryBtnText}>
                            Continue anyway
                          </Text>
                        </Pressable>
                      ) : null}
                    </View>
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
                    ? "Verify your identity with your device fingerprint to clock in."
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

                {needsLocation && location ? (
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
                {needsLocation && !location ? (
                  <View style={styles.locWarn}>
                    <MapPin size={14} color={theme.warning} />
                    <Text style={styles.locWarnText}>
                      No location — the server will verify on submit.
                    </Text>
                  </View>
                ) : null}
                {submitErr ? <VerifyError info={submitErr} /> : null}
                {/* Fingerprint fallback: offered after a FACE failure when a
                    location is required (office/hybrid). Location is already
                    captured, so the server can still enforce the geofence. */}
                {submitErr && submitErr.kind === "face" && needsLocation && step !== "submitting" ? (
                  <Pressable
                    style={styles.fingerprintBtn}
                    onPress={handleFingerprintFallback}
                    disabled={fpBusy}
                  >
                    <Fingerprint size={16} color="#fff" />
                    <Text style={styles.fingerprintBtnText}>
                      {fpBusy ? "Verifying fingerprint..." : "Use fingerprint instead"}
                    </Text>
                  </Pressable>
                ) : null}
                {step === "submitting" ? (
                  <View style={styles.submittingRow}>
                    <ActivityIndicator color={theme.primary} />
                    <Text style={styles.submittingText}>Logging in…</Text>
                  </View>
                ) : null}
              </>
            ) : null}

            {/* Single persistent WebView: mounted (hidden) from the moment
                the modal opens, so the CDN library + model download and the
                camera warm-up happen IN PARALLEL with the location step —
                by the time the user reaches the face step it's already
                live. Keeping one instance (rather than remounting) also
                avoids camera-contention races between two WebViews. */}
            <View
              style={step === "location" || fingerprintMode ? styles.warmup : null}
              pointerEvents={step === "location" || fingerprintMode ? "none" : "auto"}
            >
              <FaceCaptureWebView
                // Auto-capture as soon as a face is steadily in frame — but
                // only until the first server rejection, so a mismatch
                // doesn't auto-retry into the face-attempt rate limit
                // (mirrors the web client's ClockInVerifyModal).
                autoCapture={!submitErr}
                resetNonce={resetNonce}
                captureLabel="Verify & Login"
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
    backgroundColor: "rgba(0,0,0,0.6)",
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
  stepNumText: { fontSize: 12, fontWeight: "700", color: theme.textSecondary },
  stepNumTextActive: { color: "#fff" },
  stepLabel: { fontSize: 13, color: theme.textSecondary, fontWeight: "500" },
  stepLabelActive: { color: theme.text, fontWeight: "700" },
  stepConnector: { width: 24, height: 1, backgroundColor: theme.border },
  body: { gap: 10 },
  locBox: { alignItems: "center", gap: 14, paddingVertical: 30 },
  locText: { color: theme.textSecondary, fontSize: 14 },
  locErrTitle: { color: theme.danger, fontSize: 15, fontWeight: "700" },
  locErr: { color: theme.danger, fontSize: 13, textAlign: "center" },
  locBtnRow: { flexDirection: "row", gap: 10 },
  primaryBtn: {
    backgroundColor: theme.primary,
    borderRadius: theme.radiusSm,
    paddingVertical: 11,
    paddingHorizontal: 18,
  },
  primaryBtnText: { color: "#fff", fontSize: 14, fontWeight: "600" },
  secondaryBtn: {
    backgroundColor: theme.surface,
    borderWidth: 1,
    borderColor: theme.glassBorder,
    borderRadius: theme.radiusSm,
    paddingVertical: 11,
    paddingHorizontal: 18,
  },
  secondaryBtnText: {
    color: theme.textSecondary,
    fontSize: 14,
    fontWeight: "600",
  },
  helpText: {
    fontSize: 13,
    color: theme.textSecondary,
    textAlign: "center",
  },
  locDone: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
  },
  locDoneText: { color: theme.success, fontSize: 12, fontWeight: "600" },
  locWarn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
  },
  locWarnText: { color: theme.warning, fontSize: 12, fontWeight: "600" },
  submitErr: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
    backgroundColor: "rgba(224, 62, 62, 0.1)",
    borderRadius: theme.radiusSm,
    padding: 10,
  },
  submitErrTextWrap: { flex: 1, gap: 2 },
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
  submitErrTitle: { color: theme.danger, fontSize: 13, fontWeight: "700" },
  submitErrText: { color: theme.danger, fontSize: 12 },
  submittingRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  submittingText: { color: theme.textSecondary, fontSize: 13 },
  // Kept mounted but visually hidden during the location step so the
  // WebView (CDN library + models + camera) warms up in parallel.
  warmup: {
    height: 1,
    opacity: 0,
    overflow: "hidden",
  },
});

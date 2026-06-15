
import { useEffect, useMemo, useState } from "react";
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
  MapPin,
  ShieldCheck,
  X,
} from "lucide-react-native";
import type { Theme } from "../theme";
import { useTheme } from "../theme/ThemeProvider";
import FaceCaptureWebView from "./FaceCaptureWebView";
import { getOfficeSignals, type Position } from "../utils/officeSignals";
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
};

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
}: Props) {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const needsLocation = workMode === "office" || workMode === "hybrid";

  const [step, setStep] = useState<"location" | "face" | "submitting">(
    needsLocation ? "location" : "face",
  );
  const [location, setLocation] = useState<Position | null>(null);
  const [locErr, setLocErr] = useState<string | null>(null);
  const [submitErr, setSubmitErr] = useState<ClockInErrorInfo | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!visible) return;
    // Reset state each time the modal opens.
    setStep(needsLocation ? "location" : "face");
    setLocation(null);
    setLocErr(null);
    setSubmitErr(null);
    setBusy(false);
    if (needsLocation) {
      requestSignals();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  async function requestSignals() {
    setLocErr(null);
    setBusy(true);
    try {
      const { location: loc, error } = await getOfficeSignals();
      if (loc) {
        setLocation(loc);
        setStep("face");
      } else {
        setLocErr(error?.message || "Could not get your location.");
      }
    } finally {
      setBusy(false);
    }
  }

  async function handleFaceCapture(descriptor: number[]) {
    setStep("submitting");
    setSubmitErr(null);
    try {
      const payload: ClockInPayload = {
        work_mode: workMode,
        face_descriptor: descriptor,
        latitude: location?.latitude,
        longitude: location?.longitude,
        accuracy: location?.accuracy,
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
      setStep(info.kind === "location" && needsLocation ? "location" : "face");
    }
  }

  // Skip a failed location step and try the face scan anyway (server decides).
  function skipLocation() {
    setLocErr(null);
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
              <Text style={styles.title}>Verify Clock-In</Text>
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
              label="Face Match"
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
                    <AlertTriangle size={28} color={theme.danger} />
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
                      <Pressable
                        style={styles.secondaryBtn}
                        onPress={skipLocation}
                        disabled={busy}
                      >
                        <Text style={styles.secondaryBtnText}>
                          Continue anyway
                        </Text>
                      </Pressable>
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
                  Look at the camera. We'll compare this to your enrolled face.
                </Text>
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
                <FaceCaptureWebView
                  captureLabel="Verify & Clock In"
                  capturingLabel="Verifying…"
                  onCapture={handleFaceCapture}
                  disabled={step === "submitting"}
                />
                {step === "submitting" ? (
                  <View style={styles.submittingRow}>
                    <ActivityIndicator color={theme.primary} />
                    <Text style={styles.submittingText}>Clocking in…</Text>
                  </View>
                ) : null}
              </>
            ) : null}
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
  submitErrTitle: { color: theme.danger, fontSize: 13, fontWeight: "700" },
  submitErrText: { color: theme.danger, fontSize: 12 },
  submittingRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  submittingText: { color: theme.textSecondary, fontSize: 13 },
});
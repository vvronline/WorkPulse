import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Stack } from "expo-router";
import { ScanFace, ShieldCheck, Trash2 } from "lucide-react-native";
import { theme } from "../../src/theme";
import FaceCaptureWebView from "../../src/components/FaceCaptureWebView";
import {
  clearFaceEnrollment,
  enrollFace,
  getFaceStatus,
  type FaceStatus,
} from "../../src/features";

export default function FaceEnrollment() {
  const [status, setStatus] = useState<FaceStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [capturing, setCapturing] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const { data } = await getFaceStatus();
      setStatus(data);
    } catch {
      setStatus(null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function handleCapture(descriptor: number[]) {
    setBusy(true);
    try {
      await enrollFace(descriptor);
      Alert.alert("Enrolled", "Your face has been enrolled successfully.");
      setCapturing(false);
      await load();
    } catch (e: any) {
      Alert.alert(
        "Error",
        e?.response?.data?.error || "Failed to enroll face. Try again.",
      );
    } finally {
      setBusy(false);
    }
  }

  function confirmClear() {
    Alert.alert(
      "Clear Face Enrollment",
      "Remove your enrolled face descriptor? You'll need to re-enroll to use face verification at clock-in.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Clear",
          style: "destructive",
          onPress: async () => {
            setBusy(true);
            try {
              await clearFaceEnrollment();
              await load();
            } catch (e: any) {
              Alert.alert(
                "Error",
                e?.response?.data?.error || "Failed to clear enrollment",
              );
            } finally {
              setBusy(false);
            }
          },
        },
      ],
    );
  }

  if (loading) {
    return (
      <View style={[styles.screen, styles.center]}>
        <Stack.Screen options={{ title: "Face Enrollment" }} />
        <ActivityIndicator color={theme.primary} />
      </View>
    );
  }

  const enrolled = !!status?.enrolled;

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.container}>
      <Stack.Screen options={{ title: "Face Enrollment" }} />

      <View style={styles.heroIcon}>
        <ScanFace size={40} color={theme.primary} />
      </View>

      <Text style={styles.title}>Face Verification</Text>
      <Text style={styles.subtitle}>
        Enroll your face to verify your identity automatically at clock-in.
      </Text>

      <View style={styles.statusCard}>
        <View style={styles.statusRow}>
          <ShieldCheck
            size={20}
            color={enrolled ? theme.success : theme.textMuted}
          />
          <View style={{ flex: 1 }}>
            <Text style={styles.statusLabel}>
              {enrolled ? "Enrolled" : "Not Enrolled"}
            </Text>
            {enrolled && status?.enrolled_at ? (
              <Text style={styles.statusSub}>
                Enrolled on {new Date(status.enrolled_at).toLocaleDateString()}
              </Text>
            ) : (
              <Text style={styles.statusSub}>No face descriptor stored yet.</Text>
            )}
          </View>
        </View>
      </View>

      {capturing ? (
        <>
          <Text style={styles.note}>
            Center your face in the frame, ensure good lighting, then capture.
            Your photo never leaves the device — only a numeric face signature
            is sent.
          </Text>
          <FaceCaptureWebView
            captureLabel={enrolled ? "Re-enroll Face" : "Enroll Face"}
            capturingLabel="Enrolling…"
            onCapture={handleCapture}
            disabled={busy}
          />
          <Pressable
            style={styles.secondaryBtn}
            onPress={() => setCapturing(false)}
            disabled={busy}
          >
            <Text style={styles.secondaryBtnText}>Cancel</Text>
          </Pressable>
        </>
      ) : (
        <>
          <Text style={styles.note}>
            Face capture uses your device camera with on-device processing. Tap
            below to {enrolled ? "re-enroll" : "enroll"} your face.
          </Text>
          <Pressable
            style={styles.primaryBtn}
            onPress={() => setCapturing(true)}
          >
            <ScanFace size={16} color="#fff" />
            <Text style={styles.primaryBtnText}>
              {enrolled ? "Re-enroll Face" : "Enroll Face"}
            </Text>
          </Pressable>

          {enrolled ? (
            <Pressable
              style={[styles.dangerBtn, busy && styles.disabled]}
              onPress={confirmClear}
              disabled={busy}
            >
              {busy ? (
                <ActivityIndicator color={theme.danger} />
              ) : (
                <>
                  <Trash2 size={16} color={theme.danger} />
                  <Text style={styles.dangerBtnText}>Clear Enrollment</Text>
                </>
              )}
            </Pressable>
          ) : null}
        </>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.bg },
  center: { alignItems: "center", justifyContent: "center" },
  container: { padding: 20, alignItems: "center", gap: 12 },
  heroIcon: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: theme.primaryGlow,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 12,
  },
  title: { fontSize: 22, fontWeight: "700", color: theme.text, marginTop: 8 },
  subtitle: {
    fontSize: 14,
    color: theme.textSecondary,
    textAlign: "center",
    paddingHorizontal: 12,
  },
  statusCard: {
    width: "100%",
    backgroundColor: theme.glass,
    borderWidth: 1,
    borderColor: theme.glassBorder,
    borderRadius: theme.radiusLg,
    padding: 16,
    marginTop: 8,
  },
  statusRow: { flexDirection: "row", alignItems: "center", gap: 12 },
  statusLabel: { fontSize: 16, fontWeight: "700", color: theme.text },
  statusSub: { fontSize: 13, color: theme.textSecondary, marginTop: 2 },
  note: {
    fontSize: 13,
    color: theme.textMuted,
    textAlign: "center",
    paddingHorizontal: 8,
    marginTop: 4,
  },
  primaryBtn: {
    width: "100%",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: theme.primary,
    borderRadius: theme.radiusSm,
    paddingVertical: 14,
    marginTop: 8,
  },
  primaryBtnText: { color: "#fff", fontSize: 15, fontWeight: "600" },
  secondaryBtn: {
    width: "100%",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.surface,
    borderWidth: 1,
    borderColor: theme.glassBorder,
    borderRadius: theme.radiusSm,
    paddingVertical: 14,
    marginTop: 8,
  },
  secondaryBtnText: { color: theme.textSecondary, fontSize: 15, fontWeight: "600" },
  dangerBtn: {
    width: "100%",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: "rgba(224, 62, 62, 0.1)",
    borderWidth: 1,
    borderColor: "rgba(224, 62, 62, 0.25)",
    borderRadius: theme.radiusSm,
    paddingVertical: 14,
  },
  dangerBtnText: { color: theme.danger, fontWeight: "600", fontSize: 15 },
  disabled: { opacity: 0.5 },
});
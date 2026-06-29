import { useRouter } from "expo-router";
import { useMemo, useState } from "react";
import {
  ActivityIndicator,
  Image,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { AxiosError } from "axios";
import {
  ArrowRight,
  Eye,
  EyeOff,
  ScanFace,
  Fingerprint,
} from "lucide-react-native";
import { useAuth } from "../src/auth/AuthContext";
import type { Theme } from "../src/theme";
import { useTheme } from "../src/theme/ThemeProvider";

export default function LoginScreen() {
  const {
    login,
    biometricAvailable,
    biometricEnrolled,
    biometricLabel,
    biometricKind,
    biometricLogin,
  } = useAuth();
  const router = useRouter();
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit() {
    setError(null);
    setBusy(true);
    try {
      await login(username.trim(), password);
      router.replace("/(tabs)");
    } catch (e) {
      const err = e as AxiosError<{ error?: string }>;
      // Prefer the server's error message. If there is no HTTP response it's a
      // network-layer failure (or an exception thrown after the request) —
      // surface the axios code/message so the cause is visible on-device
      // (release builds strip the JS console).
      const serverMsg = err.response?.data?.error;
      const detail =
        serverMsg ||
        (err.response
          ? `Login failed (HTTP ${err.response.status})`
          : err.code || err.message
            ? `Login failed: ${err.code ?? ""} ${err.message ?? ""}`.trim()
            : e instanceof Error && e.message
              ? e.message
              : "Login failed");
      setError(detail);
    } finally {
      setBusy(false);
    }
  }

  // Sign in with the device biometric (Face ID / Touch ID / fingerprint).
  // Only offered when hardware is present AND a credential was enrolled on
  // this device. A cancelled prompt is a no-op; a revoked credential surfaces
  // a friendly "set it up again" message.
  async function onBiometricLogin() {
    setError(null);
    setBusy(true);
    try {
      const ok = await biometricLogin();
      if (ok) {
        router.replace("/(tabs)");
      }
      // ok === false → user cancelled the OS prompt; stay on the screen.
    } catch (e) {
      const err = e as AxiosError<{ error?: string }>;
      if (err.response?.status === 401) {
        setError(
          `${biometricLabel} login is no longer valid on this device. Sign in with your password and enable it again.`,
        );
      } else {
        setError(err.response?.data?.error || `${biometricLabel} login failed. Use your password instead.`);
      }
    } finally {
      setBusy(false);
    }
  }

  const showBiometric = biometricAvailable && biometricEnrolled;
  const canSubmit = username.trim().length > 0 && password.length > 0 && !busy;

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      {/* Ambient glow accents (mirror the web auth-container ::before/::after) */}
      <View style={styles.glowTop} pointerEvents="none" />
      <View style={styles.glowBottom} pointerEvents="none" />

      <ScrollView
        contentContainerStyle={styles.scroll}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.card}>
          <View style={styles.icon}>
            <Image
              source={require("../assets/icon.png")}
              style={styles.logo}
              resizeMode="contain"
            />
          </View>

          <Text style={styles.title}>Get into the Loops</Text>
          <Text style={styles.subtitle}>Sign in to Loops</Text>

          {error ? (
            <View style={styles.errorBox}>
              <Text style={styles.errorText}>{error}</Text>
            </View>
          ) : null}

          {/* Username */}
          <View style={styles.formGroup}>
            <Text style={styles.label}>Username</Text>
            <TextInput
              style={styles.input}
              placeholder="Enter your username"
              placeholderTextColor={theme.textMuted}
              autoCapitalize="none"
              autoCorrect={false}
              value={username}
              onChangeText={setUsername}
            />
          </View>

          {/* Password */}
          <View style={styles.formGroup}>
            <Text style={styles.label}>Password</Text>
            <View style={styles.passwordWrap}>
              <TextInput
                style={[styles.input, styles.passwordInput]}
                placeholder="Enter your password"
                placeholderTextColor={theme.textMuted}
                secureTextEntry={!showPassword}
                value={password}
                onChangeText={setPassword}
              />
              <Pressable
                style={styles.eyeBtn}
                onPress={() => setShowPassword((v) => !v)}
                hitSlop={8}
              >
                {showPassword ? (
                  <EyeOff size={18} color={theme.textMuted} />
                ) : (
                  <Eye size={18} color={theme.textMuted} />
                )}
              </Pressable>
            </View>
          </View>

          <Text style={styles.forgot}>Forgot password?</Text>

          <TouchableOpacity
            style={[styles.button, !canSubmit && styles.buttonDisabled]}
            onPress={onSubmit}
            disabled={!canSubmit}
            activeOpacity={0.85}
          >
            {busy ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <View style={styles.buttonContent}>
                <Text style={styles.buttonText}>Sign In</Text>
                <ArrowRight size={16} color="#fff" />
              </View>
            )}
          </TouchableOpacity>

          {showBiometric ? (
            <>
              <View style={styles.dividerRow}>
                <View style={styles.dividerLine} />
                <Text style={styles.dividerText}>or</Text>
                <View style={styles.dividerLine} />
              </View>
              <TouchableOpacity
                style={styles.biometricButton}
                onPress={onBiometricLogin}
                disabled={busy}
                activeOpacity={0.85}
              >
                {biometricKind === "fingerprint" ? (
                  <Fingerprint size={18} color={theme.primaryLight} />
                ) : (
                  <ScanFace size={18} color={theme.primaryLight} />
                )}
                <Text style={styles.biometricText}>Sign in with {biometricLabel}</Text>
              </TouchableOpacity>
            </>
          ) : null}

          <Text style={styles.switch}>
            Don&apos;t have an account?{" "}
            <Text style={styles.switchLink}>Register</Text>
          </Text>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.bg },
  scroll: {
    flexGrow: 1,
    justifyContent: "center",
    padding: 24,
  },
  glowTop: {
    position: "absolute",
    width: 600,
    height: 600,
    borderRadius: 300,
    backgroundColor: "rgba(35, 131, 226, 0.12)",
    top: -260,
    right: -160,
  },
  glowBottom: {
    position: "absolute",
    width: 500,
    height: 500,
    borderRadius: 250,
    backgroundColor: "rgba(35, 131, 226, 0.08)",
    bottom: -240,
    left: -160,
  },
  card: {
    backgroundColor: theme.glass,
    borderWidth: 1,
    borderColor: theme.glassBorder,
    borderRadius: theme.radiusXl,
    padding: 28,
    width: "100%",
    maxWidth: 440,
    alignSelf: "center",
  },
  icon: {
    width: 56,
    height: 56,
    borderRadius: 16,
    backgroundColor: theme.primary,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 20,
    overflow: "hidden",
  },
  logo: {
    width: 40,
    height: 40,
    borderRadius: 10,
  },
  title: {
    fontSize: 26,
    fontWeight: "700",
    color: theme.text,
    letterSpacing: -0.5,
    marginBottom: 6,
  },
  subtitle: {
    fontSize: 14,
    color: theme.textSecondary,
    marginBottom: 24,
  },
  errorBox: {
    backgroundColor: "rgba(224, 62, 62, 0.1)",
    borderWidth: 1,
    borderColor: "rgba(224, 62, 62, 0.3)",
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 14,
    marginBottom: 16,
  },
  errorText: { color: "#fca5a5", fontSize: 13 },
  formGroup: { marginBottom: 18 },
  label: {
    fontSize: 11,
    fontWeight: "600",
    color: theme.textSecondary,
    textTransform: "uppercase",
    letterSpacing: 0.6,
    marginBottom: 8,
  },
  input: {
    backgroundColor: theme.inputBg,
    borderWidth: 1,
    borderColor: theme.inputBorder,
    borderRadius: theme.radiusSm,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
    color: theme.text,
  },
  passwordWrap: { position: "relative", justifyContent: "center" },
  passwordInput: { paddingRight: 44 },
  eyeBtn: {
    position: "absolute",
    right: 12,
    height: "100%",
    justifyContent: "center",
  },
  forgot: {
    color: theme.textSecondary,
    fontSize: 13,
    textAlign: "right",
    marginBottom: 18,
  },
  button: {
    backgroundColor: theme.primary,
    borderRadius: theme.radiusSm,
    paddingVertical: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  buttonDisabled: { opacity: 0.4 },
  buttonContent: { flexDirection: "row", alignItems: "center", gap: 6 },
  buttonText: { color: "#fff", fontSize: 15, fontWeight: "600" },
  dividerRow: {
    flexDirection: "row",
    alignItems: "center",
    marginTop: 18,
    marginBottom: 4,
  },
  dividerLine: { flex: 1, height: 1, backgroundColor: theme.glassBorder },
  dividerText: {
    color: theme.textMuted,
    fontSize: 12,
    marginHorizontal: 12,
    textTransform: "uppercase",
    letterSpacing: 0.6,
  },
  biometricButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    marginTop: 14,
    paddingVertical: 13,
    borderRadius: theme.radiusSm,
    borderWidth: 1,
    borderColor: theme.inputBorder,
    backgroundColor: theme.inputBg,
  },
  biometricText: { color: theme.primaryLight, fontSize: 15, fontWeight: "600" },
  switch: {
    textAlign: "center",
    marginTop: 22,
    fontSize: 14,
    color: theme.textSecondary,
  },
  switchLink: { color: theme.primaryLight, fontWeight: "600" },
});

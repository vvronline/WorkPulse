import { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Linking,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Download, Sparkles, X } from "lucide-react-native";
import type { Theme } from "../theme";
import { useTheme } from "../theme/ThemeProvider";
import {
  checkForMobileUpdate,
  downloadAndInstallApk,
  type MobileUpdateInfo,
} from "../updater";

/**
 * UpdateChecker — mounts once at the app root. On launch it checks GitHub for a
 * newer `mobile-v*` release and, if found, presents a themed modal offering an
 * in-app download + install. Fully independent from the desktop updater.
 *
 * Imperative manual checks (e.g. from the Profile screen) can call
 * `checkForMobileUpdate()` directly and route the user here via the
 * `triggerUpdateCheck` ref helper exposed below.
 */

let externalTrigger: (() => void) | null = null;

/**
 * Trigger an update check from anywhere (e.g. a "Check for Updates" button).
 * No-op if the UpdateChecker isn't mounted yet.
 */
export function triggerUpdateCheck(): void {
  externalTrigger?.();
}

export default function UpdateChecker() {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);

  const [info, setInfo] = useState<MobileUpdateInfo | null>(null);
  const [visible, setVisible] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const checkedOnLaunch = useRef(false);

  async function runCheck(showWhenUpToDate: boolean) {
    const result = await checkForMobileUpdate();
    setInfo(result);
    if (result.available) {
      setError(null);
      setProgress(0);
      setDownloading(false);
      setVisible(true);
    } else if (showWhenUpToDate) {
      // Manual checks surface a brief "up to date" modal; auto checks stay silent.
      setVisible(true);
    }
  }

  // Auto-check shortly after launch (gives the app time to settle).
  useEffect(() => {
    if (checkedOnLaunch.current) return;
    checkedOnLaunch.current = true;
    const t = setTimeout(() => {
      void runCheck(false);
    }, 4000);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Wire up the external manual trigger.
  useEffect(() => {
    externalTrigger = () => {
      void runCheck(true);
    };
    return () => {
      externalTrigger = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function onInstall() {
    if (!info?.apkUrl) {
      // No APK asset — fall back to the release page.
      if (info?.releaseUrl) void Linking.openURL(info.releaseUrl);
      return;
    }
    setDownloading(true);
    setError(null);
    setProgress(0);
    try {
      await downloadAndInstallApk(info.apkUrl, info.version || "latest", (f) =>
        setProgress(f),
      );
      // The Android installer takes over from here. Close the modal.
      setVisible(false);
    } catch {
      setError(
        "Download failed. You can try again or open the release page to download manually.",
      );
    } finally {
      setDownloading(false);
    }
  }

  if (!visible || !info) return null;

  const isUpToDate = !info.available;

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={() => !downloading && setVisible(false)}
    >
      <View style={styles.overlay}>
        <View style={styles.card}>
          <View style={styles.header}>
            <View style={styles.titleRow}>
              <Sparkles size={20} color={theme.primary} />
              <Text style={styles.title}>
                {isUpToDate ? "You're up to date" : "Update available"}
              </Text>
            </View>
            {!downloading && (
              <Pressable onPress={() => setVisible(false)} hitSlop={8}>
                <X size={22} color={theme.textSecondary} />
              </Pressable>
            )}
          </View>

          {isUpToDate ? (
            <Text style={styles.body}>
              WorkPulse {info.currentVersion} is the latest version.
            </Text>
          ) : (
            <>
              <Text style={styles.versionLine}>
                Version {info.version}
                {info.currentVersion ? (
                  <Text style={styles.muted}>  (current {info.currentVersion})</Text>
                ) : null}
              </Text>

              {info.notes ? (
                <ScrollView style={styles.notes} contentContainerStyle={{ paddingBottom: 4 }}>
                  <Text style={styles.notesText}>{info.notes}</Text>
                </ScrollView>
              ) : null}

              {downloading ? (
                <View style={styles.progressWrap}>
                  <View style={styles.progressTrack}>
                    <View
                      style={[styles.progressBar, { width: `${Math.round(progress * 100)}%` }]}
                    />
                  </View>
                  <Text style={styles.progressLabel}>
                    Downloading… {Math.round(progress * 100)}%
                  </Text>
                </View>
              ) : null}

              {error ? <Text style={styles.error}>{error}</Text> : null}

              <Pressable
                style={[styles.primaryBtn, downloading && styles.btnDisabled]}
                onPress={onInstall}
                disabled={downloading}
              >
                {downloading ? (
                  <ActivityIndicator color="#fff" />
                ) : (
                  <>
                    <Download size={16} color="#fff" />
                    <Text style={styles.primaryBtnText}>Download &amp; Install</Text>
                  </>
                )}
              </Pressable>

              {!downloading && (
                <Pressable style={styles.laterBtn} onPress={() => setVisible(false)}>
                  <Text style={styles.laterBtnText}>Later</Text>
                </Pressable>
              )}
            </>
          )}
        </View>
      </View>
    </Modal>
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
      gap: 12,
    },
    header: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
    },
    titleRow: { flexDirection: "row", alignItems: "center", gap: 8 },
    title: { fontSize: 18, fontWeight: "700", color: theme.text },
    body: { color: theme.textSecondary, fontSize: 15, paddingVertical: 8 },
    versionLine: { color: theme.text, fontSize: 15, fontWeight: "600" },
    muted: { color: theme.textMuted, fontSize: 13, fontWeight: "400" },
    notes: {
      maxHeight: 220,
      backgroundColor: theme.surface,
      borderWidth: 1,
      borderColor: theme.glassBorder,
      borderRadius: theme.radiusSm,
      padding: 12,
    },
    notesText: { color: theme.textSecondary, fontSize: 13, lineHeight: 19 },
    progressWrap: { gap: 6 },
    progressTrack: {
      height: 8,
      borderRadius: 4,
      backgroundColor: theme.surfaceHover,
      overflow: "hidden",
    },
    progressBar: {
      height: 8,
      borderRadius: 4,
      backgroundColor: theme.primary,
    },
    progressLabel: { color: theme.textSecondary, fontSize: 12, textAlign: "center" },
    error: { color: theme.danger, fontSize: 13 },
    primaryBtn: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 8,
      backgroundColor: theme.primary,
      borderRadius: theme.radiusSm,
      paddingVertical: 14,
      marginTop: 4,
    },
    btnDisabled: { opacity: 0.6 },
    primaryBtnText: { color: "#fff", fontSize: 15, fontWeight: "600" },
    secondaryBtn: {
      alignItems: "center",
      justifyContent: "center",
      paddingVertical: 12,
    },
    secondaryBtnText: { color: theme.primary, fontSize: 14, fontWeight: "600" },
    laterBtn: { alignItems: "center", justifyContent: "center", paddingVertical: 8 },
    laterBtnText: { color: theme.textSecondary, fontSize: 14 },
  });
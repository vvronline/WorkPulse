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
import { Download, Sparkles, X } from "../icons";
import { useTheme } from "../theme/ThemeProvider";
import type { Theme } from "../theme";
import {
  checkForMobileUpdate,
  downloadAndInstallApk,
  type MobileUpdateInfo,
} from "../updater";

let externalTrigger: (() => void) | null = null;

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

  async function runCheck(showAllResults: boolean) {
    setError(null);
    const result = await checkForMobileUpdate();
    setInfo(result);
    if (result.available || showAllResults) setVisible(true);
  }

  useEffect(() => {
    externalTrigger = () => void runCheck(true);
    if (!checkedOnLaunch.current) {
      checkedOnLaunch.current = true;
      const timer = setTimeout(() => void runCheck(false), 2500);
      return () => {
        clearTimeout(timer);
        if (externalTrigger) externalTrigger = null;
      };
    }
    return () => {
      if (externalTrigger) externalTrigger = null;
    };
  }, []);

  async function install() {
    if (!info?.apkUrl || !info.version) return;
    setDownloading(true);
    setProgress(0);
    setError(null);
    try {
      await downloadAndInstallApk(info.apkUrl, info.version, setProgress);
      setVisible(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The update could not be installed.");
    } finally {
      setDownloading(false);
    }
  }

  if (!visible || !info) return null;
  const upToDate = info.reason === "up-to-date";
  const failed = !info.available && !upToDate;

  return (
    <Modal visible transparent animationType="slide" onRequestClose={() => !downloading && setVisible(false)}>
      <View style={styles.overlay}>
        <View style={styles.card}>
          <View style={styles.header}>
            <View style={styles.titleRow}>
              <Sparkles size={20} color={theme.primary} />
              <Text style={styles.title}>
                {info.available ? "Update available" : upToDate ? "You're up to date" : "Update check failed"}
              </Text>
            </View>
            {!downloading && <Pressable onPress={() => setVisible(false)} hitSlop={8}><X size={22} color={theme.textSecondary} /></Pressable>}
          </View>

          {upToDate && <Text style={styles.body}>AINO {info.currentVersion} is the latest version.</Text>}
          {failed && <Text style={styles.error}>{info.errorMessage || "No mobile release is currently available. Please try again later."}</Text>}

          {info.available && (
            <>
              <Text style={styles.version}>Version {info.version} <Text style={styles.muted}>(current {info.currentVersion})</Text></Text>
              {!!info.notes && <ScrollView style={styles.notes}><Text style={styles.body}>{info.notes}</Text></ScrollView>}
              {downloading && (
                <View style={styles.progressWrap}>
                  <View style={styles.track}><View style={[styles.bar, { width: `${Math.round(progress * 100)}%` }]} /></View>
                  <Text style={styles.muted}>Downloading… {Math.round(progress * 100)}%</Text>
                </View>
              )}
              {!!error && <Text style={styles.error}>{error}</Text>}
              <Pressable style={[styles.primary, downloading && styles.disabled]} onPress={install} disabled={downloading}>
                {downloading ? <ActivityIndicator color="#fff" /> : <><Download size={16} color="#fff" /><Text style={styles.primaryText}>Download &amp; Install</Text></>}
              </Pressable>
              {!!info.releaseUrl && !downloading && <Pressable onPress={() => void Linking.openURL(info.releaseUrl!)}><Text style={styles.link}>Open download page</Text></Pressable>}
            </>
          )}
        </View>
      </View>
    </Modal>
  );
}

function makeStyles(theme: Theme) {
  return StyleSheet.create({
    overlay: { flex: 1, justifyContent: "center", padding: 24, backgroundColor: "rgba(0,0,0,0.65)" },
    card: { maxHeight: "80%", borderRadius: 20, padding: 20, backgroundColor: theme.surface, borderWidth: 1, borderColor: theme.border },
    header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 16 },
    titleRow: { flexDirection: "row", alignItems: "center", gap: 8 },
    title: { color: theme.text, fontSize: 18, fontWeight: "700" },
    body: { color: theme.text, fontSize: 14, lineHeight: 21 },
    version: { color: theme.text, fontSize: 15, fontWeight: "600", marginBottom: 12 },
    muted: { color: theme.textSecondary, fontSize: 13, fontWeight: "400" },
    notes: { maxHeight: 220, marginBottom: 16 },
    progressWrap: { gap: 8, marginBottom: 14 },
    track: { height: 7, borderRadius: 4, overflow: "hidden", backgroundColor: theme.border },
    bar: { height: "100%", backgroundColor: theme.primary },
    error: { color: theme.danger, fontSize: 14, lineHeight: 20, marginBottom: 14 },
    primary: { minHeight: 46, borderRadius: 12, flexDirection: "row", gap: 8, alignItems: "center", justifyContent: "center", backgroundColor: theme.primary },
    primaryText: { color: "#fff", fontSize: 15, fontWeight: "700" },
    disabled: { opacity: 0.6 },
    link: { color: theme.primary, textAlign: "center", paddingTop: 14, fontWeight: "600" },
  });
}
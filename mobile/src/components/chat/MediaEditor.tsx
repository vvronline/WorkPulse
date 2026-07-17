import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Image,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import {
  Crop as CropIcon,
  Pencil,
  Plus,
  RotateCw,
  Send,
  Timer,
  Trash2,
  X,
} from "../../icons";
import Svg, { Path } from "react-native-svg";
import ViewShot, { captureRef } from "react-native-view-shot";
import * as ImageManipulator from "expo-image-manipulator";
import * as ImagePicker from "expo-image-picker";
import type { Theme } from "../../theme";
import { useTheme } from "../../theme/ThemeProvider";

export type MediaEditorResult = {
  uri: string;
  fileName: string;
  mimeType: string;
  viewOnce: boolean;
  caption?: string;
  width: number;
  height: number;
};

type EditItem = {
  id: string;
  uri: string;
  width: number;
  height: number;
  strokes: { color: string; d: string }[];
};

const PEN_COLORS = ["#ff3b30", "#ffcc00", "#34c759", "#0a84ff", "#ffffff", "#000000"];
const MAX_STD = 1280;
const MAX_HD = 2560;

/**
 * MediaEditor — Signal-style image editor for the mobile composer. Mirrors the
 * web MediaEditor: add more, pen (SVG overlay flattened via view-shot), crop
 * (centre square via image-manipulator), rotate, quality (Standard/HD),
 * view-once toggle, caption + send.
 */
export default function MediaEditor({
  initialItems,
  onSend,
  onClose,
}: {
  initialItems: { uri: string; width?: number; height?: number }[];
  onSend: (results: MediaEditorResult[]) => void;
  onClose: () => void;
}) {
  const theme = useTheme();
  const styles = makeStyles(theme);

  const [items, setItems] = useState<EditItem[]>(() =>
    initialItems.map((it, i) => ({
      id: `item_${Date.now()}_${i}`,
      uri: it.uri,
      width: it.width || 1080,
      height: it.height || 1080,
      strokes: [],
    })),
  );
  const [activeIdx, setActiveIdx] = useState(0);
  const [penMode, setPenMode] = useState(false);
  const [penColor, setPenColor] = useState(PEN_COLORS[0]);
  const [quality, setQuality] = useState<"standard" | "hd">("standard");
  const [viewOnce, setViewOnce] = useState(false);
  const [caption, setCaption] = useState("");
  const [busy, setBusy] = useState(false);
  const [currentPath, setCurrentPath] = useState("");
  const shotRef = useRef<React.ComponentRef<typeof ViewShot> | null>(null);

  const active = items[activeIdx];

  // Resolve missing image dimensions.
  useEffect(() => {
    items.forEach((it, idx) => {
      if (it.width && it.height) return;
      Image.getSize(
        it.uri,
        (w, h) => {
          setItems((prev) =>
            prev.map((p, i) => (i === idx ? { ...p, width: w, height: h } : p)),
          );
        },
        () => {},
      );
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items.length]);

  const updateActive = useCallback(
    (patch: Partial<EditItem>) => {
      setItems((prev) => prev.map((p, i) => (i === activeIdx ? { ...p, ...patch } : p)));
    },
    [activeIdx],
  );

  // ─── Pen drawing (SVG path built from touch points) ───
  const onTouchStart = (e: any) => {
    if (!penMode) return;
    const { locationX, locationY } = e.nativeEvent;
    setCurrentPath(`M ${locationX} ${locationY}`);
  };
  const onTouchMove = (e: any) => {
    if (!penMode || !currentPath) return;
    const { locationX, locationY } = e.nativeEvent;
    setCurrentPath((p) => `${p} L ${locationX} ${locationY}`);
  };
  const onTouchEnd = () => {
    if (!penMode || !currentPath) return;
    updateActive({ strokes: [...active.strokes, { color: penColor, d: currentPath }] });
    setCurrentPath("");
  };

  const undoStroke = () => {
    updateActive({ strokes: active.strokes.slice(0, -1) });
  };

  const rotate = async () => {
    try {
      const res = await ImageManipulator.manipulateAsync(
        active.uri,
        [{ rotate: 90 }],
        { compress: 1, format: ImageManipulator.SaveFormat.JPEG },
      );
      updateActive({ uri: res.uri, width: res.width, height: res.height, strokes: [] });
    } catch {
      /* ignore */
    }
  };

  // Centre-square crop (Signal's crop affordance; keeps it robust on mobile).
  const cropSquare = async () => {
    try {
      const side = Math.min(active.width, active.height);
      const originX = Math.max(0, Math.round((active.width - side) / 2));
      const originY = Math.max(0, Math.round((active.height - side) / 2));
      const res = await ImageManipulator.manipulateAsync(
        active.uri,
        [{ crop: { originX, originY, width: side, height: side } }],
        { compress: 1, format: ImageManipulator.SaveFormat.JPEG },
      );
      updateActive({ uri: res.uri, width: res.width, height: res.height, strokes: [] });
    } catch {
      /* ignore */
    }
  };

  const addMore = async () => {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) return;
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      quality: 1,
      allowsMultipleSelection: true,
    });
    if (result.canceled) return;
    const next: EditItem[] = result.assets.map((a, i) => ({
      id: `item_${Date.now()}_add_${i}`,
      uri: a.uri,
      width: a.width || 1080,
      height: a.height || 1080,
      strokes: [],
    }));
    setItems((prev) => [...prev, ...next]);
  };

  const removeItem = (idx: number) => {
    if (items.length <= 1) {
      onClose();
      return;
    }
    setItems((prev) => prev.filter((_, i) => i !== idx));
    setActiveIdx((cur) => (cur >= idx && cur > 0 ? cur - 1 : cur));
  };

  /** Flatten the active item's strokes into the image (if any), then re-encode
   *  at the chosen quality. Returns the processed file. */
  const exportItem = useCallback(
    async (it: EditItem, isActive: boolean): Promise<MediaEditorResult> => {
      let sourceUri = it.uri;
      // Bake pen strokes by capturing the on-screen ViewShot (active item only;
      // non-active items keep any previously baked strokes in their uri).
      if (isActive && it.strokes.length > 0 && shotRef.current) {
        try {
          sourceUri = await captureRef(shotRef, {
            format: "jpg",
            quality: 1,
          });
        } catch {
          sourceUri = it.uri;
        }
      }
      const maxDim = quality === "hd" ? MAX_HD : MAX_STD;
      const longest = Math.max(it.width, it.height);
      const actions: ImageManipulator.Action[] = [];
      if (longest > maxDim) {
        const scale = maxDim / longest;
        actions.push({
          resize: {
            width: Math.round(it.width * scale),
            height: Math.round(it.height * scale),
          },
        });
      }
      const compress = quality === "hd" ? 0.92 : 0.8;
      const res = await ImageManipulator.manipulateAsync(sourceUri, actions, {
        compress,
        format: ImageManipulator.SaveFormat.JPEG,
      });
      return {
        uri: res.uri,
        fileName: `photo-${Date.now()}.jpg`,
        mimeType: "image/jpeg",
        viewOnce,
        caption,
        width: res.width,
        height: res.height,
      };
    },
    [quality, viewOnce, caption],
  );

  const handleSend = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const results: MediaEditorResult[] = [];
      for (let i = 0; i < items.length; i++) {
        results.push(await exportItem(items[i], i === activeIdx));
      }
      onSend(results);
    } catch {
      setBusy(false);
    }
  };

  if (!active) return null;

  return (
    <Modal visible animationType="fade" onRequestClose={onClose} transparent={false}>
      <View style={styles.container}>
        {/* Top bar */}
        <View style={styles.topBar}>
          <Pressable style={styles.iconBtn} onPress={onClose} hitSlop={8}>
            <X size={22} color="#fff" />
          </Pressable>
          <View style={styles.topRight}>
            <Pressable style={styles.toolBtn} onPress={cropSquare} hitSlop={8}>
              <CropIcon size={20} color="#fff" />
            </Pressable>
            <Pressable style={styles.toolBtn} onPress={rotate} hitSlop={8}>
              <RotateCw size={20} color="#fff" />
            </Pressable>
            <Pressable
              style={[styles.toolBtn, penMode && styles.toolActive]}
              onPress={() => setPenMode((v) => !v)}
              hitSlop={8}
            >
              <Pencil size={20} color={penMode ? "#0b0b0d" : "#fff"} />
            </Pressable>
          </View>
        </View>

        {/* Canvas */}
        <View style={styles.stage}>
          <ViewShot ref={shotRef} style={styles.shot}>
            <View
              style={styles.canvasWrap}
              onStartShouldSetResponder={() => penMode}
              onMoveShouldSetResponder={() => penMode}
              onResponderGrant={onTouchStart}
              onResponderMove={onTouchMove}
              onResponderRelease={onTouchEnd}
            >
              <Image
                source={{ uri: active.uri }}
                style={styles.image}
                resizeMode="contain"
              />
              <Svg style={StyleSheet.absoluteFill}>
                {active.strokes.map((st, i) => (
                  <Path
                    key={i}
                    d={st.d}
                    stroke={st.color}
                    strokeWidth={4}
                    fill="none"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                ))}
                {currentPath ? (
                  <Path
                    d={currentPath}
                    stroke={penColor}
                    strokeWidth={4}
                    fill="none"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                ) : null}
              </Svg>
            </View>
          </ViewShot>
        </View>

        {/* Pen palette */}
        {penMode ? (
          <View style={styles.penBar}>
            {PEN_COLORS.map((c) => (
              <Pressable
                key={c}
                style={[
                  styles.swatch,
                  { backgroundColor: c },
                  penColor === c && styles.swatchActive,
                ]}
                onPress={() => setPenColor(c)}
              />
            ))}
            <Pressable style={styles.penAction} onPress={undoStroke}>
              <Text style={styles.penActionText}>Undo</Text>
            </Pressable>
          </View>
        ) : null}

        {/* Thumbnail tray */}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.tray}
          contentContainerStyle={styles.trayContent}
        >
          {items.map((it, idx) => (
            <Pressable
              key={it.id}
              style={[styles.thumb, idx === activeIdx && styles.thumbActive]}
              onPress={() => setActiveIdx(idx)}
            >
              <Image source={{ uri: it.uri }} style={styles.thumbImg} />
              {items.length > 1 ? (
                <Pressable
                  style={styles.thumbRemove}
                  onPress={() => removeItem(idx)}
                  hitSlop={6}
                >
                  <Trash2 size={12} color="#fff" />
                </Pressable>
              ) : null}
            </Pressable>
          ))}
          <Pressable style={styles.addMore} onPress={addMore}>
            <Plus size={20} color="#fff" />
          </Pressable>
        </ScrollView>

        {/* Options row */}
        <View style={styles.optionsRow}>
          <Pressable
            style={[styles.optionPill, quality === "standard" && styles.optionActive]}
            onPress={() => setQuality("standard")}
          >
            <Text
              style={[
                styles.optionText,
                quality === "standard" && styles.optionTextActive,
              ]}
            >
              Standard
            </Text>
          </Pressable>
          <Pressable
            style={[styles.optionPill, quality === "hd" && styles.optionActive]}
            onPress={() => setQuality("hd")}
          >
            <Text
              style={[styles.optionText, quality === "hd" && styles.optionTextActive]}
            >
              HD
            </Text>
          </Pressable>
          <Pressable
            style={[styles.optionPill, viewOnce && styles.optionActive]}
            onPress={() => setViewOnce((v) => !v)}
          >
            <Timer size={14} color={viewOnce ? "#0b0b0d" : "rgba(255,255,255,0.85)"} />
            <Text style={[styles.optionText, viewOnce && styles.optionTextActive]}>
              {viewOnce ? "View once" : "View \u221e"}
            </Text>
          </Pressable>
        </View>

        {/* Caption + send */}
        <View style={styles.bottomBar}>
          <TextInput
            style={styles.caption}
            placeholder="Add a caption..."
            placeholderTextColor="rgba(255,255,255,0.5)"
            value={caption}
            onChangeText={setCaption}
          />
          <Pressable style={styles.sendBtn} onPress={handleSend} disabled={busy}>
            {busy ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : (
              <Send size={20} color="#fff" />
            )}
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
    container: { flex: 1, backgroundColor: "#0b0b0d" },
    topBar: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingHorizontal: 14,
      paddingTop: 48,
      paddingBottom: 10,
    },
    topRight: { flexDirection: "row", alignItems: "center", gap: 8 },
    iconBtn: {
      width: 40,
      height: 40,
      borderRadius: 20,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: "rgba(255,255,255,0.08)",
    },
    toolBtn: {
      width: 40,
      height: 40,
      borderRadius: 20,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: "rgba(255,255,255,0.08)",
    },
    toolActive: { backgroundColor: "#fff" },
    stage: { flex: 1, alignItems: "center", justifyContent: "center", padding: 8 },
    shot: { flex: 1, width: "100%" },
    canvasWrap: { flex: 1, width: "100%", position: "relative" },
    image: { width: "100%", height: "100%" },
    penBar: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 10,
      paddingVertical: 8,
      flexWrap: "wrap",
    },
    swatch: {
      width: 28,
      height: 28,
      borderRadius: 14,
      borderWidth: 2,
      borderColor: "rgba(255,255,255,0.5)",
    },
    swatchActive: { borderColor: "#fff", transform: [{ scale: 1.15 }] },
    penAction: {
      paddingHorizontal: 14,
      paddingVertical: 8,
      borderRadius: 999,
      backgroundColor: "rgba(255,255,255,0.12)",
    },
    penActionText: { color: "#fff", fontSize: 13 },
    tray: { maxHeight: 70, flexGrow: 0 },
    trayContent: {
      alignItems: "center",
      gap: 8,
      paddingHorizontal: 14,
      paddingVertical: 8,
    },
    thumb: {
      width: 54,
      height: 54,
      borderRadius: 8,
      overflow: "hidden",
      borderWidth: 2,
      borderColor: "transparent",
    },
    thumbActive: { borderColor: "#fff" },
    thumbImg: { width: "100%", height: "100%" },
    thumbRemove: {
      position: "absolute",
      top: 2,
      right: 2,
      width: 18,
      height: 18,
      borderRadius: 9,
      backgroundColor: "rgba(0,0,0,0.6)",
      alignItems: "center",
      justifyContent: "center",
    },
    addMore: {
      width: 54,
      height: 54,
      borderRadius: 8,
      borderWidth: 1.5,
      borderColor: "rgba(255,255,255,0.4)",
      borderStyle: "dashed",
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: "rgba(255,255,255,0.05)",
    },
    optionsRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 8,
      paddingVertical: 6,
    },
    optionPill: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      paddingHorizontal: 14,
      paddingVertical: 7,
      borderRadius: 999,
      borderWidth: 1,
      borderColor: "rgba(255,255,255,0.25)",
    },
    optionActive: { backgroundColor: "#fff", borderColor: "#fff" },
    optionText: { color: "rgba(255,255,255,0.85)", fontSize: 13 },
    optionTextActive: { color: "#0b0b0d", fontWeight: "600" },
    bottomBar: {
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      paddingHorizontal: 14,
      paddingTop: 8,
      paddingBottom: 28,
    },
    caption: {
      flex: 1,
      height: 44,
      borderRadius: 22,
      backgroundColor: "rgba(255,255,255,0.12)",
      color: "#fff",
      paddingHorizontal: 18,
      fontSize: 15,
    },
    sendBtn: {
      width: 48,
      height: 48,
      borderRadius: 24,
      backgroundColor: theme.primary,
      alignItems: "center",
      justifyContent: "center",
    },
  });
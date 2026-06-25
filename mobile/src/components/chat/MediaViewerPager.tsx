import { useMemo, useState } from "react";
import {
  FlatList,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { X } from "lucide-react-native";
import { uploadUrl } from "../../config";
import { fmtDateTime } from "./chatUtils";
import ZoomableImage from "./ZoomableImage";

export type ViewerMediaItem = {
  id: number;
  file_url: string;
  file_name?: string | null;
  sender_name?: string | null;
  created_at: string;
};

/**
 * MediaViewerPager — Signal-style full-screen, swipeable media viewer. A
 * horizontal paging FlatList lets the user swipe between all images/videos in
 * the conversation. Remote uploads go through AuthedImage so the Bearer token
 * is attached (the /uploads route is auth-protected). Tap the X or backdrop to
 * close.
 */
export default function MediaViewerPager({
  items,
  initialIndex,
  onClose,
}: {
  items: ViewerMediaItem[];
  initialIndex: number;
  onClose: () => void;
}) {
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const styles = useMemo(() => makeStyles(), []);
  const [index, setIndex] = useState(initialIndex);
  // While an image is pinched/zoomed past 1× we DISABLE horizontal paging so a
  // pan moves the zoomed image instead of flipping to the next page (Signal
  // MediaPreview parity).
  const [zoomed, setZoomed] = useState(false);

  if (!items.length) return null;
  const current = items[Math.min(index, items.length - 1)];

  return (
    <Modal visible animationType="fade" transparent onRequestClose={onClose}>
      <View style={styles.backdrop}>
        {/* Top bar: caption + close. */}
        <View style={[styles.topBar, { paddingTop: insets.top + 8 }]}>
          <View style={{ flex: 1 }}>
            <Text style={styles.topTitle} numberOfLines={1}>
              {current?.sender_name || "Unknown"}
            </Text>
            <Text style={styles.topSub} numberOfLines={1}>
              {current ? fmtDateTime(current.created_at) : ""}
              {items.length > 1 ? ` · ${index + 1}/${items.length}` : ""}
            </Text>
          </View>
          <Pressable style={styles.closeBtn} onPress={onClose} hitSlop={10}>
            <X size={22} color="#fff" />
          </Pressable>
        </View>

        <FlatList
          data={items}
          horizontal
          pagingEnabled
          scrollEnabled={!zoomed}
          showsHorizontalScrollIndicator={false}
          initialScrollIndex={initialIndex}
          getItemLayout={(_, i) => ({
            length: width,
            offset: width * i,
            index: i,
          })}
          keyExtractor={(it) => String(it.id)}
          onMomentumScrollEnd={(e) => {
            const next = Math.round(e.nativeEvent.contentOffset.x / width);
            if (next !== index) setIndex(next);
          }}
          renderItem={({ item }) => {
            const resolved = uploadUrl(item.file_url) || undefined;
            const isLocal = !!resolved && /^(file|content|data):/i.test(resolved);
            return (
              <View style={{ width, height }}>
                <ZoomableImage
                  uri={resolved}
                  isLocal={isLocal}
                  onZoomChange={setZoomed}
                  onTap={onClose}
                />
              </View>
            );
          }}
        />
      </View>
    </Modal>
  );
}

const makeStyles = () =>
  StyleSheet.create({
    backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.95)" },
    topBar: {
      position: "absolute",
      top: 0,
      left: 0,
      right: 0,
      zIndex: 2,
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      paddingHorizontal: 16,
      paddingBottom: 10,
    },
    topTitle: { color: "#fff", fontSize: 15, fontWeight: "600" },
    topSub: { color: "rgba(255,255,255,0.7)", fontSize: 12, marginTop: 2 },
    closeBtn: {
      width: 40,
      height: 40,
      borderRadius: 20,
      backgroundColor: "rgba(255,255,255,0.15)",
      alignItems: "center",
      justifyContent: "center",
    },
    pageCenter: { flex: 1, alignItems: "center", justifyContent: "center" },
    image: { width: "100%", height: "85%" },
  });
import { useMemo } from "react";
import {
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Animated, { FadeIn, FadeOut } from "react-native-reanimated";
import {
  FolderOpen,
  Pin,
  Search,
  Star,
  Trash2,
} from "lucide-react-native";
import type { Theme } from "../../theme";
import { useTheme } from "../../theme/ThemeProvider";

/**
 * HeaderMenuPopup — a Signal-Android-style overflow menu anchored to the
 * top-right under the header's ⋮ button (replaces the old bottom sheet). A
 * transparent scrim dismisses on outside-tap; the menu card fades/scales in.
 *
 * Each item is a navigation/action trigger — the heavy panels (search, shared
 * media, saved) now live in the conversation profile screen.
 */
export default function HeaderMenuPopup({
  visible,
  onClose,
  onSearch,
  onPinned,
  onSharedMedia,
  onSaved,
  onClearChat,
}: {
  visible: boolean;
  onClose: () => void;
  onSearch: () => void;
  onPinned: () => void;
  onSharedMedia: () => void;
  onSaved: () => void;
  onClearChat: () => void;
}) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const styles = useMemo(() => makeStyles(theme), [theme]);

  const run = (fn: () => void) => () => {
    onClose();
    // Defer the action a tick so the popup dismiss never races a screen push /
    // confirm dialog on Android.
    setTimeout(fn, 60);
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="none"
      onRequestClose={onClose}
    >
      <Pressable style={styles.scrim} onPress={onClose}>
        <Animated.View
          entering={FadeIn.duration(120)}
          exiting={FadeOut.duration(100)}
          style={[styles.card, { top: insets.top + 6 }]}
          // Stop the scrim's onPress from firing when tapping inside the card.
          onStartShouldSetResponder={() => true}
        >
          <MenuRow
            icon={<Search size={19} color={theme.text} />}
            label="Search"
            onPress={run(onSearch)}
            styles={styles}
          />
          <MenuRow
            icon={<Pin size={19} color={theme.text} />}
            label="Pinned messages"
            onPress={run(onPinned)}
            styles={styles}
          />
          <MenuRow
            icon={<FolderOpen size={19} color={theme.text} />}
            label="Shared media"
            onPress={run(onSharedMedia)}
            styles={styles}
          />
          <MenuRow
            icon={<Star size={19} color={theme.text} />}
            label="Saved messages"
            onPress={run(onSaved)}
            styles={styles}
          />
          <View style={styles.divider} />
          <MenuRow
            icon={<Trash2 size={19} color={theme.danger} />}
            label="Clear chat"
            danger
            onPress={run(onClearChat)}
            styles={styles}
          />
        </Animated.View>
      </Pressable>
    </Modal>
  );
}

function MenuRow({
  icon,
  label,
  danger,
  onPress,
  styles,
}: {
  icon: React.ReactNode;
  label: string;
  danger?: boolean;
  onPress: () => void;
  styles: ReturnType<typeof makeStyles>;
}) {
  return (
    <Pressable
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
      onPress={onPress}
    >
      {icon}
      <Text style={[styles.rowText, danger && styles.rowTextDanger]}>
        {label}
      </Text>
    </Pressable>
  );
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
    scrim: {
      flex: 1,
      backgroundColor: "rgba(0,0,0,0.25)",
    },
    card: {
      position: "absolute",
      right: 8,
      minWidth: 220,
      backgroundColor: theme.bgElevated,
      borderRadius: 14,
      borderWidth: 1,
      borderColor: theme.glassBorder,
      paddingVertical: 6,
      shadowColor: "#000",
      shadowOpacity: 0.4,
      shadowRadius: 16,
      shadowOffset: { width: 0, height: 6 },
      elevation: 12,
    },
    row: {
      flexDirection: "row",
      alignItems: "center",
      gap: 14,
      paddingHorizontal: 16,
      paddingVertical: 13,
    },
    rowPressed: { backgroundColor: theme.surfaceHover },
    rowText: {
      fontSize: 15,
      color: theme.text,
      fontFamily: theme.fontMedium,
    },
    rowTextDanger: { color: theme.danger },
    divider: {
      height: 1,
      backgroundColor: theme.border,
      marginVertical: 4,
      marginHorizontal: 12,
    },
  });
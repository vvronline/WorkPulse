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
import type { Theme } from "../../theme";
import { useTheme } from "../../theme/ThemeProvider";

/**
 * HeaderMenuPopup — a Signal-Android-style overflow menu anchored to the
 * top-right just BELOW the header's ⋮ button (never overlapping the header). A
 * transparent scrim dismisses on outside-tap; the menu card fades in.
 *
 * Signal's overflow menu is a compact, TEXT-ONLY popup (no leading icons), so
 * the rows here are tightened and icon-free.
 */
export default function HeaderMenuPopup({
  visible,
  onClose,
  onSearch,
  onPinned,
  onSharedMedia,
  onSaved,
  onClearChat,
  onToggleBlock,
  isBlocked,
}: {
  visible: boolean;
  onClose: () => void;
  onSearch: () => void;
  onPinned: () => void;
  onSharedMedia: () => void;
  onSaved: () => void;
  onClearChat: () => void;
  /** Block/unblock the peer (direct chats only — omit for groups). */
  onToggleBlock?: () => void;
  isBlocked?: boolean;
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

  // Drop the card just UNDER the header bar. The native stack header is ~56dp
  // tall and sits below the status-bar inset — anchoring at the inset alone
  // (the old behaviour) made the card overlap the header.
  const HEADER_HEIGHT = 56;

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
          style={[styles.card, { top: insets.top + HEADER_HEIGHT + 4 }]}
          // Stop the scrim's onPress from firing when tapping inside the card.
          onStartShouldSetResponder={() => true}
        >
          <MenuRow label="Search" onPress={run(onSearch)} styles={styles} />
          <MenuRow
            label="Pinned messages"
            onPress={run(onPinned)}
            styles={styles}
          />
          <MenuRow
            label="Shared media"
            onPress={run(onSharedMedia)}
            styles={styles}
          />
          <MenuRow
            label="Saved messages"
            onPress={run(onSaved)}
            styles={styles}
          />
          <View style={styles.divider} />
          {onToggleBlock ? (
            <MenuRow
              label={isBlocked ? "Unblock user" : "Block user"}
              danger={!isBlocked}
              onPress={run(onToggleBlock)}
              styles={styles}
            />
          ) : null}
          <MenuRow
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
  label,
  danger,
  onPress,
  styles,
}: {
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
      minWidth: 180,
      backgroundColor: theme.bgElevated,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: theme.glassBorder,
      paddingVertical: 4,
      shadowColor: "#000",
      shadowOpacity: 0.4,
      shadowRadius: 16,
      shadowOffset: { width: 0, height: 6 },
      elevation: 12,
    },
    row: {
      paddingHorizontal: 16,
      paddingVertical: 11,
    },
    rowPressed: { backgroundColor: theme.surfaceHover },
    rowText: {
      fontSize: 14,
      color: theme.text,
      fontFamily: theme.fontMedium,
    },
    rowTextDanger: { color: theme.danger },
    divider: {
      height: 1,
      backgroundColor: theme.border,
      marginVertical: 3,
      marginHorizontal: 10,
    },
  });
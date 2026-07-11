import { useMemo } from "react";
import { Modal, Pressable, StyleSheet, View } from "react-native";
import type { Theme } from "../../theme";
import { useTheme } from "../../theme/ThemeProvider";

/**
 * Shared bottom-sheet wrapper with a simple controlled `visible` / `onClose`
 * API. Prefers `@expo/ui`'s native bottom sheet (SwiftUI `.sheet` on iOS,
 * Material 3 `ModalBottomSheet` on Android — real platform detents, drag
 * indicator and swipe-to-dismiss) and falls back to the app's themed JS `Modal`
 * bottom-sheet when `@expo/ui` isn't available at runtime.
 *
 * This replaces the repeated hand-rolled `Modal` + backdrop + `stopPropagation`
 * boilerplate scattered across the chat/action sheets.
 */

export interface NativeBottomSheetProps {
  visible: boolean;
  onClose: () => void;
  children: React.ReactNode;
  /** Fixed snap points (e.g. ["50%"]). Omit for content-sized (dynamic) sheet. */
  snapPoints?: (string | number)[];
  /** Background color of the sheet surface. Defaults to theme.bgElevated. */
  backgroundColor?: string;
}

// --- Safe optional import of @expo/ui bottom sheet --------------------------
type ExpoUiBottomSheetProps = {
  index?: number;
  snapPoints?: (string | number)[];
  enablePanDownToClose?: boolean;
  enableDynamicSizing?: boolean;
  onClose?: () => void;
  onDismiss?: () => void;
  backgroundStyle?: object;
  children?: React.ReactNode;
};

type NativeSheetModule = {
  available: boolean;
  BottomSheet: React.ComponentType<ExpoUiBottomSheetProps> | null;
  BottomSheetView: React.ComponentType<{
    children?: React.ReactNode;
    style?: object;
  }> | null;
};

const NativeSheet: NativeSheetModule = (() => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require("@expo/ui/community/bottom-sheet");
    const BottomSheet = mod?.BottomSheet ?? mod?.default ?? null;
    const BottomSheetView = mod?.BottomSheetView ?? null;
    return { available: !!BottomSheet, BottomSheet, BottomSheetView };
  } catch {
    return { available: false, BottomSheet: null, BottomSheetView: null };
  }
})();

export const nativeBottomSheetAvailable = NativeSheet.available;

export default function NativeBottomSheet({
  visible,
  onClose,
  children,
  snapPoints,
  backgroundColor,
}: NativeBottomSheetProps) {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const bg = backgroundColor ?? theme.bgElevated;
  const { BottomSheet, BottomSheetView } = NativeSheet;

  if (BottomSheet) {
    // Native path: `index` drives visibility (-1 closed, 0 open). `onClose`
    // fires on swipe-down / scrim tap / back button as well as programmatic.
    const Inner = BottomSheetView ?? View;
    return (
      <BottomSheet
        index={visible ? 0 : -1}
        snapPoints={snapPoints}
        enableDynamicSizing={!snapPoints || snapPoints.length === 0}
        enablePanDownToClose
        onClose={onClose}
        backgroundStyle={{ backgroundColor: bg }}
      >
        <Inner style={styles.nativeContent}>{children}</Inner>
      </BottomSheet>
    );
  }

  // Fallback: themed JS Modal bottom-sheet (mirrors the previous hand-rolled UX).
  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      <Pressable style={styles.overlay} onPress={onClose}>
        <Pressable
          style={[styles.sheet, { backgroundColor: bg }]}
          onPress={(e) => e.stopPropagation()}
        >
          {children}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
    nativeContent: {
      paddingBottom: 28,
    },
    overlay: {
      flex: 1,
      backgroundColor: "rgba(0,0,0,0.5)",
      justifyContent: "flex-end",
    },
    sheet: {
      backgroundColor: theme.bgElevated,
      borderTopLeftRadius: 18,
      borderTopRightRadius: 18,
      paddingVertical: 8,
      paddingBottom: 28,
    },
  });
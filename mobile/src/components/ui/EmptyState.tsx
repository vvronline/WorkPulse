/**
 * Empty / error state.
 *
 * Most lists in the app currently render a bare centred `<Text>` when there's
 * nothing to show, which reads as a bug rather than a deliberate state. This
 * gives every zero-data surface the same shape: icon, headline, one line of
 * explanation, and (optionally) the single action that resolves it.
 */

import { useMemo } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { Theme } from "../../theme";
import { useTheme } from "../../theme/ThemeProvider";
import { haptics } from "../../lib/haptics";

type EmptyStateProps = {
  /**
   * Icon element (e.g. a heroicon). Rendered inside a tinted circle. Size it
   * ~28pt; the container handles the surrounding treatment.
   */
  icon?: React.ReactNode;
  /** Short headline — what's missing. Sentence case, no trailing period. */
  title: string;
  /** One sentence explaining why it's empty or what to do next. */
  description?: string;
  /** Label for the primary action. Omit to render an action-less state. */
  actionLabel?: string;
  onAction?: () => void;
  /**
   * Error styling: tints the icon circle with the danger colour and labels the
   * action as a retry. Use for failed loads rather than genuinely empty data —
   * conflating the two makes outages look like empty inboxes.
   */
  variant?: "empty" | "error";
};

export default function EmptyState({
  icon,
  title,
  description,
  actionLabel,
  onAction,
  variant = "empty",
}: EmptyStateProps) {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const isError = variant === "error";

  return (
    <View style={styles.container}>
      {icon ? (
        <View style={[styles.iconCircle, isError && styles.iconCircleError]}>
          {icon}
        </View>
      ) : null}

      <Text style={styles.title}>{title}</Text>

      {description ? (
        <Text style={styles.description}>{description}</Text>
      ) : null}

      {actionLabel && onAction ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={actionLabel}
          onPress={() => {
            haptics.light();
            onAction();
          }}
          style={({ pressed }) => [styles.action, pressed && styles.actionPressed]}
        >
          <Text style={styles.actionText}>{actionLabel}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
    container: {
      alignItems: "center",
      justifyContent: "center",
      paddingVertical: theme.space.xxl,
      paddingHorizontal: theme.space.xl,
      gap: theme.space.md,
    },
    iconCircle: {
      width: 64,
      height: 64,
      borderRadius: theme.radiusFull,
      backgroundColor: theme.surface,
      borderWidth: 1,
      borderColor: theme.border,
      alignItems: "center",
      justifyContent: "center",
      marginBottom: theme.space.xs,
    },
    iconCircleError: {
      backgroundColor: theme.primaryGlow,
      borderColor: theme.danger,
    },
    title: {
      ...theme.type.heading,
      fontFamily: theme.fontSemiBold,
      color: theme.text,
      textAlign: "center",
    },
    description: {
      ...theme.type.callout,
      color: theme.textMuted,
      textAlign: "center",
      // Keep the copy to a readable measure instead of letting it run the full
      // width of a tablet/landscape screen.
      maxWidth: 300,
    },
    action: {
      marginTop: theme.space.sm,
      paddingVertical: theme.space.md,
      paddingHorizontal: theme.space.xl,
      borderRadius: theme.radiusFull,
      backgroundColor: theme.primary,
      // Comfortably above the 44pt minimum touch target.
      minHeight: 44,
      justifyContent: "center",
    },
    actionPressed: { opacity: 0.75 },
    actionText: {
      ...theme.type.body,
      fontFamily: theme.fontSemiBold,
      color: theme.onAccent,
    },
  });
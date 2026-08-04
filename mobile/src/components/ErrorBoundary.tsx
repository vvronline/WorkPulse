import React from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { theme as staticTheme } from "../theme";
import { logError } from "../utils/logError";

/**
 * App-wide React error boundary.
 *
 * The app previously had NO error boundary anywhere (zero `componentDidCatch`
 * implementations). In React 18+, an uncaught render error UNMOUNTS THE WHOLE
 * TREE — so a single bad render in any one of the large screens produced a
 * permanently blank white screen with no way back except force-quitting the
 * app, and (with no crash reporter wired up) no record that it ever happened.
 *
 * This boundary contains the blast radius: it renders a themed fallback with a
 * "Try again" action that remounts the subtree, and routes the error through
 * `logError` so a reporter installed later picks it up automatically.
 *
 * DELIBERATELY A CLASS: `componentDidCatch` / `getDerivedStateFromError` have
 * no hooks equivalent — this is the one place React still requires a class.
 *
 * It also uses the STATIC theme rather than `useTheme()`: the boundary must be
 * able to render even when the failure came from inside ThemeProvider itself.
 */

type Props = {
  children: React.ReactNode;
  /** Identifies the guarded region in error reports, e.g. "root". */
  scope?: string;
  /** Custom fallback. Receives the error and a reset callback. */
  fallback?: (error: Error, reset: () => void) => React.ReactNode;
  /** Notified on every caught error (in addition to `logError`). */
  onError?: (error: Error, info: React.ErrorInfo) => void;
};

type State = { error: Error | null };

export default class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    logError(`errorBoundary.${this.props.scope ?? "unknown"}`, error, {
      componentStack: info.componentStack,
    });
    try {
      this.props.onError?.(error, info);
    } catch {
      // A failing onError handler must not re-enter the boundary.
    }
  }

  private reset = () => {
    this.setState({ error: null });
  };

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    if (this.props.fallback) {
      return this.props.fallback(error, this.reset);
    }

    return (
      <View style={styles.container}>
        <ScrollView
          contentContainerStyle={styles.content}
          showsVerticalScrollIndicator={false}
        >
          <Text style={styles.title}>Something went wrong</Text>
          <Text style={styles.body}>
            The screen ran into an unexpected problem. You can try again — your
            data is safe.
          </Text>
          {/* Surface the message in dev only: release users get a clean
              message, developers get the actual failure without a rebuild. */}
          {__DEV__ ? (
            <Text style={styles.detail} selectable>
              {error.message}
            </Text>
          ) : null}
          <Pressable
            accessibilityRole="button"
            style={styles.button}
            onPress={this.reset}
          >
            <Text style={styles.buttonText}>Try again</Text>
          </Pressable>
        </ScrollView>
      </View>
    );
  }
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: staticTheme.bg },
  content: {
    flexGrow: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
    gap: 12,
  },
  title: {
    color: staticTheme.text,
    fontSize: 20,
    fontWeight: "600",
    textAlign: "center",
  },
  body: {
    color: staticTheme.textMuted,
    fontSize: 14,
    lineHeight: 20,
    textAlign: "center",
  },
  detail: {
    color: staticTheme.danger,
    fontSize: 12,
    fontFamily: "monospace",
    textAlign: "center",
    marginTop: 4,
  },
  button: {
    marginTop: 12,
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 8,
    backgroundColor: staticTheme.primary,
  },
  buttonText: { color: "#ffffff", fontSize: 15, fontWeight: "600" },
});

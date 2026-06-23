import "react-native-gesture-handler";
import { useEffect } from "react";
import { Text as RNText, TextInput as RNTextInput } from "react-native";
import { useFonts } from "expo-font";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { interFontMap, FONTS } from "../src/fonts";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { AuthProvider } from "../src/auth/AuthContext";
import ImpersonationBanner from "../src/components/ImpersonationBanner";
import UpdateChecker from "../src/components/UpdateChecker";
import IncomingCallListener from "../src/realtime/IncomingCallListener";
import MeetingStartedListener from "../src/realtime/MeetingStartedListener";
import RealtimeSoundListener from "../src/realtime/RealtimeSoundListener";
import PushNotificationListener from "../src/realtime/PushNotificationListener";
import PushNotificationInitializer from "../src/realtime/PushNotificationInitializer";
import PendingCallNavigator from "../src/realtime/PendingCallNavigator";
import OngoingCallBanner from "../src/realtime/OngoingCallBanner";
import { ThemeProvider, useTheme } from "../src/theme/ThemeProvider";
import { nativeCallService } from "../src/services/nativeCallService";
import { backgroundPushService } from "../src/services/backgroundPushService";
import { notifeeService } from "../src/services/notifeeService";
import { ensureCallMediaPermissions } from "../src/services/mediaPermissions";
import { warmIceConfig } from "../src/features";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, staleTime: 30_000 },
  },
});

/**
 * Themed navigation stack. Lives inside ThemeProvider so header colours track
 * the tenant's accent reactively.
 */
function ThemedStack() {
  const theme = useTheme();
  const headerScreen = {
    headerShown: true as const,
    headerStyle: { backgroundColor: theme.bgSecondary },
    headerTitleStyle: { color: theme.text },
    headerTintColor: theme.primary,
    headerShadowVisible: false,
  };
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: theme.bg },
      }}
    >
      <Stack.Screen name="index" />
      <Stack.Screen name="login" />
      <Stack.Screen name="(tabs)" />
      <Stack.Screen
        name="notifications"
        options={{ ...headerScreen, title: "Notifications" }}
      />
      <Stack.Screen
        name="profile"
        options={{ ...headerScreen, title: "Profile" }}
      />
      <Stack.Screen
        name="profile/face"
        options={{ ...headerScreen, title: "Face Enrollment" }}
      />
      <Stack.Screen name="chat/[id]" options={headerScreen} />
      <Stack.Screen
        name="chat/new"
        options={{ ...headerScreen, title: "New Chat" }}
      />
      <Stack.Screen
        name="call/[conversationId]"
        options={{
          headerShown: false,
          animation: "fade",
          presentation: "fullScreenModal",
        }}
      />
      <Stack.Screen
        name="leaves/apply"
        options={{ ...headerScreen, title: "Apply for Leave" }}
      />
      <Stack.Screen
        name="tasks/new"
        options={{ ...headerScreen, title: "New Task" }}
      />
      <Stack.Screen name="tasks/[id]" options={headerScreen} />
      <Stack.Screen
        name="sprints/insights"
        options={{ ...headerScreen, title: "Sprint Insights" }}
      />
      {/* Notes is a route group with its own _layout (NotesProvider + headers). */}
      <Stack.Screen name="notes" options={{ headerShown: false }} />
      <Stack.Screen
        name="attendance"
        options={{ ...headerScreen, title: "Attendance" }}
      />
      <Stack.Screen
        name="team"
        options={{ ...headerScreen, title: "My Team" }}
      />
      <Stack.Screen
        name="member/[userId]"
        options={{ ...headerScreen, title: "Member" }}
      />
      <Stack.Screen
        name="organization"
        options={{ ...headerScreen, title: "Organization" }}
      />
      <Stack.Screen
        name="meeting/[code]"
        options={{ ...headerScreen, title: "Meeting" }}
      />
      {/* Admin panel + Platform Console (headers driven by each screen's
          inline <Stack.Screen options>). */}
      <Stack.Screen
        name="admin/index"
        options={{ ...headerScreen, title: "Admin Panel" }}
      />
      <Stack.Screen name="admin/home" options={headerScreen} />
      <Stack.Screen name="admin/users" options={headerScreen} />
      <Stack.Screen name="admin/user/[id]" options={headerScreen} />
      <Stack.Screen name="admin/role-requests" options={headerScreen} />
      <Stack.Screen name="admin/departments" options={headerScreen} />
      <Stack.Screen name="admin/teams" options={headerScreen} />
      <Stack.Screen name="admin/org-settings" options={headerScreen} />
      <Stack.Screen name="admin/add-people" options={headerScreen} />
      <Stack.Screen name="admin/platform-access" options={headerScreen} />
      <Stack.Screen name="admin/audit" options={headerScreen} />
      <Stack.Screen name="admin/org-chart" options={headerScreen} />
      <Stack.Screen name="admin/projects" options={headerScreen} />
      <Stack.Screen name="admin/payroll" options={headerScreen} />
      <Stack.Screen name="admin/agile" options={headerScreen} />
      <Stack.Screen name="admin/integrations" options={headerScreen} />
      <Stack.Screen name="admin/compensation" options={headerScreen} />
      <Stack.Screen name="admin/salary-slips" options={headerScreen} />
      <Stack.Screen name="admin/payment-settings" options={headerScreen} />
      <Stack.Screen
        name="tenants/index"
        options={{ ...headerScreen, title: "Platform Console" }}
      />
      <Stack.Screen name="tenants/dashboard" options={headerScreen} />
      <Stack.Screen name="tenants/list" options={headerScreen} />
      <Stack.Screen name="tenants/[id]" options={headerScreen} />
      <Stack.Screen name="tenants/create" options={headerScreen} />
      <Stack.Screen name="tenants/plans" options={headerScreen} />
      <Stack.Screen name="tenants/admins" options={headerScreen} />
      <Stack.Screen name="tenants/settings" options={headerScreen} />
      <Stack.Screen name="tenants/audit" options={headerScreen} />
    </Stack>
  );
}

// Apply Inter (Signal's typeface) as the DEFAULT family for every <Text> and
// <TextInput> that doesn't override `fontFamily`. Setting it via defaultProps
// once (module scope) is the standard RN way to theme typography app-wide
// without touching every component. Individual styles can still override the
// weight by setting an explicit Inter family token from the theme.
function applyDefaultFont() {
  const text = RNText as unknown as { defaultProps?: Record<string, unknown> };
  text.defaultProps = text.defaultProps || {};
  text.defaultProps.style = [
    { fontFamily: FONTS.regular },
    text.defaultProps.style,
  ];
  const input = RNTextInput as unknown as {
    defaultProps?: Record<string, unknown>;
  };
  input.defaultProps = input.defaultProps || {};
  input.defaultProps.style = [
    { fontFamily: FONTS.regular },
    input.defaultProps.style,
  ];
}

export default function RootLayout() {
  // Load the Inter font family before rendering the app so text never flashes
  // in the system font first. We still render once loaded OR errored so a font
  // CDN hiccup can never permanently block the app (it just falls back to the
  // system font).
  const [fontsLoaded, fontError] = useFonts(interFontMap);

  useEffect(() => {
    if (fontsLoaded) applyDefaultFont();
  }, [fontsLoaded]);

  useEffect(() => {
    // Foreground CallKeep setup. The FCM background message handler is
    // registered at the JS entry top-level (see `mobile/index.js`) so it also
    // runs when the app is killed.
    nativeCallService.initialize();
    // Mark the app as fully BOOTED in THIS JS runtime. The background push
    // handler uses this to distinguish a backgrounded-but-alive app (quiet
    // heads-up incoming-call notification) from a killed/headless FCM task
    // (full-screen ringing over the lock screen) — AppState reports
    // "background" for both, so the boot flag is the only reliable signal.
    backgroundPushService.markAppBooted();
    // Belt-and-suspenders: also register the FCM handler here (idempotent) so
    // warm foreground/background-but-alive launches are covered even if the
    // custom entry point is ever bypassed. The killed/headless state is still
    // handled by `mobile/index.js`.
    backgroundPushService.initialize();
    // Foreground FCM message handler. The server sends DATA-ONLY pushes (so the
    // background/headless handler always runs); without this, foreground
    // message/notification pushes are silently dropped (no status-bar entry).
    backgroundPushService.registerForegroundHandler();
    // Notifee foreground event handler: handles Answer/Decline taps on the
    // full-screen incoming-call notification while the app is alive.
    const unsubscribeNotifee = notifeeService.registerForegroundHandler();
    // Ensure Notifee can post visible status-bar/full-screen notifications too.
    // Expo permission alone is not enough for Notifee-rendered data pushes on
    // Android 13+.
    notifeeService.requestNotificationPermission().catch(() => {});
    // Ensure Android 14+ full-screen-intent permission so the incoming-call
    // screen can surface over the lock screen (otherwise only the ring sound
    // plays and the user must open the app to answer/reject).
    notifeeService.ensureFullScreenIntentPermission().catch(() => {});
    // Proactively request CAMERA + RECORD_AUDIO while the app is in the
    // foreground. When a call is later answered from the background / lock
    // screen, Android can't show a runtime permission dialog — without this the
    // call would connect with no camera/mic (black self-view, peer sees
    // nothing). Granting up front makes the background/lock-screen answer work.
    ensureCallMediaPermissions().catch(() => {});
    // Pre-warm the ICE config (TURN credentials) once at startup so the call
    // screen can read it from cache and skip the per-call wait — shaving the
    // connection-setup delay (see src/features.ts getCachedIceConfig).
    warmIceConfig().catch(() => {});
    return () => {
      backgroundPushService.unregisterForegroundHandler();
      unsubscribeNotifee();
    };
  }, []);

  // Hold rendering until fonts resolve (or error out) so the first paint uses
  // Inter. `null` here is fine — Expo keeps the native splash up until the tree
  // mounts.
  if (!fontsLoaded && !fontError) return null;

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <ThemeProvider>
            <SafeAreaProvider>
              <StatusBar style="light" />
              <PushNotificationInitializer />
              <IncomingCallListener />
              <MeetingStartedListener />
              <RealtimeSoundListener />
              <PushNotificationListener />
              <PendingCallNavigator />
              <OngoingCallBanner />
              <ImpersonationBanner />
              <UpdateChecker />
              <ThemedStack />
            </SafeAreaProvider>
          </ThemeProvider>
        </AuthProvider>
      </QueryClientProvider>
    </GestureHandlerRootView>
  );
}
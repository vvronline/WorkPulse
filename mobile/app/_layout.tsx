import "react-native-gesture-handler";
import { useEffect, useState } from "react";
import {
  InteractionManager,
  Platform,
  Text as RNText,
  TextInput as RNTextInput,
} from "react-native";
import { useFonts } from "expo-font";
import * as SplashScreen from "expo-splash-screen";
import { QueryClient } from "@tanstack/react-query";
import { PersistQueryClientProvider } from "@tanstack/react-query-persist-client";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { interFontMap, FONTS } from "../src/fonts";
import { mmkvQueryPersister } from "../src/storage/queryPersister";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { AuthProvider } from "../src/auth/AuthContext";
import ImpersonationBanner from "../src/components/ImpersonationBanner";
import UpdateChecker from "../src/components/UpdateChecker";
import AnimatedSplash from "../src/components/AnimatedSplash";
import IncomingCallListener from "../src/realtime/IncomingCallListener";
import MeetingStartedListener from "../src/realtime/MeetingStartedListener";
import RealtimeSoundListener from "../src/realtime/RealtimeSoundListener";
import PushNotificationListener from "../src/realtime/PushNotificationListener";
import PushNotificationInitializer from "../src/realtime/PushNotificationInitializer";
import PendingCallNavigator from "../src/realtime/PendingCallNavigator";
import PendingChatNavigator from "../src/realtime/PendingChatNavigator";
import ChatCacheSync from "../src/realtime/ChatCacheSync";
import ChatOutboxSync from "../src/realtime/ChatOutboxSync";
import OngoingCallBanner from "../src/realtime/OngoingCallBanner";
import { ThemeProvider, useTheme } from "../src/theme/ThemeProvider";
import { nativeCallService } from "../src/services/nativeCallService";
import { backgroundPushService } from "../src/services/backgroundPushService";
import { notifeeService } from "../src/services/notifeeService";
import { notificationMetricsSync } from "../src/services/notificationMetricsSync";
import { ensureCallMediaPermissions } from "../src/services/mediaPermissions";
import { warmIceConfig } from "../src/features";
import {
  installThemedAlertBridge,
  ThemedAlertHost,
} from "../src/dialogs/themedAlertBridge";

// Keep cached data for 24h so a killed-state relaunch can paint instantly from
// the persisted MMKV cache (stale-while-revalidate) instead of spinning while
// every screen re-fetches. `staleTime` controls how long cached data is served
// before a background refetch; `gcTime` must be >= the persister maxAge or the
// in-memory entry would be garbage-collected before it's restored.
const ONE_DAY = 24 * 60 * 60 * 1000;
const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, staleTime: 60_000, gcTime: ONE_DAY },
  },
});

// Keep the NATIVE splash up until our JS-rendered AnimatedSplash overlay has
// mounted, so the static native splash hands off to the animated "loops"
// wordmark with no white flash in between. Best-effort; ignore if it races.
SplashScreen.preventAutoHideAsync().catch(() => {});

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
        name="search"
        options={{ ...headerScreen, title: "Search" }}
      />
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
      <Stack.Screen
        name="chat/[id]"
        options={{
          ...headerScreen,
          // Signal-style smooth open: iOS-style push everywhere with a short,
          // tuned duration + full-screen swipe-back. `freezeOnBlur` stops the
          // (heavy) chat list re-rendering underneath while the thread is on
          // top, which is what used to make the slide-in stutter.
          animation: "slide_from_right",
          animationDuration: 220,
          fullScreenGestureEnabled: true,
          freezeOnBlur: true,
        }}
      />
      <Stack.Screen
        name="chat/new"
        options={{ ...headerScreen, title: "New Chat" }}
      />
      <Stack.Screen
        name="chat/info"
        options={{ ...headerScreen, title: "Conversation info" }}
      />
      <Stack.Screen
        name="chat/group"
        options={{ ...headerScreen, title: "Group settings" }}
      />
      <Stack.Screen
        name="chat/shared"
        options={{ ...headerScreen, title: "Shared media" }}
      />
      <Stack.Screen
        name="chat/search"
        options={{ ...headerScreen, title: "Search" }}
      />
      <Stack.Screen
        name="chat/saved"
        options={{ ...headerScreen, title: "Saved messages" }}
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
        name="group-call/ring"
        options={{
          headerShown: false,
          animation: "fade",
          presentation: "fullScreenModal",
        }}
      />
      <Stack.Screen
        name="call-info/[callId]"
        options={{ ...headerScreen, title: "Call info" }}
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

// On Android the Inter/Pacifico TTFs are EMBEDDED into the native build via
// the expo-font config plugin (see app.config.ts), so every fontFamily is
// resolvable at t=0 — the first render must NOT block on the async runtime
// loader. iOS/Expo Go still load at runtime via useFonts below.
const FONTS_EMBEDDED = Platform.OS === "android";

export default function RootLayout() {
  // Load the Inter font family before rendering the app so text never flashes
  // in the system font first (runtime path — iOS/Expo Go). On Android the
  // fonts are embedded natively, so this resolves instantly/no-ops and never
  // gates the first render. We still render once loaded OR errored so a font
  // hiccup can never permanently block the app (it just falls back to the
  // system font).
  const [fontsLoaded, fontError] = useFonts(interFontMap);

  // Controls the JS-rendered AnimatedSplash overlay (logo + animated "loops"
  // Pacifico wordmark). It stays mounted on top of the app until its own
  // fade-out animation finishes and calls onDone.
  const [splashDone, setSplashDone] = useState(false);

  // Apply the default font immediately when embedded (Android), otherwise as
  // soon as the runtime loader finishes.
  useEffect(() => {
    if (FONTS_EMBEDDED || fontsLoaded) applyDefaultFont();
  }, [fontsLoaded]);

  // Once fonts are ready (or errored / embedded), the app tree mounts — hide
  // the NATIVE splash so the JS AnimatedSplash overlay (same #0a0e1c
  // background) takes over and plays the "loops" text animation.
  useEffect(() => {
    if (FONTS_EMBEDDED || fontsLoaded || fontError) {
      SplashScreen.hideAsync().catch(() => {});
    }
  }, [fontsLoaded, fontError]);

  useEffect(() => {
    installThemedAlertBridge();
  }, []);

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
    // IMPORTANT: The foreground FCM message handler is now registered at the
    // JS entry top-level in `mobile/index.js` (before React boots) to guarantee
    // it's ready for any messages that arrive while the app is in the foreground.
    // This call here is now a no-op (idempotent) but left as documentation and
    // safety net in case index.js registration fails.
    // The handler is async, but we don't need to await it here since it was
    // already awaited in index.js.
    backgroundPushService.registerForegroundHandler().catch(() => {
      // Silent fail: background handler still works even if foreground fails
    });
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
    // ── DEFERRED (cold-start perf) ──
    // None of the below is needed for the first frame. Running them inline
    // used to compete with the initial render/route decision on the JS thread.
    // InteractionManager waits for the current interactions/animations (the
    // splash fade, first navigation) to finish before firing.
    const deferred = InteractionManager.runAfterInteractions(() => {
      // Proactively request CAMERA + RECORD_AUDIO while the app is in the
      // foreground. When a call is later answered from the background / lock
      // screen, Android can't show a runtime permission dialog — without this
      // the call would connect with no camera/mic (black self-view, peer sees
      // nothing). Granting up front makes the background/lock-screen answer work.
      ensureCallMediaPermissions().catch(() => {});
      // Pre-warm the ICE config (TURN credentials) once at startup so the call
      // screen can read it from cache and skip the per-call wait — shaving the
      // connection-setup delay (see src/features.ts getCachedIceConfig).
      warmIceConfig().catch(() => {});
      notificationMetricsSync.queueSync(3000);
    });
    const notificationMetricsInterval = setInterval(() => {
      notificationMetricsSync.queueSync();
    }, 60_000);
    return () => {
      deferred.cancel();
      clearInterval(notificationMetricsInterval);
      backgroundPushService.unregisterForegroundHandler();
      unsubscribeNotifee();
    };
  }, []);

  // Hold rendering until fonts resolve (or error out) so the first paint uses
  // Inter — RUNTIME path only (iOS/Expo Go). On Android the fonts are embedded
  // natively, so the first paint proceeds immediately. `null` here is fine —
  // Expo keeps the native splash up until the tree mounts.
  if (!FONTS_EMBEDDED && !fontsLoaded && !fontError) return null;

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <PersistQueryClientProvider
        client={queryClient}
        persistOptions={{ persister: mmkvQueryPersister, maxAge: ONE_DAY }}
      >
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
              <PendingChatNavigator />
              <ChatCacheSync />
              <ChatOutboxSync />
              <OngoingCallBanner />
              <ImpersonationBanner />
              <UpdateChecker />
              <ThemedStack />
              <ThemedAlertHost />
              {!splashDone ? (
                <AnimatedSplash onDone={() => setSplashDone(true)} />
              ) : null}
            </SafeAreaProvider>
          </ThemeProvider>
        </AuthProvider>
      </PersistQueryClientProvider>
    </GestureHandlerRootView>
  );
}

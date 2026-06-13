import "react-native-gesture-handler";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { AuthProvider } from "../src/auth/AuthContext";
import ImpersonationBanner from "../src/components/ImpersonationBanner";
import IncomingCallListener from "../src/realtime/IncomingCallListener";
import { ThemeProvider, useTheme } from "../src/theme/ThemeProvider";

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
      <Stack.Screen
        name="notes"
        options={{ ...headerScreen, title: "Notes" }}
      />
      <Stack.Screen
        name="attendance"
        options={{ ...headerScreen, title: "Attendance" }}
      />
      <Stack.Screen
        name="team"
        options={{ ...headerScreen, title: "My Team" }}
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

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <ThemeProvider>
            <SafeAreaProvider>
              <StatusBar style="light" />
              <IncomingCallListener />
              <ImpersonationBanner />
              <ThemedStack />
            </SafeAreaProvider>
          </ThemeProvider>
        </AuthProvider>
      </QueryClientProvider>
    </GestureHandlerRootView>
  );
}
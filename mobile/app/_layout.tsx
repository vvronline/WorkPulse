import "react-native-gesture-handler";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { AuthProvider } from "../src/auth/AuthContext";
import { theme } from "../src/theme";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, staleTime: 30_000 },
  },
});

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <SafeAreaProvider>
          <StatusBar style="light" />
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
              options={{
                headerShown: true,
                title: "Notifications",
                headerStyle: { backgroundColor: theme.bgSecondary },
                headerTitleStyle: { color: theme.text },
                headerTintColor: theme.primary,
                headerShadowVisible: false,
              }}
            />
            <Stack.Screen
              name="profile"
              options={{
                headerShown: true,
                title: "Profile",
                headerStyle: { backgroundColor: theme.bgSecondary },
                headerTitleStyle: { color: theme.text },
                headerTintColor: theme.primary,
                headerShadowVisible: false,
              }}
            />
            <Stack.Screen
              name="profile/face"
              options={{
                headerShown: true,
                title: "Face Enrollment",
                headerStyle: { backgroundColor: theme.bgSecondary },
                headerTitleStyle: { color: theme.text },
                headerTintColor: theme.primary,
                headerShadowVisible: false,
              }}
            />
            <Stack.Screen
              name="chat/[id]"
              options={{
                headerShown: true,
                headerStyle: { backgroundColor: theme.bgSecondary },
                headerTitleStyle: { color: theme.text },
                headerTintColor: theme.primary,
                headerShadowVisible: false,
              }}
            />
            <Stack.Screen
              name="chat/new"
              options={{
                headerShown: true,
                title: "New Chat",
                headerStyle: { backgroundColor: theme.bgSecondary },
                headerTitleStyle: { color: theme.text },
                headerTintColor: theme.primary,
                headerShadowVisible: false,
              }}
            />
            <Stack.Screen
              name="leaves/apply"
              options={{
                headerShown: true,
                title: "Apply for Leave",
                headerStyle: { backgroundColor: theme.bgSecondary },
                headerTitleStyle: { color: theme.text },
                headerTintColor: theme.primary,
                headerShadowVisible: false,
              }}
            />
            <Stack.Screen
              name="tasks/new"
              options={{
                headerShown: true,
                title: "New Task",
                headerStyle: { backgroundColor: theme.bgSecondary },
                headerTitleStyle: { color: theme.text },
                headerTintColor: theme.primary,
                headerShadowVisible: false,
              }}
            />
            <Stack.Screen
              name="tasks/[id]"
              options={{
                headerShown: true,
                headerStyle: { backgroundColor: theme.bgSecondary },
                headerTitleStyle: { color: theme.text },
                headerTintColor: theme.primary,
                headerShadowVisible: false,
              }}
            />
            <Stack.Screen
              name="notes"
              options={{
                headerShown: true,
                title: "Notes",
                headerStyle: { backgroundColor: theme.bgSecondary },
                headerTitleStyle: { color: theme.text },
                headerTintColor: theme.primary,
                headerShadowVisible: false,
              }}
            />
            <Stack.Screen
              name="attendance"
              options={{
                headerShown: true,
                title: "Attendance",
                headerStyle: { backgroundColor: theme.bgSecondary },
                headerTitleStyle: { color: theme.text },
                headerTintColor: theme.primary,
                headerShadowVisible: false,
              }}
            />
            <Stack.Screen
              name="team"
              options={{
                headerShown: true,
                title: "My Team",
                headerStyle: { backgroundColor: theme.bgSecondary },
                headerTitleStyle: { color: theme.text },
                headerTintColor: theme.primary,
                headerShadowVisible: false,
              }}
            />
            <Stack.Screen
              name="organization"
              options={{
                headerShown: true,
                title: "Organization",
                headerStyle: { backgroundColor: theme.bgSecondary },
                headerTitleStyle: { color: theme.text },
                headerTintColor: theme.primary,
                headerShadowVisible: false,
              }}
            />
            <Stack.Screen
              name="meeting/[code]"
              options={{
                headerShown: true,
                title: "Meeting",
                headerStyle: { backgroundColor: theme.bgSecondary },
                headerTitleStyle: { color: theme.text },
                headerTintColor: theme.primary,
                headerShadowVisible: false,
              }}
            />
            {/* Admin panel + Platform Console (headers driven by each screen's
                inline <Stack.Screen options>). */}
            <Stack.Screen
              name="admin/index"
              options={{
                headerShown: true,
                title: "Admin Panel",
                headerStyle: { backgroundColor: theme.bgSecondary },
                headerTitleStyle: { color: theme.text },
                headerTintColor: theme.primary,
                headerShadowVisible: false,
              }}
            />
            <Stack.Screen
              name="admin/home"
              options={{
                headerShown: true,
                headerStyle: { backgroundColor: theme.bgSecondary },
                headerTitleStyle: { color: theme.text },
                headerTintColor: theme.primary,
                headerShadowVisible: false,
              }}
            />
            <Stack.Screen
              name="admin/users"
              options={{
                headerShown: true,
                headerStyle: { backgroundColor: theme.bgSecondary },
                headerTitleStyle: { color: theme.text },
                headerTintColor: theme.primary,
                headerShadowVisible: false,
              }}
            />
            <Stack.Screen
              name="admin/user/[id]"
              options={{
                headerShown: true,
                headerStyle: { backgroundColor: theme.bgSecondary },
                headerTitleStyle: { color: theme.text },
                headerTintColor: theme.primary,
                headerShadowVisible: false,
              }}
            />
            <Stack.Screen
              name="admin/role-requests"
              options={{
                headerShown: true,
                headerStyle: { backgroundColor: theme.bgSecondary },
                headerTitleStyle: { color: theme.text },
                headerTintColor: theme.primary,
                headerShadowVisible: false,
              }}
            />
            <Stack.Screen
              name="admin/departments"
              options={{
                headerShown: true,
                headerStyle: { backgroundColor: theme.bgSecondary },
                headerTitleStyle: { color: theme.text },
                headerTintColor: theme.primary,
                headerShadowVisible: false,
              }}
            />
            <Stack.Screen
              name="admin/teams"
              options={{
                headerShown: true,
                headerStyle: { backgroundColor: theme.bgSecondary },
                headerTitleStyle: { color: theme.text },
                headerTintColor: theme.primary,
                headerShadowVisible: false,
              }}
            />
            <Stack.Screen
              name="admin/org-settings"
              options={{
                headerShown: true,
                headerStyle: { backgroundColor: theme.bgSecondary },
                headerTitleStyle: { color: theme.text },
                headerTintColor: theme.primary,
                headerShadowVisible: false,
              }}
            />
            <Stack.Screen
              name="admin/add-people"
              options={{
                headerShown: true,
                headerStyle: { backgroundColor: theme.bgSecondary },
                headerTitleStyle: { color: theme.text },
                headerTintColor: theme.primary,
                headerShadowVisible: false,
              }}
            />
            <Stack.Screen
              name="admin/platform-access"
              options={{
                headerShown: true,
                headerStyle: { backgroundColor: theme.bgSecondary },
                headerTitleStyle: { color: theme.text },
                headerTintColor: theme.primary,
                headerShadowVisible: false,
              }}
            />
            <Stack.Screen
              name="admin/audit"
              options={{
                headerShown: true,
                headerStyle: { backgroundColor: theme.bgSecondary },
                headerTitleStyle: { color: theme.text },
                headerTintColor: theme.primary,
                headerShadowVisible: false,
              }}
            />
            <Stack.Screen
              name="admin/org-chart"
              options={{
                headerShown: true,
                headerStyle: { backgroundColor: theme.bgSecondary },
                headerTitleStyle: { color: theme.text },
                headerTintColor: theme.primary,
                headerShadowVisible: false,
              }}
            />
            <Stack.Screen
              name="admin/projects"
              options={{
                headerShown: true,
                headerStyle: { backgroundColor: theme.bgSecondary },
                headerTitleStyle: { color: theme.text },
                headerTintColor: theme.primary,
                headerShadowVisible: false,
              }}
            />
            <Stack.Screen
              name="admin/payroll"
              options={{
                headerShown: true,
                headerStyle: { backgroundColor: theme.bgSecondary },
                headerTitleStyle: { color: theme.text },
                headerTintColor: theme.primary,
                headerShadowVisible: false,
              }}
            />
            <Stack.Screen
              name="tenants/index"
              options={{
                headerShown: true,
                title: "Platform Console",
                headerStyle: { backgroundColor: theme.bgSecondary },
                headerTitleStyle: { color: theme.text },
                headerTintColor: theme.primary,
                headerShadowVisible: false,
              }}
            />
            <Stack.Screen
              name="tenants/dashboard"
              options={{
                headerShown: true,
                headerStyle: { backgroundColor: theme.bgSecondary },
                headerTitleStyle: { color: theme.text },
                headerTintColor: theme.primary,
                headerShadowVisible: false,
              }}
            />
            <Stack.Screen
              name="tenants/list"
              options={{
                headerShown: true,
                headerStyle: { backgroundColor: theme.bgSecondary },
                headerTitleStyle: { color: theme.text },
                headerTintColor: theme.primary,
                headerShadowVisible: false,
              }}
            />
            <Stack.Screen
              name="tenants/[id]"
              options={{
                headerShown: true,
                headerStyle: { backgroundColor: theme.bgSecondary },
                headerTitleStyle: { color: theme.text },
                headerTintColor: theme.primary,
                headerShadowVisible: false,
              }}
            />
            <Stack.Screen
              name="tenants/create"
              options={{
                headerShown: true,
                headerStyle: { backgroundColor: theme.bgSecondary },
                headerTitleStyle: { color: theme.text },
                headerTintColor: theme.primary,
                headerShadowVisible: false,
              }}
            />
            <Stack.Screen
              name="tenants/plans"
              options={{
                headerShown: true,
                headerStyle: { backgroundColor: theme.bgSecondary },
                headerTitleStyle: { color: theme.text },
                headerTintColor: theme.primary,
                headerShadowVisible: false,
              }}
            />
            <Stack.Screen
              name="tenants/admins"
              options={{
                headerShown: true,
                headerStyle: { backgroundColor: theme.bgSecondary },
                headerTitleStyle: { color: theme.text },
                headerTintColor: theme.primary,
                headerShadowVisible: false,
              }}
            />
            <Stack.Screen
              name="tenants/settings"
              options={{
                headerShown: true,
                headerStyle: { backgroundColor: theme.bgSecondary },
                headerTitleStyle: { color: theme.text },
                headerTintColor: theme.primary,
                headerShadowVisible: false,
              }}
            />
            <Stack.Screen
              name="tenants/audit"
              options={{
                headerShown: true,
                headerStyle: { backgroundColor: theme.bgSecondary },
                headerTitleStyle: { color: theme.text },
                headerTintColor: theme.primary,
                headerShadowVisible: false,
              }}
            />
          </Stack>
        </SafeAreaProvider>
      </AuthProvider>
    </QueryClientProvider>
    </GestureHandlerRootView>
  );
}

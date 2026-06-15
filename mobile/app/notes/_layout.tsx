import { Stack } from "expo-router";
import { useTheme } from "../../src/theme/ThemeProvider";
import { NotesProvider } from "../../src/notes/NotesContext";

/**
 * Notes route group. Wraps the Home dashboard and the editor screen in a single
 * NotesProvider so they share one store instance (and one autosave pipeline).
 */
export default function NotesLayout() {
  const theme = useTheme();
  const headerScreen = {
    headerShown: true as const,
    headerStyle: { backgroundColor: theme.bgSecondary },
    headerTitleStyle: { color: theme.text },
    headerTintColor: theme.primary,
    headerShadowVisible: false,
  };
  return (
    <NotesProvider>
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: theme.bg },
        }}
      >
        <Stack.Screen name="index" options={{ ...headerScreen, title: "Notes" }} />
        <Stack.Screen name="[id]" options={headerScreen} />
        <Stack.Screen name="todo" options={{ ...headerScreen, title: "To-do" }} />
      </Stack>
    </NotesProvider>
  );
}
import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { mmkvStorage } from "../storage/mmkv";

/**
 * Device-scoped app preferences. Currently holds the theme-mode selection
 * (System / Light / Dark). Persisted in MMKV so the choice survives relaunches
 * and is applied synchronously on the next boot (no flash of the wrong theme).
 *
 * Theme is intentionally a DEVICE preference (like the web client treats it):
 * it carries no tenant data and should not be wiped on logout / account switch.
 */

export type ThemePreference = "system" | "light" | "dark";

interface SettingsState {
  theme: ThemePreference;
  setTheme: (theme: ThemePreference) => void;
  hydrated: boolean;
  setHydrated: () => void;
}

export const useSettings = create<SettingsState>()(
  persist(
    (set) => ({
      theme: "system",
      setTheme: (theme) => set({ theme }),
      hydrated: false,
      setHydrated: () => set({ hydrated: true }),
    }),
    {
      name: "settings-storage",
      storage: createJSONStorage(() => mmkvStorage),
      partialize: (state) => ({ theme: state.theme }),
      onRehydrateStorage: () => (state) => {
        state?.setHydrated();
      },
    },
  ),
);
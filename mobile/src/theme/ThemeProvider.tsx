import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import * as SecureStore from "expo-secure-store";
import {
  DEFAULT_ACCENT,
  isValidHex,
  makeTheme,
  type Theme,
} from "../theme";
import { useAuth } from "../auth/AuthContext";
import { getBranding } from "../admin";
import { socket } from "../realtime/socket";

/**
 * ThemeProvider — fetches the tenant's accent colour and broadcasts a reactive
 * theme object derived from it (mirrors the web client's BrandingContext).
 *
 * The accent is cached in SecureStore so the themed UI shows instantly on the
 * next launch before the network resolves. On logout we reset to the default
 * accent.
 */

const ACCENT_CACHE_KEY = "wp_brand_accent";
// The org branding logo URL is cached so the notification handler (which runs
// in the killed/headless state with NO React context) can read it from
// SecureStore and use it as the message-notification LARGE icon fallback when a
// message has no sender avatar. See notifeeService.displayMessage.
export const BRAND_LOGO_CACHE_KEY = "wp_brand_logo_url";

interface ThemeContextValue {
  theme: Theme;
  accent: string;
  refreshBranding: () => Promise<void>;
  setAccent: (hex: string) => void;
}

const ThemeContext = createContext<ThemeContextValue>({
  theme: makeTheme(DEFAULT_ACCENT),
  accent: DEFAULT_ACCENT,
  refreshBranding: async () => {},
  setAccent: () => {},
});

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const [accent, setAccentState] = useState<string>(DEFAULT_ACCENT);
  const fetchedForUser = useRef<number | string | null>(null);

  // Hydrate the cached accent immediately so the UI doesn't flash the default.
  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const cached = await SecureStore.getItemAsync(ACCENT_CACHE_KEY);
        if (active && cached && isValidHex(cached)) {
          setAccentState(cached);
        }
      } catch {
        /* ignore */
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  const applyAccent = useCallback((hex: string) => {
    const next = isValidHex(hex) ? hex : DEFAULT_ACCENT;
    setAccentState(next);
    void SecureStore.setItemAsync(ACCENT_CACHE_KEY, next).catch(() => {});
  }, []);

  const refreshBranding = useCallback(async () => {
    try {
      const { data } = await getBranding();
      applyAccent(data?.accent_color || DEFAULT_ACCENT);
      // Persist the org logo URL so the background/headless notification handler
      // can use it as the message-notification large-icon fallback (it has no
      // access to this React context / the API). Clear it when unset.
      try {
        const logo = data?.logo_url;
        if (logo) {
          await SecureStore.setItemAsync(BRAND_LOGO_CACHE_KEY, logo);
        } else {
          await SecureStore.deleteItemAsync(BRAND_LOGO_CACHE_KEY);
        }
      } catch {
        /* best-effort cache */
      }
    } catch {
      /* keep current accent on failure */
    }
  }, [applyAccent]);

  // Fetch branding when a user signs in; reset to default on logout.
  useEffect(() => {
    if (!user?.id) {
      fetchedForUser.current = null;
      applyAccent(DEFAULT_ACCENT);
      return;
    }
    if (fetchedForUser.current === user.id) return;
    fetchedForUser.current = user.id;
    void refreshBranding();
  }, [user?.id, refreshBranding, applyAccent]);

  // Live sync: when an admin changes the org accent / logo, the server
  // broadcasts `branding_changed` over the realtime socket to every connected
  // client of the tenant. Re-fetch so the new accent applies instantly without
  // needing to re-launch the app.
  useEffect(() => {
    if (!user?.id) return;
    const unsubscribe = socket.subscribe((msg) => {
      if (msg?.type === "branding_changed") {
        void refreshBranding();
      }
    });
    return unsubscribe;
  }, [user?.id, refreshBranding]);

  const theme = useMemo(() => makeTheme(accent), [accent]);

  const value = useMemo<ThemeContextValue>(
    () => ({ theme, accent, refreshBranding, setAccent: applyAccent }),
    [theme, accent, refreshBranding, applyAccent],
  );

  return (
    <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
  );
}

/** Reactive theme hook — returns the live, accent-derived theme object. */
export function useTheme(): Theme {
  return useContext(ThemeContext).theme;
}

/** Full branding context (theme + accent + refresh/setters). */
export function useBranding(): ThemeContextValue {
  return useContext(ThemeContext);
}
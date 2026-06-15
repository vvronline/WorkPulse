import {
    createContext,
    useContext,
    useState,
    useEffect,
    useCallback,
    useMemo,
    useRef,
    type ReactNode,
} from "react";
import { getTheme, updateTheme } from "./api";
import { useAuth } from "./AuthContext";
import useWebSocket, { type WebSocketMessage } from "./hooks/useWebSocket";

interface ThemeContextValue {
    theme: string;
    toggleTheme: () => Promise<void>;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
    const [theme, setTheme] = useState(
        () => localStorage.getItem("theme") || "dark",
    );
    const { isAuthenticated } = useAuth();
    const hasFetchedRef = useRef(false);

    // Apply theme to document
    useEffect(() => {
        document.documentElement.setAttribute("data-theme", theme);
        document.documentElement.style.colorScheme = theme;
        localStorage.setItem("theme", theme);
    }, [theme]);

    // Fetch theme from server only once when first authenticated
    useEffect(() => {
        if (isAuthenticated && !hasFetchedRef.current) {
            hasFetchedRef.current = true;
            getTheme()
                .then(({ data }) => {
                    setTheme(data.theme);
                })
                .catch((e) => console.error(e));
        }
        if (!isAuthenticated) {
            hasFetchedRef.current = false;
        }
    }, [isAuthenticated]);

    // Live multi-device sync: when the theme is changed on another device or
    // tab of the same user, the server pushes a `theme_changed` event over the
    // WebSocket. Apply it here so every open session updates instantly.
    const onWsMessage = useCallback((msg: WebSocketMessage) => {
        if (msg?.type === "theme_changed") {
            const next = (msg.data as { theme?: string } | undefined)?.theme;
            if (next === "dark" || next === "light") {
                setTheme(next);
            }
        }
    }, []);
    useWebSocket(isAuthenticated ? onWsMessage : null);

    const toggleTheme = useCallback(async () => {
        setTheme((prev) => {
            const newTheme = prev === "dark" ? "light" : "dark";
            if (isAuthenticated) {
                updateTheme(newTheme).catch((e) => console.error(e));
            }
            return newTheme;
        });
    }, [isAuthenticated]);

    const value = useMemo(
        () => ({ theme, toggleTheme }),
        [theme, toggleTheme],
    );

    return (
        <ThemeContext.Provider value={value}>
            {children}
        </ThemeContext.Provider>
    );
}

export const useTheme = () => {
    const ctx = useContext(ThemeContext);
    if (!ctx) {
        throw new Error("useTheme must be used within a ThemeProvider");
    }
    return ctx;
};
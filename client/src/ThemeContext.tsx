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
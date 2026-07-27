import {
    createContext,
    useContext,
    useState,
    useEffect,
    useCallback,
    useMemo,
    useRef,
    type Dispatch,
    type SetStateAction,
    type ReactNode,
} from "react";
import { getBranding, getPublicBranding, serverURL } from "./api";
import { useAuth } from "./AuthContext";
import useWebSocket, { type WebSocketMessage } from "./hooks/useWebSocket";

interface Branding {
    logo_url: string | null;
    accent_color: string;
    org_name: string | null;
}

interface BrandingContextValue {
    branding: Branding;
    refresh: () => void;
    setBranding: Dispatch<SetStateAction<Branding>>;
}

/**
 * BrandingContext — fetches and broadcasts the org's logo + accent color.
 *
 * The accent color is applied as a CSS custom property override on
 * <html data-theme>. We override `--primary` (the canonical primary color
 * used across the codebase) so existing components automatically pick up
 * the tenant's branding without any per-component changes.
 *
 * Falls back to the built-in default `#6366f1` when the user is not
 * authenticated, when the org has no branding row, or on fetch error.
 */
// Match the app's design-system default (`--primary` in global.css). We
// only override CSS variables when the org has explicitly customised the
// accent — otherwise we leave the variable alone so the original design
// (and its companion shades `--primary-light` / `--primary-glow`) keeps
// working unchanged.
const DEFAULT_ACCENT = "#2383e2";
const BrandingContext = createContext<BrandingContextValue>({
    branding: { logo_url: null, accent_color: DEFAULT_ACCENT, org_name: null },
    refresh: () => {},
    setBranding: () => {},
});

export function BrandingProvider({ children }: { children: ReactNode }) {
    const { isAuthenticated, user } = useAuth();
    const [branding, setBranding] = useState<Branding>({
        logo_url: null,
        accent_color: DEFAULT_ACCENT,
        org_name: null,
    });
    const fetchedForUser = useRef<number | string | null>(null);
    const publicFetched = useRef(false);

    const refresh = useCallback(() => {
        getBranding()
            .then(({ data }) => {
                setBranding({
                    logo_url: data?.logo_url || null,
                    accent_color: data?.accent_color || DEFAULT_ACCENT,
                    org_name: data?.org_name || null,
                });
            })
            .catch(() => {
                /* fall back to defaults silently */
            });
    }, []);

    useEffect(() => {
        if (!isAuthenticated || !user?.id) {
            // Logged-out state: instead of falling straight to defaults, ask
            // the server for the resolved tenant's branding so the
            // login / register / forgot-password pages match the org theme.
            // The /public/branding endpoint returns nulls on the master
            // domain or when the tenant hasn't configured branding, in
            // which case we keep the built-in default accent.
            fetchedForUser.current = null;
            if (publicFetched.current) return;
            publicFetched.current = true;
            const slug =
                new URLSearchParams(window.location.search).get("org") || "";
            getPublicBranding(slug)
                .then(({ data }) => {
                    setBranding({
                        logo_url: data?.logo_url || null,
                        accent_color: data?.accent_color || DEFAULT_ACCENT,
                        org_name: data?.org_name || null,
                    });
                })
                .catch(() => {
                    setBranding({
                        logo_url: null,
                        accent_color: DEFAULT_ACCENT,
                        org_name: null,
                    });
                });
            return;
        }
        if (fetchedForUser.current === user.id) return;
        fetchedForUser.current = user.id;
        publicFetched.current = false; // re-fetch public branding on next logout
        refresh();
    }, [isAuthenticated, user?.id, refresh]);

    // Live sync: when an admin changes the org accent / logo, the server
    // broadcasts `branding_changed` to every connected client of the tenant.
    // Re-fetch so the new accent + logo apply instantly across all devices
    // (web + desktop) without a refresh or re-login.
    const onWsMessage = useCallback((msg: WebSocketMessage) => {
        if (msg?.type === "branding_changed") {
            refresh();
        }
    }, [refresh]);
    useWebSocket(isAuthenticated ? onWsMessage : null);

    // Apply accent color as a CSS custom property override ONLY when the
    // org has set a non-default value. This way, orgs that haven't
    // configured branding inherit the original design exactly — including
    // companion shades like `--primary-light` and `--primary-glow` that
    // were tuned for the original blue.
    useEffect(() => {
        const root = document.documentElement;
        const accent = branding.accent_color;
        const isCustom =
            accent && accent.toLowerCase() !== DEFAULT_ACCENT.toLowerCase();
        if (!isCustom) {
            root.style.removeProperty("--primary");
            root.style.removeProperty("--accent");
            root.style.removeProperty("--primary-hover");
            root.style.removeProperty("--primary-dark");
            root.style.removeProperty("--primary-light");
            root.style.removeProperty("--primary-glow");
            return;
        }
        root.style.setProperty("--primary", accent);
        root.style.setProperty("--accent", accent);
        // Derive companion shades from the chosen accent so gradients,
        // hovers, and glow shadows that reference them keep tracking the
        // brand color. Without overriding `--primary-dark`, the
        // Attendance tabs (and any other control that uses it for an
        // active/hover state) would still flash blue (`#1a6dbe`) when
        // the org has chosen a non-blue accent.
        root.style.setProperty(
            "--primary-hover",
            `color-mix(in srgb, ${accent} 85%, black)`,
        );
        root.style.setProperty(
            "--primary-dark",
            `color-mix(in srgb, ${accent} 80%, black)`,
        );
        root.style.setProperty(
            "--primary-light",
            `color-mix(in srgb, ${accent} 70%, white)`,
        );
        root.style.setProperty(
            "--primary-glow",
            `color-mix(in srgb, ${accent} 30%, transparent)`,
        );
    }, [branding.accent_color]);

    // Mirror the org logo onto the browser tab favicon so the tenant's
    // brand identity follows the user even when AINO is just one
    // tab among many. Falls back to the original /favicon.ico when the
    // org has no custom logo.
    useEffect(() => {
        if (!branding.logo_url) return;

        const logoUrl = branding.logo_url.startsWith("http")
            ? branding.logo_url
            : `${serverURL}${branding.logo_url}`;

        const head = document.head;
        const existing = Array.from(
            head.querySelectorAll('link[rel~="icon"]'),
        );
        existing.slice(1).forEach((el) => el.remove());
        let link = existing[0] as HTMLLinkElement | undefined;
        if (!link) {
            link = document.createElement("link");
            link.rel = "icon";
            head.appendChild(link);
        }
        link.href = `${logoUrl}?v=${Date.now()}`;
        link.removeAttribute("type");
    }, [branding.logo_url]);

    const value = useMemo(
        () => ({ branding, refresh, setBranding }),
        [branding, refresh],
    );

    return (
        <BrandingContext.Provider value={value}>
            {children}
        </BrandingContext.Provider>
    );
}

export function useBranding() {
    return useContext(BrandingContext);
}
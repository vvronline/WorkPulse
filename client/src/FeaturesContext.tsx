import {
    createContext,
    useCallback,
    useContext,
    useMemo,
    type ReactNode,
} from "react";
import { useAuth } from "./AuthContext";
import useWebSocket from "./hooks/useWebSocket";

interface FeaturesContextValue {
    features: Record<string, boolean>;
    plan: string;
    hasFeature: (name: string) => boolean;
}

/**
 * Frontend feature-gate context.
 *
 * IMPORTANT — `hasFeature` is FAIL-CLOSED.
 *   - The default returned when the provider is missing or no profile has
 *     loaded yet is `false`, NOT `true`. The previous default-true variant
 *     briefly flashed every gated UI section to unsubscribed users during
 *     boot and to logged-out users on the auth screens.
 *   - `tenant_features` from `/api/profile` is an object of strict booleans
 *     produced by the server's `getEffectiveFeatures`. A missing key here
 *     means "unknown" → treated as off.
 *   - Unauthenticated screens (login/register) don't need feature gating
 *     anyway; everything they render is plan-agnostic.
 */
const FeaturesContext = createContext<FeaturesContextValue>({
    features: {},
    plan: "standard",
    hasFeature: () => false,
});

export function FeaturesProvider({ children }: { children: ReactNode }) {
    const { user, updateUser } = useAuth() as any;

    // Live feature updates: when a platform admin edits this tenant's feature
    // overrides (PUT /admin/tenants/:id/features) the server broadcasts a
    // `tenant_features_changed` WS event carrying the new effective feature
    // map. Patch it into the auth user so every hasFeature() gate reacts
    // immediately — previously the web client only picked up an override
    // change on a full page reload.
    const onWsMessage = useCallback(
        (msg: { type?: string; data?: any }) => {
            if (msg?.type !== "tenant_features_changed") return;
            const features = msg.data?.features;
            if (!features || typeof features !== "object") return;
            updateUser({ tenant_features: features });
        },
        [updateUser],
    );
    useWebSocket(user ? onWsMessage : null);

    const value = useMemo<FeaturesContextValue>(() => {
        const features =
            (user?.tenant_features as Record<string, boolean> | undefined) ||
            null;
        const plan = (user?.tenant_plan as string) || "standard";
        // Fail-closed: a feature is enabled only when the server has affirmed it.
        // Platform admins (no tenant) get true via the bypass below.
        const hasFeature = (name: string) => {
            // Platform admins or pre-tenant-resolution users — they aren't gated.
            if (user?.role === "platform_admin" && !user?.tenant_id)
                return true;
            if (!features) return false;
            return features[name] === true;
        };
        return { features: features || {}, plan, hasFeature };
    }, [
        user?.tenant_features,
        user?.tenant_plan,
        user?.role,
        user?.tenant_id,
    ]);

    return (
        <FeaturesContext.Provider value={value}>
            {children}
        </FeaturesContext.Provider>
    );
}

export const useFeatures = () => useContext(FeaturesContext);
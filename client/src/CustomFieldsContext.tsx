/**
 * CustomFieldsContext — caches the org's custom field definitions.
 *
 * Definitions change rarely (admin-managed) but are needed wherever tasks
 * are rendered. Fetching them once per session avoids hammering the API on
 * every task open. The provider exposes a `refresh()` so the admin UI can
 * push new definitions immediately after a save without waiting for TTL.
 */
import {
    createContext,
    useContext,
    useEffect,
    useState,
    useCallback,
    useMemo,
    type ReactNode,
} from "react";
import { getCustomFields } from "./api";
import { useAuth } from "./AuthContext";
import type { CustomFieldDef } from "./types";

interface CustomFieldsContextValue {
    fields: CustomFieldDef[];
    byId: Record<string | number, CustomFieldDef>;
    loading: boolean;
    error: unknown;
    refresh: () => Promise<void> | void;
}

const Ctx = createContext<CustomFieldsContextValue | null>(null);

export function CustomFieldsProvider({ children }: { children: ReactNode }) {
    const { isAuthenticated, user } = useAuth();
    const [fields, setFields] = useState<CustomFieldDef[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<unknown>(null);

    const refresh = useCallback(async () => {
        if (!isAuthenticated) {
            setFields([]);
            return;
        }
        setLoading(true);
        try {
            const r = await getCustomFields();
            setFields(Array.isArray(r.data) ? r.data : []);
            setError(null);
        } catch (e) {
            // 403 / 401 → treat as "no fields" silently; the feature is optional.
            const err = e as { response?: { data?: { error?: string } } };
            setFields([]);
            setError(err?.response?.data?.error || null);
        } finally {
            setLoading(false);
        }
    }, [isAuthenticated]);

    useEffect(() => {
        refresh();
    }, [refresh, user?.id]);

    const value = useMemo<CustomFieldsContextValue>(() => {
        const byId: Record<string | number, CustomFieldDef> = {};
        for (const f of fields) byId[f.id] = f;
        return { fields, byId, loading, error, refresh };
    }, [fields, loading, error, refresh]);

    return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useCustomFields(): CustomFieldsContextValue {
    const ctx = useContext(Ctx);
    if (!ctx) {
        return {
            fields: [],
            byId: {},
            loading: false,
            error: null,
            refresh: () => Promise.resolve(),
        };
    }
    return ctx;
}
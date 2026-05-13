/**
 * CustomFieldsContext — caches the org's custom field definitions.
 *
 * Definitions change rarely (admin-managed) but are needed wherever tasks
 * are rendered. Fetching them once per session avoids hammering the API on
 * every task open. The provider exposes a `refresh()` so the admin UI can
 * push new definitions immediately after a save without waiting for TTL.
 */
import React, { createContext, useContext, useEffect, useState, useCallback, useMemo } from 'react';
import { getCustomFields } from './api';
import { useAuth } from './AuthContext';

const Ctx = createContext(null);

export function CustomFieldsProvider({ children }) {
    const { isAuthenticated, user } = useAuth();
    const [fields, setFields] = useState([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);

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
            setFields([]);
            setError(e?.response?.data?.error || null);
        } finally {
            setLoading(false);
        }
    }, [isAuthenticated]);

    useEffect(() => { refresh(); }, [refresh, user?.id]);

    const value = useMemo(() => {
        const byId = {};
        for (const f of fields) byId[f.id] = f;
        return { fields, byId, loading, error, refresh };
    }, [fields, loading, error, refresh]);

    return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useCustomFields() {
    const ctx = useContext(Ctx);
    if (!ctx) {
        return { fields: [], byId: {}, loading: false, error: null, refresh: () => Promise.resolve() };
    }
    return ctx;
}
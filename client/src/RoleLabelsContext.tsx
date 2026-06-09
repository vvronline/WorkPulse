import {
    createContext,
    useContext,
    useEffect,
    useState,
    useCallback,
    useMemo,
    useRef,
    type ReactNode,
} from "react";
import { getOrgRoles } from "./api";
import { useAuth } from "./AuthContext";

/**
 * Role Labels Context.
 *
 * Each tenant has its own fully-customisable set of roles, each pinned to
 * a permission_level 1..4. This context fetches the live catalogue from
 * `GET /api/org/roles` once per session (and refetches on tenant switch
 * or after a successful edit in the admin UI) and exposes lookup helpers
 * so any component that displays a role badge or option picks up tenant
 * customisations automatically.
 *
 * Role keys still recognised but NOT in the tenant catalogue:
 *   - `super_admin`     (org-wide admin)         level 5
 *   - `platform_admin`  (cross-org system role)  level 6
 *
 * If a user holds a role that no longer exists in the tenant catalogue
 * (because the admin deleted it after an inactive user was reassigned to
 * the canonical fallback) we fall back to a "missing" placeholder so the
 * UI never shows a blank string.
 */

export interface RoleLabel {
    role_key: string;
    label: string;
    description?: string;
    color: string;
    permission_level: number;
    is_system?: boolean;
    customised?: boolean;
    user_count?: number;
    [key: string]: unknown;
}

const SYSTEM_ROLE_LABELS: Record<string, RoleLabel> = {
    super_admin: {
        role_key: "super_admin",
        label: "Super Admin",
        description:
            "Full org admin: settings, billing, all permissions.",
        color: "#ef4444",
        permission_level: 5,
        is_system: true,
        customised: false,
        user_count: 0,
    },
    platform_admin: {
        role_key: "platform_admin",
        label: "Platform Admin",
        description: "System operator (cross-organisation).",
        color: "#0f172a",
        permission_level: 6,
        is_system: true,
        customised: false,
        user_count: 0,
    },
};

const FALLBACK_ROLES: RoleLabel[] = [
    {
        role_key: "employee",
        label: "Employee",
        description: "Standard team member.",
        color: "#6b7280",
        permission_level: 1,
        is_system: true,
        customised: false,
        user_count: 0,
    },
    {
        role_key: "team_lead",
        label: "Team Lead",
        description: "Leads a single team.",
        color: "#0ea5e9",
        permission_level: 2,
        is_system: true,
        customised: false,
        user_count: 0,
    },
    {
        role_key: "manager",
        label: "Manager",
        description: "Manages a department; approves leaves and tasks.",
        color: "#8b5cf6",
        permission_level: 3,
        is_system: true,
        customised: false,
        user_count: 0,
    },
    {
        role_key: "hr_admin",
        label: "HR Admin",
        description: "People-ops: invites, removes, manages org members.",
        color: "#f59e0b",
        permission_level: 4,
        is_system: true,
        customised: false,
        user_count: 0,
    },
];

interface RoleLabelsContextValue {
    roles: RoleLabel[];
    defaults: RoleLabel[];
    indexed: Record<string, RoleLabel>;
    loading: boolean;
    error: unknown;
    refresh: () => Promise<void> | void;
    get: (roleKey: string) => RoleLabel;
    labelFor: (roleKey: string) => string;
    colorFor: (roleKey: string) => string;
    levelFor: (roleKey: string) => number;
    setRoles: (roles: RoleLabel[]) => void;
    setDefaults: (defaults: RoleLabel[]) => void;
}

const RoleLabelsContext = createContext<RoleLabelsContextValue | null>(null);

export function RoleLabelsProvider({ children }: { children: ReactNode }) {
    const { isAuthenticated, user } = useAuth();
    const [roles, setRoles] = useState<RoleLabel[]>(FALLBACK_ROLES);
    const [defaults, setDefaults] = useState<RoleLabel[]>(FALLBACK_ROLES);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<unknown>(null);

    const lastTenantRef = useRef<string | null>(null);

    const fetch = useCallback(async () => {
        if (!isAuthenticated) {
            setRoles(FALLBACK_ROLES);
            setDefaults(FALLBACK_ROLES);
            return;
        }
        setLoading(true);
        setError(null);
        try {
            const res = await getOrgRoles();
            setRoles(
                Array.isArray(res.data?.roles) && res.data.roles.length
                    ? res.data.roles
                    : FALLBACK_ROLES,
            );
            setDefaults(
                Array.isArray(res.data?.defaults) && res.data.defaults.length
                    ? res.data.defaults
                    : FALLBACK_ROLES,
            );
        } catch (err) {
            setError(err);
            setRoles(FALLBACK_ROLES);
            setDefaults(FALLBACK_ROLES);
        } finally {
            setLoading(false);
        }
    }, [isAuthenticated]);

    useEffect(() => {
        const tenantKey = user
            ? `${user.tenant_id || 0}:${user.id || 0}`
            : null;
        if (tenantKey !== lastTenantRef.current) {
            lastTenantRef.current = tenantKey;
            fetch();
        }
    }, [user, fetch]);

    /** Build a quick role_key → role-object index, including the two system roles. */
    const indexed = useMemo(() => {
        const map: Record<string, RoleLabel> = { ...SYSTEM_ROLE_LABELS };
        for (const r of roles) map[r.role_key] = r;
        return map;
    }, [roles]);

    const value = useMemo<RoleLabelsContextValue>(() => {
        const get = (roleKey: string): RoleLabel =>
            indexed[roleKey] || {
                role_key: roleKey,
                label: roleKey,
                description: "",
                color: "#6b7280",
                permission_level: 1,
                is_system: false,
                customised: false,
                user_count: 0,
            };
        return {
            roles,
            defaults,
            indexed,
            loading,
            error,
            refresh: fetch,
            /** Get the full role object (label/colour/level/etc.) for a key. */
            get,
            /** Quick label-only lookup (string). */
            labelFor: (roleKey: string) => get(roleKey).label,
            /** Quick colour-only lookup. */
            colorFor: (roleKey: string) => get(roleKey).color,
            /** Quick permission-level lookup (number). */
            levelFor: (roleKey: string) => get(roleKey).permission_level || 1,
            /** Replace the whole catalogue (used by the editor after a save). */
            setRoles,
            setDefaults,
        };
    }, [roles, defaults, indexed, loading, error, fetch]);

    return (
        <RoleLabelsContext.Provider value={value}>
            {children}
        </RoleLabelsContext.Provider>
    );
}

/** Access the full context. Returns the provider value or a fallback shim. */
export function useRoleLabels(): RoleLabelsContextValue {
    const ctx = useContext(RoleLabelsContext);
    if (ctx) return ctx;
    const indexed: Record<string, RoleLabel> = { ...SYSTEM_ROLE_LABELS };
    for (const r of FALLBACK_ROLES) indexed[r.role_key] = r;
    const get = (k: string): RoleLabel =>
        indexed[k] || {
            role_key: k,
            label: k,
            color: "#6b7280",
            permission_level: 1,
            is_system: false,
            customised: false,
            user_count: 0,
        };
    return {
        roles: FALLBACK_ROLES,
        defaults: FALLBACK_ROLES,
        indexed,
        loading: false,
        error: null,
        refresh: () => Promise.resolve(),
        get,
        labelFor: (k: string) => get(k).label,
        colorFor: (k: string) => get(k).color,
        levelFor: (k: string) => get(k).permission_level || 1,
        setRoles: () => {},
        setDefaults: () => {},
    };
}

/** Convenience hook: just the label string for one role. */
export function useRoleLabel(roleKey: string) {
    return useRoleLabels().labelFor(roleKey);
}
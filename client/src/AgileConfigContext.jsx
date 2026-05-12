/**
 * AgileConfigContext
 *
 * Loads tenant-customisable Agile configuration once per session and exposes
 * it to all task / sprint UI. Includes:
 *   - workItemTypes  (Story/Bug/Task/Epic/...)
 *   - workflowStates (Kanban columns)
 *   - settings       (estimation scale, feature flags, priority scheme)
 *   - canEdit        (boolean — current user can edit Agile settings)
 *
 * Cached in localStorage with a soft TTL so the UI is instant on reload while
 * still picking up admin changes within a few minutes (or after explicit
 * `refresh()` calls).
 */
import React, { createContext, useContext, useEffect, useState, useCallback, useMemo } from 'react';
import { getAgileConfig } from './api';
import { useAuth } from './AuthContext';

const AgileConfigContext = createContext(null);

const CACHE_KEY = 'workpulse_agile_config_v1';
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

const FALLBACK_CONFIG = {
    settings: {
        estimation_type: 'fibonacci',
        estimation_values: [0.5, 1, 2, 3, 5, 8, 13, 21, 34],
        estimation_unit_label: 'SP',
        priority_scheme: [
            { key: 'low', label: 'Low', color: '#10b981' },
            { key: 'medium', label: 'Medium', color: '#f59e0b' },
            { key: 'high', label: 'High', color: '#ef4444' },
        ],
        enable_story_points: true,
        enable_epics: true,
        enable_dependencies: true,
        enable_acceptance_criteria: true,
        enable_blockers: true,
        enable_wip_limits: false,
    },
    workItemTypes: [
        { id: 0, key: 'story', name: 'Story', color: '#10b981', icon: 'BookOpen', is_default: true, sort_order: 1 },
        { id: 0, key: 'bug', name: 'Bug', color: '#ef4444', icon: 'Bug', sort_order: 2 },
        { id: 0, key: 'task', name: 'Task', color: '#6366f1', icon: 'Circle', sort_order: 3 },
        { id: 0, key: 'epic', name: 'Epic', color: '#8b5cf6', icon: 'Target', is_epic: true, sort_order: 4 },
    ],
    workflowStates: [
        { id: 0, key: 'pending', name: 'To Do', category: 'open', color: '#6b7280', is_initial: true, sort_order: 1 },
        { id: 0, key: 'in_progress', name: 'In Progress', category: 'in_progress', color: '#f59e0b', sort_order: 2 },
        { id: 0, key: 'in_review', name: 'In Review', category: 'in_review', color: '#3b82f6', sort_order: 3 },
        { id: 0, key: 'done', name: 'Done', category: 'done', color: '#10b981', is_terminal: true, sort_order: 4 },
    ],
    canEdit: false,
};

function loadCache() {
    try {
        const raw = localStorage.getItem(CACHE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (!parsed?.fetchedAt || Date.now() - parsed.fetchedAt > CACHE_TTL_MS) return null;
        return parsed.config;
    } catch { return null; }
}

function saveCache(config) {
    try { localStorage.setItem(CACHE_KEY, JSON.stringify({ fetchedAt: Date.now(), config })); } catch { /* ignore */ }
}

export function AgileConfigProvider({ children }) {
    const { isAuthenticated, user } = useAuth();
    const [config, setConfig] = useState(() => loadCache() || FALLBACK_CONFIG);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);

    const refresh = useCallback(async () => {
        if (!isAuthenticated) return;
        setLoading(true);
        try {
            const r = await getAgileConfig();
            const cfg = r.data;
            // Merge defaults so partial responses don't leave the UI broken
            const merged = {
                settings: { ...FALLBACK_CONFIG.settings, ...(cfg.settings || {}) },
                workItemTypes: (cfg.workItemTypes && cfg.workItemTypes.length > 0) ? cfg.workItemTypes : FALLBACK_CONFIG.workItemTypes,
                workflowStates: (cfg.workflowStates && cfg.workflowStates.length > 0) ? cfg.workflowStates : FALLBACK_CONFIG.workflowStates,
                canEdit: !!cfg.canEdit,
            };
            setConfig(merged);
            saveCache(merged);
            setError(null);
        } catch (e) {
            setError(e?.response?.data?.error || 'Failed to load Agile config');
        } finally {
            setLoading(false);
        }
    }, [isAuthenticated]);

    useEffect(() => {
        if (isAuthenticated) refresh();
    }, [isAuthenticated, user?.id, refresh]);

    const value = useMemo(() => {
        // Derive convenient lookups
        const stateById = {};
        const stateByKey = {};
        for (const s of config.workflowStates) {
            stateById[s.id] = s;
            stateByKey[s.key] = s;
        }
        const typeById = {};
        const typeByKey = {};
        for (const t of config.workItemTypes) {
            typeById[t.id] = t;
            typeByKey[t.key] = t;
        }
        const initialState = config.workflowStates.find(s => s.is_initial) || config.workflowStates[0];
        const terminalStates = config.workflowStates.filter(s => s.is_terminal);
        const defaultType = config.workItemTypes.find(t => t.is_default) || config.workItemTypes[0];

        return {
            ...config,
            loading, error, refresh,
            stateById, stateByKey, typeById, typeByKey,
            initialState, terminalStates, defaultType,
            // Convenience getters
            pointScale: config.settings.estimation_values || [],
            unitLabel: config.settings.estimation_unit_label || 'SP',
            priorities: config.settings.priority_scheme || FALLBACK_CONFIG.settings.priority_scheme,
            features: {
                storyPoints: !!config.settings.enable_story_points,
                epics: !!config.settings.enable_epics,
                dependencies: !!config.settings.enable_dependencies,
                acceptanceCriteria: !!config.settings.enable_acceptance_criteria,
                blockers: !!config.settings.enable_blockers,
                wipLimits: !!config.settings.enable_wip_limits,
            },
        };
    }, [config, loading, error, refresh]);

    return <AgileConfigContext.Provider value={value}>{children}</AgileConfigContext.Provider>;
}

export function useAgileConfig() {
    const ctx = useContext(AgileConfigContext);
    if (!ctx) {
        // Return fallback config rather than crashing if used outside the provider —
        // useful during the auth loading phase or in storybook-style isolated tests.
        return {
            ...FALLBACK_CONFIG,
            loading: false, error: null, refresh: () => Promise.resolve(),
            stateById: {}, stateByKey: {}, typeById: {}, typeByKey: {},
            initialState: FALLBACK_CONFIG.workflowStates[0],
            terminalStates: [FALLBACK_CONFIG.workflowStates[3]],
            defaultType: FALLBACK_CONFIG.workItemTypes[0],
            pointScale: FALLBACK_CONFIG.settings.estimation_values,
            unitLabel: 'SP',
            priorities: FALLBACK_CONFIG.settings.priority_scheme,
            features: { storyPoints: true, epics: true, dependencies: true, acceptanceCriteria: true, blockers: true, wipLimits: false },
        };
    }
    return ctx;
}
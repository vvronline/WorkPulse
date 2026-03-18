import { createContext, useContext, useMemo } from 'react';

/**
 * Shared context for the Tasks page.
 * Eliminates prop-drilling of static/rarely-changing reference data
 * (users, labels, sprints, current user, active tab) through TasksHeader,
 * BacklogTab, and TaskDetailModal.
 */
const TaskContext = createContext(null);

export function TaskProvider({
    children,
    assignableUsers,
    orgLabels,
    availableSprints,
    currentUser,
    activeTab,
}) {
    const value = useMemo(
        () => ({ assignableUsers, orgLabels, availableSprints, currentUser, activeTab }),
        [assignableUsers, orgLabels, availableSprints, currentUser, activeTab],
    );
    return <TaskContext.Provider value={value}>{children}</TaskContext.Provider>;
}

export const useTaskCtx = () => useContext(TaskContext);

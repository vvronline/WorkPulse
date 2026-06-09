import { createContext, useContext, useMemo } from "react";
import type { User, TaskLabel, Sprint, Project } from "../../types";

/**
 * Shared context for the Tasks page.
 * Eliminates prop-drilling of static/rarely-changing reference data
 * (users, labels, sprints, current user, active tab) through TasksHeader,
 * BacklogTab, and TaskDetailModal.
 */
interface TaskContextValue {
    assignableUsers: User[];
    orgLabels: TaskLabel[];
    availableSprints: Sprint[];
    availableProjects: Project[];
    currentUser: User | null;
    activeTab: string;
}

const TaskContext = createContext<TaskContextValue | null>(null);

interface TaskProviderProps {
    children: React.ReactNode;
    assignableUsers: User[];
    orgLabels: TaskLabel[];
    availableSprints: Sprint[];
    availableProjects: Project[];
    currentUser: User | null;
    activeTab: string;
}

export function TaskProvider({
    children,
    assignableUsers,
    orgLabels,
    availableSprints,
    availableProjects,
    currentUser,
    activeTab,
}: TaskProviderProps) {
    const value = useMemo(
        () => ({
            assignableUsers,
            orgLabels,
            availableSprints,
            availableProjects,
            currentUser,
            activeTab,
        }),
        [
            assignableUsers,
            orgLabels,
            availableSprints,
            availableProjects,
            currentUser,
            activeTab,
        ],
    );
    return <TaskContext.Provider value={value}>{children}</TaskContext.Provider>;
}

export const useTaskCtx = () => useContext(TaskContext);
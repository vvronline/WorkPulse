import { useState, useMemo } from "react";

interface TaskFilters {
    assignee?: string;
    label?: string;
    priority?: string;
    status?: string;
    search?: string;
}

export function useFilters({ activeTab }: { activeTab: string }) {
    const [filterAssignee, setFilterAssignee] = useState("");
    const [filterLabel, setFilterLabel] = useState("");
    const [filterPriority, setFilterPriority] = useState("");
    const [filterStatus, setFilterStatus] = useState("");
    const [filterSearch, setFilterSearch] = useState("");
    const [filtersOpen, setFiltersOpen] = useState(false);

    const plannerFilters = useMemo<TaskFilters | undefined>(() => {
        const f: TaskFilters = {};
        if (filterAssignee) f.assignee = filterAssignee;
        if (filterLabel) f.label = filterLabel;
        if (filterPriority) f.priority = filterPriority;
        if (filterStatus) f.status = filterStatus;
        if (filterSearch.trim()) f.search = filterSearch.trim();
        return Object.keys(f).length ? f : undefined;
    }, [
        filterAssignee,
        filterLabel,
        filterPriority,
        filterStatus,
        filterSearch,
    ]);

    const backlogFilters = useMemo<TaskFilters | undefined>(() => {
        const f: TaskFilters = {};
        if (filterAssignee) f.assignee = filterAssignee;
        if (filterLabel) f.label = filterLabel;
        if (filterPriority) f.priority = filterPriority;
        if (filterSearch.trim()) f.search = filterSearch.trim();
        return Object.keys(f).length ? f : undefined;
    }, [filterAssignee, filterLabel, filterPriority, filterSearch]);

    const filterCount = useMemo(() => {
        const base = [
            filterAssignee,
            filterLabel,
            filterPriority,
            filterSearch.trim(),
        ];
        if (activeTab === "sprint") base.push(filterStatus);
        return base.filter(Boolean).length;
    }, [
        filterAssignee,
        filterLabel,
        filterPriority,
        filterStatus,
        filterSearch,
        activeTab,
    ]);

    const clearFilters = () => {
        setFilterAssignee("");
        setFilterLabel("");
        setFilterPriority("");
        setFilterStatus("");
        setFilterSearch("");
    };

    return {
        filterAssignee,
        setFilterAssignee,
        filterLabel,
        setFilterLabel,
        filterPriority,
        setFilterPriority,
        filterStatus,
        setFilterStatus,
        filterSearch,
        setFilterSearch,
        filtersOpen,
        setFiltersOpen,
        plannerFilters,
        backlogFilters,
        filterCount,
        clearFilters,
    };
}
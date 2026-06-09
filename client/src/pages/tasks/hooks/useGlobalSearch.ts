import { useState, useRef, useEffect } from "react";
import { searchTasks } from "../../../api";
import type { Task } from "../../../types";

export function useGlobalSearch() {
    const [globalSearch, setGlobalSearch] = useState("");
    const [globalResults, setGlobalResults] = useState<Task[]>([]);
    const [globalSearching, setGlobalSearching] = useState(false);
    const [globalSearchOpen, setGlobalSearchOpen] = useState(false);
    const globalSearchRef = useRef<HTMLDivElement | null>(null);
    const globalSearchTimer = useRef<ReturnType<typeof setTimeout> | null>(
        null,
    );

    useEffect(() => {
        const handleClickOutside = (e: MouseEvent) => {
            if (
                globalSearchRef.current &&
                !globalSearchRef.current.contains(e.target as Node)
            ) {
                setGlobalSearchOpen(false);
            }
        };
        document.addEventListener("mousedown", handleClickOutside);
        return () =>
            document.removeEventListener("mousedown", handleClickOutside);
    }, []);

    const handleGlobalSearch = (value: string) => {
        setGlobalSearch(value);
        if (globalSearchTimer.current)
            clearTimeout(globalSearchTimer.current);
        if (!value.trim() || value.trim().length < 2) {
            setGlobalResults([]);
            setGlobalSearchOpen(false);
            setGlobalSearching(false);
            return;
        }
        setGlobalSearching(true);
        setGlobalSearchOpen(true);
        globalSearchTimer.current = setTimeout(async () => {
            try {
                const res = await searchTasks(value.trim());
                setGlobalResults(res.data);
            } catch {
                setGlobalResults([]);
            } finally {
                setGlobalSearching(false);
            }
        }, 300);
    };

    return {
        globalSearch,
        globalResults,
        globalSearching,
        globalSearchOpen,
        globalSearchRef,
        setGlobalSearchOpen,
        handleGlobalSearch,
    };
}
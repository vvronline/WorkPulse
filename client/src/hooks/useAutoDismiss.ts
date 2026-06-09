import { useState, useEffect, useRef } from "react";

/**
 * A custom hook that works like useState but automatically resets the value to the
 * initial value after a specified timeout (default 5000ms).
 */
export function useAutoDismiss<T>(
    initialValue: T = "" as unknown as T,
    delayMs = 5000,
): [T, (newValue: T) => void] {
    const [value, setValue] = useState<T>(initialValue);
    const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    useEffect(() => {
        // Whenever value changes to something "truthy" (like an error or success message)
        // we set a timeout to clear it.
        if (value) {
            if (timeoutRef.current) clearTimeout(timeoutRef.current);
            timeoutRef.current = setTimeout(() => {
                setValue(initialValue);
            }, delayMs);
        }

        return () => {
            if (timeoutRef.current) clearTimeout(timeoutRef.current);
        };
    }, [value, delayMs]);

    const setValueClearTimeout = (newValue: T) => {
        if (timeoutRef.current) clearTimeout(timeoutRef.current);
        setValue(newValue);
    };

    return [value, setValueClearTimeout];
}
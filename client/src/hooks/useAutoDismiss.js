import { useState, useEffect, useRef } from 'react';

/**
 * A custom hook that works like useState but automatically resets the value to the
 * initial value after a specified timeout (default 5000ms).
 */
export function useAutoDismiss(initialValue = '', delayMs = 5000) {
    const [value, setValue] = useState(initialValue);
    const timeoutRef = useRef(null);

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
    }, [value, initialValue, delayMs]);

    const setValueClearTimeout = (newValue) => {
        if (timeoutRef.current) clearTimeout(timeoutRef.current);
        setValue(newValue);
    };

    return [value, setValueClearTimeout];
}

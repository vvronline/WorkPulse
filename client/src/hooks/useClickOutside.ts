import { useEffect, useRef, type RefObject } from "react";

/**
 * Fires `callback` when the user clicks outside of `ref`.
 * `enabled` lets callers conditionally activate the listener (e.g. only when a
 * dropdown is open) to avoid unnecessary DOM event overhead.
 *
 * The callback is stored in a ref internally so callers may pass inline arrow
 * functions without triggering listener re-registration on every render.
 */
export function useClickOutside(
    ref: RefObject<HTMLElement | null>,
    callback: () => void,
    enabled = true,
): void {
    const cbRef = useRef(callback);
    useEffect(() => {
        cbRef.current = callback;
    });

    useEffect(() => {
        if (!enabled) return;
        const handle = (e: MouseEvent) => {
            if (ref.current && !ref.current.contains(e.target as Node))
                cbRef.current();
        };
        document.addEventListener("mousedown", handle);
        return () => document.removeEventListener("mousedown", handle);
    }, [ref, enabled]);
}
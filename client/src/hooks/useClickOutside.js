import { useEffect, useRef } from 'react';

/**
 * Fires `callback` when the user clicks outside of `ref`.
 * `enabled` lets callers conditionally activate the listener (e.g. only when a
 * dropdown is open) to avoid unnecessary DOM event overhead.
 *
 * The callback is stored in a ref internally so callers may pass inline arrow
 * functions without triggering listener re-registration on every render.
 */
export function useClickOutside(ref, callback, enabled = true) {
    const cbRef = useRef(callback);
    useEffect(() => { cbRef.current = callback; });

    useEffect(() => {
        if (!enabled) return;
        const handle = (e) => {
            if (ref.current && !ref.current.contains(e.target)) cbRef.current();
        };
        document.addEventListener('mousedown', handle);
        return () => document.removeEventListener('mousedown', handle);
    }, [ref, enabled]);
}

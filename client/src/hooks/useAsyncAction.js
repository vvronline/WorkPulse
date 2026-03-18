import { useState, useCallback } from 'react';
import { useAutoDismiss } from './useAutoDismiss';

/**
 * Encapsulates the repetitive loading/message pattern used in form sections.
 *
 * Usage:
 *   const { loading, msg, run } = useAsyncAction();
 *   await run(async () => { await api.save(data); return 'Saved!'; });
 *   {msg && <p className={msg.ok ? s.success : s.error}>{msg.text}</p>}
 */
export function useAsyncAction() {
    const [loading, setLoading] = useState(false);
    const [msg, setMsg] = useAutoDismiss(null);

    const run = useCallback(async (fn) => {
        setLoading(true);
        setMsg(null);
        try {
            const result = await fn();
            if (typeof result === 'string') setMsg({ ok: true, text: result });
        } catch (err) {
            setMsg({ ok: false, text: err.response?.data?.error || 'An error occurred' });
        } finally {
            setLoading(false);
        }
    }, []);

    return { loading, msg, run };
}

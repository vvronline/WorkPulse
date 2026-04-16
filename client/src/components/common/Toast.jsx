import React, { createContext, useContext, useState, useCallback, useRef, useEffect } from 'react';
import { CheckCircle2, XCircle, AlertTriangle, Info, X } from 'lucide-react';
import s from './Toast.module.css';

const ToastContext = createContext();

let toastIdCounter = 0;

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const timersRef = useRef({});

  const removeToast = useCallback((id) => {
    clearTimeout(timersRef.current[id]);
    delete timersRef.current[id];
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);

  const addToast = useCallback((message, type = 'info', duration = 4000) => {
    const id = ++toastIdCounter;
    setToasts(prev => [...prev.slice(-4), { id, message, type }]); // keep max 5
    if (duration > 0) {
      timersRef.current[id] = setTimeout(() => removeToast(id), duration);
    }
    return id;
  }, [removeToast]);

  // Cleanup all timers on unmount
  useEffect(() => {
    return () => {
      Object.values(timersRef.current).forEach(clearTimeout);
    };
  }, []);

  const toast = React.useMemo(() => ({
    success: (msg, dur) => addToast(msg, 'success', dur),
    error: (msg, dur) => addToast(msg, 'error', dur ?? 6000),
    info: (msg, dur) => addToast(msg, 'info', dur),
    warning: (msg, dur) => addToast(msg, 'warning', dur ?? 5000),
  }), [addToast]);

  // Make toast callable: toast.success(), toast.error(), etc.
  // But also expose addToast for generic use
  const value = { toast, addToast, removeToast };

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className={s['toast-container']} role="status" aria-live="polite">
        {toasts.map(t => (
          <div key={t.id} className={`${s.toast} ${s[`toast-${t.type}`]}`}>
            <span className={s['toast-icon']}>
              {t.type === 'success' ? <CheckCircle2 size={15} /> : t.type === 'error' ? <XCircle size={15} /> : t.type === 'warning' ? <AlertTriangle size={15} /> : <Info size={15} />}
            </span>
            <span className={s['toast-msg']}>{t.message}</span>
            <button className={s['toast-close']} onClick={() => removeToast(t.id)} aria-label="Dismiss"><X size={13} /></button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within ToastProvider');
  return ctx.toast;
}

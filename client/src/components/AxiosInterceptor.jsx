import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import API from '../api';
import { useAuth } from '../AuthContext';
import { useToast } from './Toast';

export default function AxiosInterceptor({ children }) {
    const navigate = useNavigate();
    const { logout } = useAuth();
    const toast = useToast();
    // Use ref to avoid stale closures in the interceptor
    const toastRef = useRef(toast);
    toastRef.current = toast;

    useEffect(() => {
        const interceptor = API.interceptors.response.use(
            response => response,
            error => {
                const status = error.response?.status;
                if (status === 401) {
                    logout();
                    navigate('/login', { replace: true });
                } else if (status === 429) {
                    toastRef.current.warning('Too many requests. Please slow down.');
                } else if (status >= 500) {
                    toastRef.current.error('Server error. Please try again later.');
                } else if (!error.response) {
                    // Network error (no response at all)
                    toastRef.current.error('Network error. Check your connection.');
                }
                return Promise.reject(error);
            }
        );

        return () => {
            API.interceptors.response.eject(interceptor);
        };
    }, [navigate, logout]);

    return children;
}

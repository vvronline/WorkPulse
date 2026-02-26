import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import API from '../api';
import { useAuth } from '../AuthContext';

export default function AxiosInterceptor({ children }) {
    const navigate = useNavigate();
    const { logout } = useAuth();

    useEffect(() => {
        const interceptor = API.interceptors.response.use(
            response => response,
            error => {
                if (error.response?.status === 401) {
                    logout();
                    navigate('/login', { replace: true });
                }
                return Promise.reject(error);
            }
        );

        // Cleanup the interceptor when the component unmounts
        return () => {
            API.interceptors.response.eject(interceptor);
        };
    }, [navigate, logout]);

    return children;
}

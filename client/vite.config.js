import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
    plugins: [react()],
    test: {
        globals: true,
        environment: 'jsdom',
        setupFiles: './src/test-setup.js',
    },
    build: {
        modulePreload: { polyfill: false },
        crossOriginLoading: false,
    },
    server: {
        port: 3000,
        proxy: {
            '/api': 'http://localhost:5000',
            '/uploads': 'http://localhost:5000'
        },
        hmr: {
            port: 3000,
            host: 'localhost',
            protocol: 'ws'
        }
    }
});

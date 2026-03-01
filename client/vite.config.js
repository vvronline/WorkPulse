import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
    plugins: [react()],
    server: {
        port: 3000,
        proxy: {
            '/api': 'http://localhost:5000',
            '/uploads': 'http://localhost:5000'
        },
        hmr: {
            // Let HMR auto-detect the actual port when 3000 is occupied
            clientPort: undefined
        }
    }
});

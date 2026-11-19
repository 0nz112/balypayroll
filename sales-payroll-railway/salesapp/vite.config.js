import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: '/',
  build: { target: 'es2020', chunkSizeWarningLimit: 900 },
  server: { proxy: { '/api': 'http://localhost:3000' } }, // `npm run dev` + `npm start` side by side
});

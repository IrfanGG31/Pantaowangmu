import { sveltekit } from '@sveltejs/kit/vite';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [
    sveltekit(),
    // Basic SSL enables HTTPS in dev for Telegram WebApp compatibility
    process.env.USE_HTTPS === 'true' ? basicSsl() : undefined
  ].filter(Boolean),

  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: process.env.VITE_API_URL || 'http://localhost:3002',
        changeOrigin: true
      }
    }
  }
});

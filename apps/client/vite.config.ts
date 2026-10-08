import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  // The repo-root .env holds VITE_* keys alongside the server keys.
  envDir: '../..',
  server: {
    // 5173 is taken by another local project; fail loudly instead of drifting to a random port.
    port: 5180,
    strictPort: true,
    proxy: {
      '/graphql': 'http://localhost:4000',
      // Kakao login: the session cookie is set on this origin, so the page and its /graphql calls share it.
      '/auth': 'http://localhost:4000',
      // Uploaded files (profile photos).
      '/media': 'http://localhost:4000',
    },
  },
});

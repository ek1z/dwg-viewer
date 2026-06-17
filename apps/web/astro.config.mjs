import { defineConfig } from 'astro/config';
import react from '@astrojs/react';

// https://astro.build/config
export default defineConfig({
  integrations: [react()],
  vite: {
    // three.js is large; let Vite pre-bundle it for faster dev cold starts.
    optimizeDeps: {
      include: ['three'],
    },
  },
});

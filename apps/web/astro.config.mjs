import { defineConfig } from 'astro/config';
import react from '@astrojs/react';

// https://astro.build/config
export default defineConfig({
  integrations: [react()],
  vite: {
    // three.js is large; let Vite pre-bundle it for faster dev cold starts.
    optimizeDeps: {
      include: ['three'],
      // The libredwg WASM glue resolves its .wasm via `new URL(..., import.meta.url)`;
      // esbuild pre-bundling rewrites that and breaks loading, so keep it raw. It is
      // dynamically imported, so this also keeps the ~7 MB payload out of the main bundle.
      exclude: ['@mlightcad/libredwg-web'],
    },
  },
});

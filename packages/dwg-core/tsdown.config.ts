import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  // package.json deps (incl. the WASM package) are externalized by default;
  // consumers bundle it and serve the .wasm.
});

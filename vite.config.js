import { defineConfig } from 'vite';

// Capacitor loads the built files from the app bundle, so use relative asset paths.
export default defineConfig({
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});

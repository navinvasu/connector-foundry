import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // @vir/* are source-only packages linked from libs/web-common (ADR 0003): keep the symlinked
  // path so their imports (react …) resolve from this app's node_modules.
  resolve: { preserveSymlinks: true, dedupe: ['react', 'react-dom'] },
  server: { port: 5174 },
});

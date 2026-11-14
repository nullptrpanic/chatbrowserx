import { crx } from '@crxjs/vite-plugin';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import manifest from './manifest.config.ts';

export default defineConfig(({ command }) => ({
  define: {
    'process.env.NODE_ENV': JSON.stringify(command === 'build' ? 'production' : 'development'),
  },
  plugins: [react(), crx({ manifest })],
  build: {
    // The framework core is ~762 kB minified. Keep its cyclic internals together and retain
    // a bounded 800 kB warning budget instead of unsafe size-based splitting in MV3 workers.
    chunkSizeWarningLimit: 800,
    rolldownOptions: {
      output: {
        // MV3 workers support static module imports. Keep the framework's vendor code separate
        // from extension entrypoints without runtime dynamic-import initialization.
        codeSplitting: {
          groups: [
            { name: 'model-transport', test: /node_modules\/openai\//, priority: 30 },
            { name: 'agent-core', test: /node_modules\/@openai\/agents-core\//, priority: 20 },
            {
              name: 'model-provider',
              test: /node_modules\/@openai\/agents-openai\//,
              priority: 10,
            },
          ],
        },
      },
    },
  },
}));

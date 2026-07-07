import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import wasm from 'vite-plugin-wasm';
import { viteStaticCopy } from 'vite-plugin-static-copy';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const dir = path.dirname(fileURLToPath(import.meta.url));

// The compiled contract artifacts (prover/verifier keys, zkir) live in the
// repo root's src/managed. Serve them under /contract/compiled/convert-vault
// so FetchZkConfigProvider can fetch them at proving time.
const managedSrc = path.resolve(dir, '..', 'src', 'managed');

export default defineConfig({
  define: {
    global: 'globalThis',
  },
  resolve: {
    alias: {
      process: 'process/browser',
      buffer: 'buffer',
      util: 'util',
      crypto: path.resolve(dir, 'src/lib/crypto-shim.ts'),
      stream: 'stream-browserify',
      events: 'events',
      // isomorphic-ws' browser build lacks a named WebSocket export the
      // indexer provider imports; map it to a shim exposing both forms.
      'isomorphic-ws': path.resolve(dir, 'src/lib/ws-shim.ts'),
    },
  },
  plugins: [
    react(),
    wasm(),
    viteStaticCopy({
      targets: [{ src: managedSrc, dest: 'contract/compiled', rename: 'convert-vault' }],
    }),
    {
      // Dev-only diagnostic sink: the dApp POSTs the exact balanced tx hex here
      // on a submission failure so it can be replayed against the node directly
      // (the wallet connector swallows the node's rejection reason).
      name: 'debug-tx-sink',
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (req.url === '/debug/last-tx' && req.method === 'POST') {
            const chunks: Buffer[] = [];
            req.on('data', (c) => chunks.push(c));
            req.on('end', () => {
              fs.writeFileSync(path.resolve(dir, '.debug-tx.hex'), Buffer.concat(chunks).toString('utf8'));
              res.statusCode = 204;
              res.end();
            });
            return;
          }
          next();
        });
      },
    },
    {
      // Dev server: return 404 for missing /contract/compiled/* assets instead
      // of the SPA fallback, so FetchZkConfigProvider sees a clean miss.
      name: 'contract-assets-404',
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (req.url?.startsWith('/contract/compiled/')) {
            const rel = req.url.replace('/contract/compiled/convert-vault', '');
            const filePath = path.join(managedSrc, rel.split('?')[0]);
            if (!fs.existsSync(filePath)) {
              res.statusCode = 404;
              res.end('404 Not Found');
              return;
            }
          }
          next();
        });
      },
    },
  ],
  optimizeDeps: {
    include: ['level', 'browser-level', 'abstract-level', 'level-supports', 'level-transcoder'],
    esbuildOptions: { target: 'esnext' },
  },
  build: { target: 'esnext' },
  worker: { format: 'es' },
  assetsInclude: ['**/*.wasm'],
  server: {
    fs: { allow: ['..'] },
  },
});

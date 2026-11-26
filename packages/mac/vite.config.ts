import { existsSync, readFileSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import react from '@vitejs/plugin-react';
import { type Plugin, defineConfig } from 'vite';
import { touchReveal } from './touch-reveal.js';

const repo = path.resolve(import.meta.dirname, '../..');

/**
 * In the browser (development, screenshots) there's no Tauri to ask where the daemon is:
 * the dev server reads ~/.beluga/daemon.json and hands the web view its port and token.
 * Only on localhost, only while developing.
 */
/** ~/.beluga, or the ~/.klaud from before the rename until the core has moved it (src/core/home.ts). */
function belugaHome(): string {
  const home = path.join(os.homedir(), '.beluga');
  const old = path.join(os.homedir(), '.klaud');
  return existsSync(home) || !existsSync(old) ? home : old;
}

function daemonEndpoint(): Plugin {
  return {
    name: 'beluga-daemon-endpoint',
    configureServer(server) {
      server.middlewares.use('/__beluga/endpoint', (_req, res) => {
        const home = process.env.BELUGA_HOME ?? process.env.KLAUD_HOME ?? belugaHome();
        try {
          const info = JSON.parse(readFileSync(path.join(home, 'daemon.json'), 'utf8')) as { port: number; token: string; version: string };
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ url: `ws://127.0.0.1:${info.port}`, token: info.token, version: info.version }));
        } catch {
          res.statusCode = 503;
          res.end(JSON.stringify({ error: 'Beluga is not running. Start it with: beluga daemon --keep-alive' }));
        }
      });
    },
  };
}

/**
 * What pdf.js loads as it needs it (wasm decoders for scanned pages and color profiles, the 14
 * standard fonts, CJK character maps), served from /pdfjs/ while developing and copied there in
 * a build. See src/views/reader/pdf-lib.ts.
 */
const PDFJS = path.join(import.meta.dirname, 'node_modules/pdfjs-dist');
const PDFJS_DIRS = ['wasm', 'cmaps', 'standard_fonts'];
function pdfjsAssets(): Plugin {
  return {
    name: 'beluga-pdfjs-assets',
    configureServer(server) {
      server.middlewares.use('/pdfjs', (req, res, next) => {
        const [dir, file] = (req.url ?? '').split('?')[0]!.replace(/^\//, '').split('/');
        if (!dir || !file || !PDFJS_DIRS.includes(dir) || file.includes('..')) return next();
        try {
          const body = readFileSync(path.join(PDFJS, dir, file));
          if (file.endsWith('.wasm')) res.setHeader('content-type', 'application/wasm');
          res.end(body);
        } catch {
          next();
        }
      });
    },
    generateBundle() {
      for (const dir of PDFJS_DIRS) {
        for (const file of readdirSync(path.join(PDFJS, dir))) {
          // (No PDF scripting: its JS engine stays out.)
          if ((file.startsWith('LICENSE') && dir !== 'wasm') || file.startsWith('quickjs')) continue;
          this.emitFile({ type: 'asset', fileName: `pdfjs/${dir}/${file}`, source: readFileSync(path.join(PDFJS, dir, file)) });
        }
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), daemonEndpoint(), pdfjsAssets()],
  // What a pointer reveals on hover, always shown on a touch screen (a phone's browser: BLG-6).
  css: { postcss: { plugins: [touchReveal()] } },
  resolve: { alias: { '@beluga': path.join(repo, 'src') } },
  clearScreen: false,
  // Loaded only when the first graph or chart shows (components/graph, components/views/Chart):
  // bundled up front, so that moment doesn't make the dev server reload the page.
  optimizeDeps: { include: ['@xyflow/react', 'elkjs/lib/elk-api.js', 'elkjs/lib/elk.bundled.js', 'elkjs/lib/elk-worker.min.js', 'recharts'] },
  worker: { format: 'es' },
  server: { port: 1420, strictPort: true, fs: { allow: [repo] } },
  build: {
    target: 'safari16',
    outDir: 'dist',
    sourcemap: true,
    // The window, the request pop-up's own window (src-tauri/src/popup.rs) and the floating call card (call_float.rs).
    rollupOptions: { input: { main: path.join(import.meta.dirname, 'index.html'), popup: path.join(import.meta.dirname, 'popup.html'), call: path.join(import.meta.dirname, 'call.html'), overlay: path.join(import.meta.dirname, 'overlay.html') } },
  },
});

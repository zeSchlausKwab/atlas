import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import { nip5aManifest } from '@napplet/vite-plugin';
export default defineConfig({
  build: { modulePreload: { polyfill: false } },
  plugins: [
    { name: 'bundled-atlas-wasm', resolveId(id) { if (id === 'atlas-renderer-wasm') return '\0atlas-renderer-wasm'; },
      load(id) { if (id === '\0atlas-renderer-wasm') return `export default ${JSON.stringify(readFileSync(new URL('../packages/renderer/pkg/atlas_renderer_bg.wasm', import.meta.url)).toString('base64'))};`; } },
    nip5aManifest({ nappletType: 'atlas-consumer', artifactMode: 'single-file' }),
  ],
});

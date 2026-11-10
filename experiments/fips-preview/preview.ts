import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parsePreviewConfig } from './protocol';
import { parseConsumerConfig } from './consumer-protocol';

if (!process.argv[2]) throw new Error('Usage: bun preview.ts CONFIG_JSON [PROJECT_PATH]');
const configPath = resolve(process.argv[2]);
const project = resolve(process.argv[3] ?? resolve(import.meta.dir, '../../atlas-consumer'));
const port = Number(process.env.ATLAS_PREVIEW_PORT ?? 4188);
const soyliRoot = process.env.ATLAS_SOYLI_SOURCE ?? resolve(import.meta.dir, '../../../napplet-space');
const transportModules = process.env.ATLAS_FIPS_MODULES ?? resolve(import.meta.dir, 'node_modules');
const rawConfig = await Bun.file(configPath).json();
const discovering = !!rawConfig && typeof rawConfig === 'object' && 'publisher' in rawConfig;
const config = discovering ? parseConsumerConfig(rawConfig) : parsePreviewConfig(rawConfig);
const { previewAssets } = await import(`${soyliRoot}/apps/cli/src/preview/assets.ts`);
const { startPreviewServer } = await import(`${soyliRoot}/apps/cli/src/preview/server.ts`);

const bridge = await Bun.build({
  entrypoints: [new URL(discovering ? './consumer-bridge.ts' : './bridge.ts', import.meta.url).pathname],
  target: 'browser', format: 'iife', minify: false,
  define: { ATLAS_PREVIEW_CONFIG: JSON.stringify(config) },
  plugins: discovering ? [] : [{ name: 'temporary-fips-dependencies', setup(build) {
    build.onResolve({ filter: /^@(fips|hashtree)\// }, (args) => ({
      path: Bun.resolveSync(args.path, resolve(transportModules, '..')),
    }));
  } }],
});
if (!bridge.success) throw new Error(`FIPS preview bridge build failed: ${bridge.logs.join('\n')}`);
const assets = await previewAssets();
// The bridge starts first in the trusted parent. Soyli still verifies and sandboxes the artifact.
assets.client = `${await bridge.outputs[0].text()}\n${assets.client}`;
const server = startPreviewServer(pathToFileURL(project + '/'), port, false, assets,
  { network: 'public', readOnly: true });
console.log(JSON.stringify({ previewUrl: server.url.href, project, config: configPath,
  ...('publisher' in config ? { publisher: config.publisher, relayUrls: config.relayUrls } :
    { providerPeerId: config.providerPeerId, rootHash: config.map.rootHash }) }));

import { afterEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { prepareConsumerRelease } from '../scripts/prepare-consumer-release';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function fixture(importPath = '../../packages/view/src/index') {
  const root = await mkdtemp(join(tmpdir(), 'atlas-consumer-export-'));
  roots.push(root);
  const repo = join(root, 'repo');
  await mkdir(repo);
  const files: Record<string, string> = {
    'package.json': JSON.stringify({
      name: 'atlas',
      scripts: { 'build:wasm': 'wasm-pack build' },
      dependencies: { example: '1.0.0' },
    }),
    'bun.lock': 'locked-atlas',
    'Cargo.toml':
      '[workspace]\nmembers = ["crates/renderer", "crates/routing", "crates/routing-wasm", "crates/osm-import"]\nresolver = "2"\n',
    'Cargo.lock': 'locked-rust',
    'atlas-consumer/package.json': JSON.stringify({ packageManager: 'pnpm@10.8.0' }),
    'atlas-consumer/pnpm-lock.yaml': 'locked-consumer',
    'atlas-consumer/napplet.json': JSON.stringify({ title: 'Atlas map viewer', license: 'MIT' }),
    'atlas-consumer/src/main.ts': `import { view } from '${importPath}';\nconsole.log(view);`,
    'atlas-consumer/LICENSE': 'Upstream starter license',
    'packages/view/src/index.ts': 'export { view } from "./value.js";',
    'packages/view/src/value.ts': 'export const view = "committed";',
    'crates/renderer/src/lib.rs': 'pub fn render() {}',
    'crates/routing/src/lib.rs': 'pub fn route() {}',
    'crates/routing-wasm/src/lib.rs': 'pub fn route_wasm() {}',
    'crates/osm-import/src/lib.rs': '// Private compiler implementation',
    'packages/admin/src/index.ts': '// Private administration implementation',
    'apps/server/index.ts': '// Private server implementation',
    '.env.example': 'PRIVATE_CONFIGURATION=not-a-real-key',
  };
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(repo, path)), { recursive: true });
    await writeFile(join(repo, path), text);
  }
  const git = (args: string[]) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' });
  git(['init']);
  git(['add', '.']);
  git(['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'Fixture']);
  const commit = git(['rev-parse', 'HEAD']).toString().trim();
  for (const [part, name] of [
    ['renderer', 'atlas_renderer'],
    ['routing', 'atlas_routing_wasm'],
  ]) {
    const dir = join(repo, 'packages', part, 'pkg');
    await mkdir(dir, { recursive: true });
    for (const suffix of ['.js', '.d.ts', '_bg.wasm.d.ts'])
      await writeFile(join(dir, name + suffix), 'export {};');
    await writeFile(join(dir, name + '_bg.wasm'), Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]));
  }
  return { root, repo, commit, output: join(root, 'export') };
}

test('publication export preserves the committed dependency closure and excludes private server/history/configuration', async () => {
  const f = await fixture();
  await writeFile(
    join(f.repo, 'packages/view/src/value.ts'),
    'export const view = "UNCOMMITTED_SENTINEL";',
  );
  const result = await prepareConsumerRelease({ ...f, ref: f.commit });
  expect(result.commit).toBe(f.commit);
  expect(await readFile(join(f.output, 'packages/view/src/value.ts'), 'utf8')).toContain(
    '"committed"',
  );
  const paths = JSON.parse(await readFile(join(f.output, 'SOURCE-INVENTORY.json'), 'utf8')).map(
    (file: { path: string }) => file.path,
  );
  expect(paths).toContain('app/src/main.ts');
  expect(paths).toContain('packages/view/src/value.ts');
  expect(paths).toContain('crates/renderer/src/lib.rs');
  expect(paths).not.toContain('crates/osm-import/src/lib.rs');
  expect(paths).not.toContain('packages/admin/src/index.ts');
  expect(paths).not.toContain('apps/server/index.ts');
  expect(paths).not.toContain('.env.example');
  expect(await readdir(f.output)).not.toContain('.git');
  expect(await readFile(join(f.output, 'Cargo.toml'), 'utf8')).not.toContain('osm-import');
  const project = JSON.parse(await readFile(join(f.output, 'napplet.json'), 'utf8'));
  expect(project.build.command).toEqual(['bun', 'scripts/build-consumer.ts']);
  expect(project.license).toBe('LicenseRef-Atlas-Review-Required');
  const provenance = JSON.parse(await readFile(join(f.output, 'SOURCE-PROVENANCE.json'), 'utf8'));
  expect(provenance.prebuiltArtifacts).toHaveLength(8);
  expect(
    provenance.prebuiltArtifacts.every((a: { sha256: string }) => /^[a-f0-9]{64}$/.test(a.sha256)),
  ).toBe(true);
  await expect(prepareConsumerRelease({ ...f, ref: f.commit })).rejects.toThrow(
    'Output directory must be empty',
  );
});

test('publication export fails before writing when a committed relative dependency is missing', async () => {
  const f = await fixture('../../packages/missing/src/index');
  await expect(prepareConsumerRelease(f)).rejects.toThrow('Missing committed dependency');
  await expect(readdir(f.output)).rejects.toMatchObject({ code: 'ENOENT' });
});

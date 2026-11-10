#!/usr/bin/env bun
/** Export an exact Atlas revision as a standalone soyLI publication workspace.
 * No source Git history, private configuration, publication or network operations.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { posix } from 'node:path';
import ts from 'typescript';

const WASM_FILES = [
  'packages/renderer/pkg/atlas_renderer.js',
  'packages/renderer/pkg/atlas_renderer.d.ts',
  'packages/renderer/pkg/atlas_renderer_bg.wasm',
  'packages/renderer/pkg/atlas_renderer_bg.wasm.d.ts',
  'packages/routing/pkg/atlas_routing_wasm.js',
  'packages/routing/pkg/atlas_routing_wasm.d.ts',
  'packages/routing/pkg/atlas_routing_wasm_bg.wasm',
  'packages/routing/pkg/atlas_routing_wasm_bg.wasm.d.ts',
] as const;
const hash = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
const git = (repo: string, args: string[]) =>
  execFileSync('git', ['-C', repo, ...args], { maxBuffer: 32 * 1024 * 1024 });

export async function prepareConsumerRelease(options: {
  repo: string;
  output: string;
  ref?: string;
  wasmRoot?: string;
}) {
  const repo = resolve(options.repo),
    output = resolve(options.output);
  const commit = git(repo, ['rev-parse', '--verify', `${options.ref ?? 'HEAD'}^{commit}`])
    .toString()
    .trim();
  const entries = git(repo, ['ls-tree', '-r', '-z', commit]).toString().split('\0').filter(Boolean);
  const source = new Map<string, Buffer>();
  const files = new Map<string, Buffer>();
  for (const entry of entries) {
    const match = /^(100644|100755) blob ([a-f0-9]{40})\t(.+)$/.exec(entry);
    if (!match) continue;
    const [, , object, path] = match;
    if (
      path
        .split('/')
        .some((part) =>
          /^(?:\.env(?:\..*)?|\.git|\.napplet-space|node_modules|target|dist)$/.test(part),
        )
    )
      continue;
    source.set(path, git(repo, ['cat-file', 'blob', object]));
    const selected =
      path.startsWith('atlas-consumer/') ||
      /^crates\/(renderer|routing|routing-wasm)\//.test(path) ||
      ['Cargo.toml', 'Cargo.lock', 'package.json', 'bun.lock'].includes(path);
    if (!selected) continue;
    const target = path.startsWith('atlas-consumer/')
      ? `app/${path.slice('atlas-consumer/'.length)}`
      : path;
    files.set(target, source.get(path)!);
  }
  const artifacts: Array<{ path: string; sha256: string; bytes: number }> = [];
  for (const path of WASM_FILES) {
    const bytes = await readFile(join(options.wasmRoot ?? repo, path));
    if (path.endsWith('.wasm') && !bytes.subarray(0, 4).equals(Buffer.from([0, 97, 115, 109])))
      throw new Error(`Invalid WASM artifact: ${path}`);
    source.set(path, bytes);
    files.set(path, bytes);
    artifacts.push({ path, sha256: hash(bytes), bytes: bytes.length });
  }
  // Include only the consumer's transitive source/type imports, never host/admin,
  // compiler, deployment, or unrelated private project source by directory sweep.
  const queue = [...source.keys()].filter(
    (path) =>
      /^atlas-consumer\/(?:src\/|tests\/|vite\.config)/.test(path) && /\.[cm]?[jt]sx?$/.test(path),
  );
  const visited = new Set<string>();
  while (queue.length) {
    const path = queue.pop()!;
    if (visited.has(path)) continue;
    visited.add(path);
    const bytes = source.get(path)!;
    if (!path.startsWith('atlas-consumer/')) files.set(path, bytes);
    if (!/\.[cm]?[jt]sx?$/.test(path)) continue;
    for (const reference of ts.preProcessFile(bytes.toString(), true, true).importedFiles) {
      const spec = reference.fileName;
      if (!spec.startsWith('.')) continue;
      const base = posix.normalize(posix.join(posix.dirname(path), spec.split('?')[0]));
      const candidates = [
        base.replace(/\.js$/, '.ts'),
        base,
        `${base}.ts`,
        `${base}.tsx`,
        `${base}.js`,
        `${base}.d.ts`,
        `${base}/index.ts`,
      ];
      const dependency = candidates.find((candidate) => source.has(candidate));
      if (!dependency) throw new Error(`Missing committed dependency: ${path} → ${spec}`);
      if (!dependency.startsWith('packages/') && !dependency.startsWith('atlas-consumer/'))
        throw new Error(`Unexpected consumer dependency: ${dependency}`);
      queue.push(dependency);
      const declaration = dependency.replace(/\.js$/, '.d.ts');
      if (declaration !== dependency && source.has(declaration)) queue.push(declaration);
    }
  }
  const cargo = files.get('Cargo.toml')?.toString();
  if (!cargo || !/members\s*=\s*\[[\s\S]*?\]/.test(cargo))
    throw new Error('Missing Cargo workspace members.');
  files.set(
    'Cargo.toml',
    Buffer.from(
      cargo.replace(
        /members\s*=\s*\[[\s\S]*?\]/,
        'members = ["crates/renderer", "crates/routing", "crates/routing-wasm"]',
      ),
    ),
  );
  const getJSON = (path: string) => {
    const bytes = files.get(path);
    if (!bytes) throw new Error(`The selected revision has no ${path}.`);
    return JSON.parse(bytes.toString());
  };
  const app = getJSON('app/package.json');
  const atlas = getJSON('package.json');
  const project = getJSON('app/napplet.json');
  if (!/^pnpm@\d+\.\d+\.\d+$/.test(app.packageManager ?? ''))
    throw new Error('The consumer must pin its pnpm version.');
  if (!files.has('bun.lock') || !files.has('app/pnpm-lock.yaml'))
    throw new Error('Both frozen dependency lockfiles are required.');
  const index = files.get('app/index.html');
  if (!index) throw new Error('The consumer source index.html is required.');
  // soyLI keeps a root source entry even for custom builds with dist/index.html.
  // The app's actual Vite build still uses app/index.html unchanged.
  files.set(
    'index.html',
    Buffer.from(index.toString().replaceAll('src="/src/', 'src="./app/src/')),
  );
  const json = (path: string, value: unknown) =>
    files.set(path, Buffer.from(`${JSON.stringify(value, null, 2)}\n`));
  // Keep both dependency graphs unchanged; script changes do not alter either lockfile.
  json('package.json', {
    ...atlas,
    scripts: {
      setup: 'bun scripts/setup-consumer.ts',
      build: 'bun scripts/build-consumer.ts',
      'build:wasm': atlas.scripts['build:wasm'],
      verify: 'bun scripts/verify-consumer.ts',
    },
  });
  json('napplet.json', {
    ...project,
    license: 'MIT',
    build: {
      kind: 'command',
      command: ['bun', 'scripts/build-consumer.ts'],
      timeoutSeconds: 300,
      watch: ['app/src', 'app/index.html', 'app/vite.config.ts', 'packages'],
    },
  });
  files.set(
    '.gitignore',
    Buffer.from(
      'node_modules/\ndist/\ntarget/\n.napplet-space/\napp/node_modules/\napp/dist/\n.env\n.env.*\n.DS_Store\n',
    ),
  );
  const command = `import { spawnSync } from 'node:child_process';\nimport { resolve } from 'node:path';\nconst root = resolve(import.meta.dir, '..');\nfunction run(command: string, args: string[], cwd = root) {\n  const result = spawnSync(command, args, { cwd, stdio: 'inherit', env: process.env });\n  if (result.error) throw result.error;\n  if (result.status !== 0) throw new Error(command + ' failed (exit ' + result.status + ').');\n}\n`;
  const pnpm = app.packageManager;
  files.set(
    'scripts/setup-consumer.ts',
    Buffer.from(
      command +
        `run('bun', ['install', '--frozen-lockfile', '--ignore-scripts']);\nrun('bunx', ['${pnpm}', 'install', '--frozen-lockfile', '--ignore-scripts'], resolve(root, 'app'));\n`,
    ),
  );
  files.set(
    'scripts/build-consumer.ts',
    Buffer.from(
      command +
        `import { cp, mkdir } from 'node:fs/promises';\nrun('bunx', ['${pnpm}', 'run', 'build'], resolve(root, 'app'));\nawait mkdir(resolve(root, 'dist'), { recursive: true });\nawait cp(resolve(root, 'app/dist'), resolve(root, 'dist'), { recursive: true });\n`,
    ),
  );
  files.set(
    'scripts/verify-consumer.ts',
    Buffer.from(
      command +
        `run('bunx', ['${pnpm}', 'run', 'verify'], resolve(root, 'app'));\nrun('bun', ['scripts/build-consumer.ts']);\n`,
    ),
  );
  files.set(
    'AGENTS.md',
    Buffer.from(
      '# Atlas map viewer publication workspace\n\nRead README.md and app/AGENTS.md. The app lives in app/ and shared source in packages/.\nRun bun run setup once, then bun run verify and soyli check.\nNever re-scaffold. Source provenance is recorded in SOURCE-PROVENANCE.json.\n',
    ),
  );
  files.set(
    'LICENSE',
    Buffer.from(
      "MIT License\n\nCopyright (c) 2026 Schlaus Kwab and Atlas contributors\n\nPermission is hereby granted, free of charge, to any person obtaining a copy\nof this software and associated documentation files (the \"Software\"), to deal\nin the Software without restriction, including without limitation the rights\nto use, copy, modify, merge, publish, distribute, sublicense, and/or sell\ncopies of the Software, and to permit persons to whom the Software is\nfurnished to do so, subject to the following conditions:\n\nThe above copyright notice and this permission notice shall be included in all\ncopies or substantial portions of the Software.\n\nTHE SOFTWARE IS PROVIDED \"AS IS\", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR\nIMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,\nFITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE\nAUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER\nLIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,\nOUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE\nSOFTWARE.\n\n",
    ),
  );
  files.set(
    'README.md',
    Buffer.from(
      `# Atlas map viewer\n\nStandalone publication source exported from Atlas commit \`${commit}\`.\nThe complete consumer, shared TypeScript, Rust source and reviewed prebuilt WASM\nare included; no sibling checkout or Atlas server administration is needed.\n\n## License\n\nThis consumer-only export is MIT licensed by its owner (10 November 2026).\nBundled third-party notices retain their original scope. This grant does not\nlicense the private Atlas repository or the excluded server/compiler code.\n\n## Build and preview\n\nRequires Bun 1.3+ and Git. Setup installs the root Bun lockfile and the app's\npinned ${pnpm} lockfile; no unpinned project dependencies are resolved.\n\n\`\`\`sh\nbun run setup\nbun run verify\nsoyli check\nsoyli dev\n\`\`\`\n\nThis is a custom command build: soyli setup does not install its dependencies.\nHosted Studio/browser builders require an Atlas-capable toolchain; use the local\nflow above when that profile is unavailable.\n\n## Renderer source and provenance\n\nSOURCE-PROVENANCE.json records the source revision and SHA-256 of the supplied\nWASM and generated bindings. They are reviewed release inputs, not a claim of\nbit-for-bit compiler reproducibility. To regenerate them, install stable Rust,\nthe wasm32-unknown-unknown target and wasm-pack, then run \`bun run build:wasm\`\nand \`bun run verify\`. Cargo.toml, Cargo.lock and every workspace crate are included.\n\n## Publish\n\nCreate a new Git repository in this exported directory, review all files, and\ncommit before using soyli publish. Do not publish from Atlas's nested consumer\ndirectory: its source references the surrounding monorepo. The exported source\narchive is self-contained; the original Atlas repository and history are unchanged.\nCapture a representative loaded map before publishing. Shell support is experimental\n\`soy.fips/1\`; compatible shell/soyLI must ship before this napplet.\n\nRead app/README.md for signed discovery, consent, controls and verification limits.\n`,
    ),
  );
  json('SOURCE-PROVENANCE.json', {
    schema: 'atlas-consumer-source/v1',
    repository: 'https://github.com/zeSchlausKwab/atlas',
    commit,
    license: 'MIT',
    licenseScope: 'consumer export only; owner authorization 2026-11-10',
    exports: [
      'atlas-consumer/ → app/',
      'transitive consumer source/type imports only',
      'renderer/routing Rust source and manifests',
      'bun.lock',
    ],
    generated: ['root publication configuration, source entry, command wrappers and README'],
    prebuiltArtifacts: artifacts,
    rebuild: 'bun run build:wasm && bun run verify',
  });
  json(
    'SOURCE-INVENTORY.json',
    [...files.entries()]
      .map(([path, bytes]) => ({ path, bytes: bytes.length, sha256: hash(bytes) }))
      .sort((a, b) => a.path.localeCompare(b.path)),
  );
  const existing = await readdir(output).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  if (existing.length)
    throw new Error('Output directory must be empty; existing work is never overwritten.');
  await mkdir(output, { recursive: true });
  for (const [path, bytes] of files) {
    await mkdir(dirname(join(output, path)), { recursive: true });
    await writeFile(join(output, path), bytes);
  }
  return {
    commit,
    files: files.size,
    bytes: [...files.values()].reduce((total, bytes) => total + bytes.length, 0),
    output,
  };
}

if (import.meta.main) {
  const [output, ref = 'HEAD'] = process.argv.slice(2);
  if (!output)
    throw new Error('Usage: bun scripts/prepare-consumer-release.ts OUTPUT_DIRECTORY [COMMIT]');
  console.log(
    JSON.stringify(
      await prepareConsumerRelease({ repo: resolve(import.meta.dir, '..'), output, ref }),
      null,
      2,
    ),
  );
}

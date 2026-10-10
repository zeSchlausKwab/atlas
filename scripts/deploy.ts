#!/usr/bin/env bun
/** Deploy the current working tree to the NixOS demo host, without Git pushes. */
import { cp, lstat, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { deployablePath, parseDeployArgs, shellQuote } from "./deploy-support";
const repo = fileURLToPath(new URL("../", import.meta.url));
const q = shellQuote;

async function run(cmd: string[], capture = false) {
  const p = Bun.spawn(cmd, {
    cwd: repo,
    stdin: "inherit",
    stdout: capture ? "pipe" : Bun.stderr,
    stderr: "inherit",
  });
  const output = capture
    ? new Response(p.stdout as ReadableStream).text()
    : Promise.resolve("");
  const [code, value] = await Promise.all([p.exited, output]);
  if (code) throw new Error(`${cmd[0]} failed (exit ${code})`);
  return value.trim();
}
async function sha(path: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
async function main() {
  const o = parseDeployArgs(process.argv.slice(2));
  const ssh = (command: string, capture = false) =>
    run(
      [
        "ssh",
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=10",
        "-o",
        "ServerAliveInterval=15",
        "-o",
        "ServerAliveCountMax=3",
        o.host,
        command,
      ],
      capture,
    );
  const report = (value: unknown) =>
    console.log(
      o.format === "json"
        ? JSON.stringify(value, null, 2)
        : typeof value === "string"
          ? value
          : JSON.stringify(value, null, 2),
    );
  if (o.command === "help") {
    console.log(`Atlas deployment — NixOS over SSH

Usage: bun run deploy [deploy|status|logs|tunnel|rollback] [options]

  --host user@host       Default: nixuser@192.168.0.179
  --root /absolute/path Default: /home/nixuser/atlas
  --port 3100           Server port
  --local-port 13100    Local port for the SSH tunnel
  --map FILE.atlas      Upload and select the base map (required on first deploy)
  --with-library        Also upload ready maps/records from data/hosted
  --resume RELEASE_ID   Resume an interrupted, never-activated release
  --upload-mib N        Optional transfer limit in MiB/s
  --dry-run             Print the plan; no builds, network or changes
  --skip-checks         Skip local tests/typecheck; WASM is still rebuilt
  --format md|json      Result format (progress goes to stderr)

Examples:
  bun run deploy --dry-run --map=data/vienna-plus.atlas --with-library
  bun run deploy --map data/vienna-plus.atlas --with-library
  bun run deploy                    # code update; keeps existing server data
  bun run deploy tunnel             # keep open; visit http://127.0.0.1:13100
  bun run deploy status
  bun run deploy rollback           # previous code release; data stays in place

Includes tracked modifications and non-ignored new files; no commit required.
Excludes source data, dependencies, native Mac binaries and environment secrets.
Uses a user service. No sudo, firewall changes or public announcements.
`);
    return;
  }
  const files =
    o.command === "deploy"
      ? (
          await run(
            [
              "git",
              "ls-files",
              "--cached",
              "--others",
              "--exclude-standard",
              "-z",
            ],
            true,
          )
        )
          .split("\0")
          .filter(deployablePath)
      : [];
  const plan = {
    command: o.command,
    host: o.host,
    root: o.root,
    port: o.port,
    browser: `http://127.0.0.1:${o.localPort}/`,
    sourceFiles: files.length,
    map: o.map ?? "keep the current base map",
    library: o.withLibrary,
    resume: o.resume,
    uploadMiB: o.uploadMiB,
    checks: !o.skipChecks,
    dryRun: o.dryRun,
    steps:
      o.command === "deploy"
        ? [
            "Check the working tree and rebuild portable WASM",
            "Upload a separate release and optional maps over SSH",
            "Resolve a Nix runtime, install locked dependencies, build Linux importers",
            "Smoke-test the candidate on a temporary loopback port",
            "Refuse active preparations, switch release, restart and verify; restore on failure",
          ]
        : [o.command],
  };
  if (o.dryRun) {
    report(plan);
    return;
  }
  if (o.command === "tunnel") {
    console.error(
      `Atlas workspace and host console: http://127.0.0.1:${o.localPort}/`,
    );
    await run([
      "ssh",
      "-o",
      "BatchMode=yes",
      "-o",
      "ExitOnForwardFailure=yes",
      "-N",
      "-L",
      `127.0.0.1:${o.localPort}:127.0.0.1:${o.port}`,
      o.host,
    ]);
    return;
  }
  if (o.command === "logs") {
    await ssh("journalctl --user -u atlas.service -n 100 --no-pager");
    return;
  }
  if (o.command === "status") {
    const command =
      `test -x ${q(o.root + "/current/.runtime/bin/bun")} && ` +
      `${q(o.root + "/current/.runtime/bin/bun")} ${q(o.root + "/current/deploy/activate.ts")} status ${q(o.root)} ${o.port}`;
    report(JSON.parse(await ssh(command, true)));
    return;
  }
  if (o.command === "rollback") {
    report(
      JSON.parse(
        await ssh(
          `flock -n ${q(o.root + "/.activation.lock")} ${q(o.root + "/current/.runtime/bin/bun")} ${q(o.root + "/current/deploy/activate.ts")} rollback ${q(o.root)} ${o.port}`,
          true,
        ),
      ),
    );
    return;
  }

  if (o.map && !(await Bun.file(resolve(repo, o.map)).exists()))
    throw new Error(`Map not found: ${o.map}`);
  if (!o.skipChecks) {
    await run(["bun", "run", "typecheck"]);
    await run(["bun", "test"]);
    await run(["cargo", "test", "--workspace", "--locked"]);
  }
  await run(["bun", "run", "build:wasm"]);
  await run(["bun", "run", "build:web"]);
  const stage = await mkdtemp(join(tmpdir(), "atlas-deploy-"));
  const revision = await run(["git", "rev-parse", "--short=12", "HEAD"], true);
  const id =
    o.resume ??
    new Date().toISOString().replace(/[-:.]/g, "") +
      "-" +
      revision +
      "-" +
      randomUUID().slice(0, 8);
  const release = `${o.root}/releases/${id}`;
  let locked = false;
  try {
    const records: Array<{ path: string; sha256: string; bytes: number }> = [];
    async function copy(source: string, path: string) {
      const info = await lstat(source);
      if (!info.isFile())
        throw new Error(`Deployment expects a regular file: ${source}`);
      const target = join(stage, path);
      await mkdir(dirname(target), { recursive: true });
      await cp(source, target);
      records.push({ path, sha256: await sha(target), bytes: info.size });
    }
    for (const path of new Set(files)) {
      if (await Bun.file(join(repo, path)).exists())
        await copy(join(repo, path), path);
    }
    for (const module of ["renderer", "routing"]) {
      const dir = `packages/${module}/pkg`;
      for (const file of await readdir(join(repo, dir)))
        if (/\.(wasm|js|ts|json)$/.test(file))
          await copy(join(repo, dir, file), `${dir}/${file}`);
    }
    let map: { path: string; sha256: string } | undefined;
    if (o.map) {
      await copy(resolve(repo, o.map), ".incoming/base.atlas");
      map = { path: ".incoming/base.atlas", sha256: records.at(-1)!.sha256 };
    }
    const library: string[] = [];
    if (o.withLibrary) {
      for (const name of await readdir(join(repo, "data/hosted"))) {
        if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue;
        const job = await Bun.file(join(repo, "data/hosted", name)).json();
        if (job.state !== "ready") continue;
        if (name !== `${job.id}.json`)
          throw new Error(`Invalid library record: ${name}`);
        library.push(job.id);
        await copy(join(repo, "data/hosted", name), `.incoming/hosted/${name}`);
        await copy(
          join(repo, "data/hosted", `${job.id}.atlas`),
          `.incoming/hosted/${job.id}.atlas`,
        );
      }
    }
    const metadata = {
      id,
      revision,
      dirty: !!(await run(["git", "status", "--porcelain"], true)),
      createdAt: new Date().toISOString(),
      map,
      library,
      files: records,
    };
    await mkdir(join(stage, "deploy"), { recursive: true });
    await Bun.write(
      join(stage, "deploy/manifest.json"),
      JSON.stringify(metadata),
    );
    console.error(
      `Staged ${records.length} files, ${(records.reduce((n, f) => n + f.bytes, 0) / 1073741824).toFixed(2)} GiB. Release ${id}`,
    );
    await ssh(
      `set -eu; umask 077; mkdir -p ${q(o.root)}; mkdir ${q(o.root + "/.deploy-lock")} || { echo 'Another deployment holds .deploy-lock; inspect before removing it.' >&2; exit 1; }`,
    );
    locked = true;
    if (o.resume) {
      await ssh(
        `set -eu; flock -n ${q(o.root + "/.activation.lock")} true; test -d ${q(release)}; test ! -e ${q(release + "/deploy/activated.json")}; test "$(readlink -f ${q(o.root + "/current")} || true)" != ${q(release)}; test "$(readlink -f ${q(o.root + "/previous")} || true)" != ${q(release)}`,
      );
    } else {
      await ssh(`mkdir -p ${q(o.root + "/releases")}; mkdir ${q(release)}`);
    }
    await ssh(
      `mkdir -p ${q(o.root + "/shared/data")} ${q(o.root + "/shared/maps")}`,
    );
    const upload = [
      "rsync",
      "-rlt",
      "--checksum",
      "--delete",
      "--exclude=.runtime",
      "--exclude=target/",
      "--exclude=node_modules/",
      "--exclude=dist/",
      "--exclude=.smoke-data/",
      "--timeout=60",
      ...(o.uploadMiB ? [`--bwlimit=${o.uploadMiB * 1024}`] : []),
      "--rsync-path",
      `flock -w 75 ${q(o.root + "/.upload.lock")} rsync`,
      "--stats",
      "--partial-dir=.rsync-partial",
      "--chmod=Du=rwx,Dgo=,Fu=rw,Fgo=",
      "-e",
      "ssh -o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=15 -o ServerAliveCountMax=3",
      stage + "/",
      `${o.host}:${release}/`,
    ];
    for (let attempt = 1; ; attempt++) {
      try {
        await run(upload);
        break;
      } catch (error) {
        if (attempt >= 3) throw error;
        console.error(
          `Transfer interrupted; retry ${attempt + 1}/3 reuses received data.`,
        );
        await Bun.sleep(2000);
      }
    }
    const command =
      `set -eu; cd ${q(release)}; nix-build deploy/runtime.nix --out-link .runtime >&2; ` +
      `.runtime/bin/bun deploy/activate.ts deploy ${q(o.root)} ${o.port}`;
    report(
      JSON.parse(
        await ssh(
          `flock -n ${q(o.root + "/.activation.lock")} bash -c ${q(command)}`,
          true,
        ),
      ),
    );
    console.error(
      `Open the demo with: bun run deploy tunnel --local-port ${o.localPort}`,
    );
  } catch (error) {
    console.error(
      `To retry this unused release, repeat the deploy options with --resume ${id}.`,
    );
    throw error;
  } finally {
    if (locked)
      await ssh(`rmdir ${q(o.root + "/.deploy-lock")}`).catch((error) =>
        console.error(`Deployment lock cleanup: ${error}`),
      );
    await rm(stage, { recursive: true, force: true });
  }
}

if (import.meta.main)
  main().catch((error) => {
    console.error(`Error: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  });

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  chmod,
  mkdir,
  readlink,
  realpath,
  rename,
  rm,
  statfs,
  symlink,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { managedUnit } from "../scripts/deploy-support";

interface Metadata {
  id: string;
  revision: string;
  dirty: boolean;
  createdAt: string;
  map?: { path: string; sha256: string };
  library: string[];
  files: Array<{ path: string; sha256: string; bytes: number }>;
}
interface Settings {
  root: string;
  port: number;
  mapPath: string;
}
const release = fileURLToPath(new URL("../", import.meta.url));
const [command, root = "", rawPort = "3100"] = process.argv.slice(2);
const port = Number(rawPort);
if (
  !/^\/[A-Za-z0-9_/-]+$/.test(root) ||
  resolve(root) !== root ||
  root.split("/").length < 4 ||
  !Number.isInteger(port) ||
  port < 1024 ||
  port > 65535
)
  throw new Error("Invalid deployment root or port");
const unitPath = join(process.env.HOME!, ".config/systemd/user/atlas.service");

async function run(
  cmd: string[],
  cwd = release,
  env: NodeJS.ProcessEnv = process.env,
  capture = false,
) {
  const p = Bun.spawn(cmd, {
    cwd,
    env,
    stdin: "ignore",
    stdout: capture ? "pipe" : Bun.stderr,
    stderr: "inherit",
  });
  const output = capture
    ? new Response(p.stdout as ReadableStream).text()
    : Promise.resolve("");
  const [code, value] = await Promise.all([p.exited, output]);
  if (code) throw new Error(`${cmd[0]} ${cmd[1] ?? ""} failed (exit ${code})`);
  return value.trim();
}
async function hash(path: string) {
  const h = createHash("sha256");
  for await (const chunk of createReadStream(path)) h.update(chunk);
  return h.digest("hex");
}
async function link(target: string, path: string) {
  const temp = path + ".next";
  await rm(temp, { force: true });
  await symlink(target, temp);
  await rename(temp, path);
}
async function getHealth(url = `http://127.0.0.1:${port}`) {
  const r = await fetch(url + "/health", { signal: AbortSignal.timeout(3000) });
  if (!r.ok) throw new Error(`Health returned ${r.status}`);
  return (await r.json()) as {
    ok: boolean;
    release: string | null;
    name: string;
    bytes: number;
  };
}
async function awaitHealth(id: string) {
  const deadline = Date.now() + 45000;
  let error: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await getHealth();
      if (value.ok && value.release === id) return value;
      error = new Error(`Expected release ${id}, received ${value.release}`);
    } catch (e) {
      error = e;
    }
    await Bun.sleep(250);
  }
  throw new Error(`Release did not become healthy: ${error}`);
}
async function currentPath() {
  return await realpath(join(root, "current")).catch(() => undefined);
}
async function smoke(target: string, settings: Settings, id: string) {
  const data = join(target, ".smoke-data");
  await mkdir(data, { recursive: true });
  const p = Bun.spawn(
    [join(target, ".runtime/bin/bun"), "apps/server/index.ts"],
    {
      cwd: target,
      env: {
        ...process.env,
        PATH: `${target}/.runtime/bin:/run/current-system/sw/bin`,
        HOST: "127.0.0.1",
        PORT: "0",
        ATLAS_FILE: settings.mapPath,
        ATLAS_DATA_DIR: data,
        ATLAS_HOST_POLICY: join(data, "policy.json"),
        ATLAS_RELEASE: id,
        ATLAS_CVM_SECRET: "",
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  let output = "";
  const errors = new Response(p.stderr).text();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const started = (async () => {
      const stdout = p.stdout.getReader();
      try {
        while (true) {
          const { done, value: bytes } = await stdout.read();
          if (done) break;
          output = (output + new TextDecoder().decode(bytes)).slice(-8000);
          const match = output.match(/ATLAS lab → (http:\/\/127\.0\.0\.1:\d+)/);
          if (match) return match[1]!;
        }
      } finally {
        stdout.releaseLock();
      }
      throw new Error(`Candidate exited before listening: ${await errors}`);
    })();
    const url = await Promise.race([
      started,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Candidate startup timed out")),
          45000,
        );
      }),
    ]);
    const health = await getHealth(url);
    if (!health.ok || health.release !== id)
      throw new Error("Candidate release mismatch");
    for (const path of [
      "/",
      "/host",
      "/main.js",
      "/host.js",
      "/catalog",
      "/wasm/atlas_renderer_bg.wasm",
      "/wasm/atlas_routing_wasm_bg.wasm",
    ]) {
      const response = await fetch(url + path, {
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok)
        throw new Error(`Candidate ${path}: ${response.status}`);
      await response.arrayBuffer();
    }
    const range = await fetch(url + "/maps/demo.atlas", {
      headers: { Range: "bytes=0-31" },
      signal: AbortSignal.timeout(5000),
    });
    if (range.status !== 206 || (await range.arrayBuffer()).byteLength !== 32)
      throw new Error("Candidate does not serve correct Atlas byte ranges");
    const admin = await fetch(url + "/admin/preparations", {
      signal: AbortSignal.timeout(5000),
    });
    const state = (await admin.json()) as { globalSource?: { ready: boolean } };
    if (!admin.ok || !state.globalSource?.ready)
      throw new Error("Native preparation tools are unavailable");
    console.error(
      `Candidate ${id}: UI, WASM, catalog, byte ranges and preparation prerequisites passed.`,
    );
  } finally {
    clearTimeout(timer);
    p.kill();
    await p.exited;
    await errors;
    await rm(data, { recursive: true, force: true });
  }
}
async function noActivePreparations() {
  const existing = await currentPath();
  if (!existing) return;
  const active = await run(
    [
      "systemctl",
      "--user",
      "show",
      "atlas.service",
      "--property=ActiveState",
      "--value",
    ],
    release,
    process.env,
    true,
  );
  if (["inactive", "failed"].includes(active)) return;
  const r = await fetch(`http://127.0.0.1:${port}/admin/preparations`, {
    signal: AbortSignal.timeout(5000),
  });
  if (!r.ok)
    throw new Error("Cannot check active preparations; refusing restart");
  const state = (await r.json()) as { jobs: Array<{ state: string }> };
  if (state.jobs.some((j) => ["running", "cancelling"].includes(j.state)))
    throw new Error(
      "A map preparation is active. Wait for it or cancel it in the host console, then deploy again.",
    );
}
async function activate(
  target: string,
  settings: Settings,
  id: string,
  beforeSwitch?: () => Promise<void>,
) {
  const old = await currentPath();
  const previousUnit = await Bun.file(unitPath)
    .text()
    .catch(() => undefined);
  if (previousUnit && !previousUnit.startsWith(`# Managed by Atlas: ${root}\n`))
    throw new Error(
      "An unmanaged atlas.service already exists; refusing to replace it",
    );
  const maintenance = join(root, "shared/data/deploy-maintenance");
  await Bun.write(maintenance, id);
  let switched = false;
  try {
    await noActivePreparations();
    await beforeSwitch?.();
    await mkdir(dirname(unitPath), { recursive: true });
    await Bun.write(unitPath, managedUnit(root));
    await link(target, join(root, "current"));
    switched = true;
    await run(["systemctl", "--user", "daemon-reload"]);
    await run(["systemctl", "--user", "enable", "atlas.service"]);
    await run(["systemctl", "--user", "restart", "atlas.service"]);
    const health = await awaitHealth(id);
    if (old && old !== target) await link(old, join(root, "previous"));
    await Bun.write(
      join(target, "deploy/activated.json"),
      JSON.stringify({ activatedAt: new Date().toISOString() }),
    );
    return health;
  } catch (error) {
    if (switched) {
      console.error(
        `Activation failed; restoring ${old ?? "the stopped state"}.`,
      );
      if (old) {
        await link(old, join(root, "current"));
        if (previousUnit) await Bun.write(unitPath, previousUnit);
        await run(["systemctl", "--user", "daemon-reload"]);
        await run(["systemctl", "--user", "restart", "atlas.service"]);
        const prior = (await Bun.file(
          join(old, "deploy/manifest.json"),
        ).json()) as Metadata;
        await awaitHealth(prior.id);
      } else {
        await run(["systemctl", "--user", "disable", "--now", "atlas.service"]);
        await rm(join(root, "current"), { force: true });
        await rm(unitPath, { force: true });
        await run(["systemctl", "--user", "daemon-reload"]);
      }
    }
    throw error;
  } finally {
    await rm(maintenance, { force: true });
  }
}

async function main() {
  if (command === "status") {
    const fs = await statfs(root);
    const current = await currentPath();
    console.log(
      JSON.stringify({
        current,
        previous: await readlink(join(root, "previous")).catch(() => null),
        health: await getHealth().catch((e) => ({ error: String(e) })),
        service: await run(
          [
            "systemctl",
            "--user",
            "show",
            "atlas.service",
            "-p",
            "ActiveState",
            "-p",
            "MemoryCurrent",
            "-p",
            "CPUUsageNSec",
          ],
          release,
          process.env,
          true,
        ),
        availableGiB: (fs.bavail * fs.bsize) / 1073741824,
        linger: await run(
          [
            "loginctl",
            "show-user",
            process.env.USER!,
            "-p",
            "Linger",
            "--value",
          ],
          release,
          process.env,
          true,
        ),
      }),
    );
    return;
  }
  if (command === "rollback") {
    await mkdir(join(root, ".deploy-lock"));
    try {
      const target = await realpath(join(root, "previous"));
      if (!target.startsWith(root + "/releases/"))
        throw new Error("Previous release is outside the deployment directory");
      const settings = (await Bun.file(
        join(target, "deploy/settings.json"),
      ).json()) as Settings;
      if (settings.port !== port || settings.root !== root)
        throw new Error(
          "Rollback settings differ from requested host settings",
        );
      const metadata = (await Bun.file(
        join(target, "deploy/manifest.json"),
      ).json()) as Metadata;
      await smoke(target, settings, metadata.id);
      console.log(
        JSON.stringify({
          rolledBack: true,
          health: await activate(target, settings, metadata.id),
        }),
      );
    } finally {
      await rm(join(root, ".deploy-lock"), { recursive: true });
    }
    return;
  }
  if (command !== "deploy") throw new Error("Unknown remote action");
  const metadata = (await Bun.file(
    join(release, "deploy/manifest.json"),
  ).json()) as Metadata;
  if (resolve(release) !== join(root, "releases", metadata.id))
    throw new Error("Release path mismatch");
  for (const file of metadata.files) {
    const path = resolve(release, file.path);
    if (
      !path.startsWith(resolve(release) + "/") ||
      (await hash(path)) !== file.sha256
    )
      throw new Error(`Transfer verification failed: ${file.path}`);
  }
  let mapPath: string;
  if (metadata.map) {
    mapPath = join(root, "shared/maps", metadata.map.sha256 + ".atlas");
    if (await Bun.file(mapPath).exists()) {
      if ((await hash(mapPath)) !== metadata.map.sha256)
        throw new Error("Existing base map checksum mismatch");
      await rm(join(release, metadata.map.path));
    } else await rename(join(release, metadata.map.path), mapPath);
  } else {
    const old = await currentPath();
    if (!old) throw new Error("First deploy requires --map FILE.atlas");
    mapPath = (
      (await Bun.file(join(old, "deploy/settings.json")).json()) as Settings
    ).mapPath;
  }
  const current = await currentPath();
  if (current) {
    const prior = (await Bun.file(
      join(current, "deploy/settings.json"),
    ).json()) as Settings;
    if (prior.port !== port)
      throw new Error(
        "Changing service ports during deployment is not supported",
      );
  }
  const env = {
    ...process.env,
    PATH: `${release}/.runtime/bin:/run/current-system/sw/bin`,
    CARGO_BUILD_JOBS: "4",
  };
  await run(
    [join(release, ".runtime/bin/bun"), "install", "--frozen-lockfile"],
    release,
    env,
  );
  // Native binaries belong to the release, too. A shared target directory lets
  // a candidate overwrite binaries used by a live preparation or a rollback.
  const target = join(release, "target");
  const resolvedTarget = await realpath(target).catch(() => undefined);
  if (resolvedTarget && resolvedTarget !== target)
    throw new Error("Release target must not be a shared symlink; use a new release");
  await mkdir(target, { recursive: true });
  await run(
    [
      "systemd-run",
      "--user",
      "--scope",
      "--quiet",
      "-p",
      "MemoryMax=16G",
      "-p",
      "CPUQuota=400%",
      join(release, ".runtime/bin/cargo"),
      "build",
      "--release",
      "--locked",
      "-p",
      "atlas-osm-import",
      "-p",
      "atlas-routing",
      "--bins",
    ],
    release,
    env,
  );
  const settings: Settings = { root, port, mapPath };
  await Bun.write(
    join(release, "deploy/settings.json"),
    JSON.stringify(settings),
  );
  await Bun.write(
    join(release, "deploy/release.env"),
    [
      `PATH=${release}/.runtime/bin:/run/current-system/sw/bin`,
      `HOST=0.0.0.0`,
      `PORT=${port}`,
      `ATLAS_RELEASE=${metadata.id}`,
      `ATLAS_FILE=${mapPath}`,
      `ATLAS_DATA_DIR=${root}/shared/data`,
      `CARGO_BUILD_JOBS=4`,
    ].join("\n") + "\n",
  );
  const envFile = join(root, "shared/server.env");
  if (!(await Bun.file(envFile).exists())) {
    await Bun.write(
      envFile,
      "# Optional server secrets/settings. Managed paths and ports come from the release.\n",
    );
    await chmod(envFile, 0o600);
  }
  await smoke(release, settings, metadata.id);
  const health = await activate(release, settings, metadata.id, async () => {
    const hosted = join(root, "shared/data/hosted");
    await mkdir(hosted, { recursive: true });
    // Validate all conflicts before publishing any records. Existing library is additive.
    for (const id of metadata.library) {
      const existing = join(hosted, id + ".atlas");
      const file = metadata.files.find(
        (f) => f.path === `.incoming/hosted/${id}.atlas`,
      )!;
      if (
        (await Bun.file(existing).exists()) &&
        (await hash(existing)) !== file.sha256
      )
        throw new Error(
          `Hosted map ${id} has different contents; use a new ID`,
        );
      const record = Bun.file(join(hosted, id + ".json"));
      if ((await record.exists()) && (await record.json()).state !== "ready")
        throw new Error(
          `Hosted map ${id} already has a non-ready preparation record`,
        );
    }
    for (const id of metadata.library) {
      const from = join(release, ".incoming/hosted", id);
      const to = join(hosted, id);
      if (!(await Bun.file(to + ".atlas").exists()))
        await rename(from + ".atlas", to + ".atlas");
      if (!(await Bun.file(to + ".json").exists()))
        await rename(from + ".json", to + ".json");
    }
  });
  await rm(join(release, ".incoming"), { recursive: true, force: true });
  console.log(
    JSON.stringify({
      deployed: metadata.id,
      revision: metadata.revision,
      dirty: metadata.dirty,
      health,
      runtime: await realpath(join(release, ".runtime")),
      libraryImported: metadata.library.length,
    }),
  );
}
if (import.meta.main)
  main().catch((error) => {
    console.error(String(error));
    process.exitCode = 1;
  });

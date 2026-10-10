import { cacheSource } from "../packages/provisioning/src/source-cache";
import { mkdtemp, open, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
if (process.argv[2] === "worker") {
  const [directory, port, bytes, md5] = process.argv.slice(3);
  await cacheSource(
    {
      id: "e".repeat(32),
      kind: "planet",
      name: "Memory fixture",
      url: `http://127.0.0.1:${port}/source`,
      bytes: Number(bytes),
      etag: '"fixture"',
      lastModified: "Sat, 10 Oct 2026 10:00:00 GMT",
      md5,
      inspectedAt: new Date().toISOString(),
    },
    directory,
    new AbortController().signal,
    async (state: string, completed: number) => {
      // Model a stalled disk/status write: a streaming HTTP response must not read
      // the rest of a multi-GB file into memory while its consumer is blocked.
      if (state === "downloading") await Bun.sleep(750);
    },
  );
  console.log("PASS: verified 1.5 GiB download with a 256 MiB worker limit");
  process.exit(0);
}
if (process.platform !== "linux" || !Bun.which("systemd-run"))
  throw new Error(
    "Run this memory regression on Linux with a systemd user manager.",
  );
const directory = await mkdtemp("/tmp/atlas-source-memory-"),
  bytes = 1536 * 1024 ** 2;
const zero = Buffer.alloc(1024 ** 2),
  hash = createHash("md5");
for (let i = 0; i < bytes / zero.length; i++) hash.update(zero);
const file = await open(directory + "/fixture", "w");
await file.truncate(bytes);
await file.close();
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    const range = request.headers.get("range")?.match(/^bytes=(\d+)-(\d*)$/);
    const start = Number(range?.[1] ?? 0),
      end = range?.[2] ? Number(range[2]) : bytes - 1;
    return new Response(
      Bun.file(directory + "/fixture").slice(start, end + 1),
      {
        status: range ? 206 : 200,
        headers: {
          etag: '"fixture"',
          "content-length": String(end - start + 1),
          ...(range
            ? { "content-range": `bytes ${start}-${end}/${bytes}` }
            : {}),
        },
      },
    );
  },
});
try {
  const child = Bun.spawn(
    [
      "systemd-run",
      "--user",
      "--wait",
      "--pipe",
      "--collect",
      `--unit=atlas-source-memory-${Date.now()}`,
      "--property=MemoryMax=256M",
      "--property=RuntimeMaxSec=90",
      process.execPath,
      "--smol",
      process.argv[1]!,
      "worker",
      directory + "/out",
      String(server.port),
      String(bytes),
      hash.digest("hex"),
    ],
    { stdout: "inherit", stderr: "inherit" },
  );
  const code = await child.exited;
  console.log(JSON.stringify({ pass: code === 0, exitCode: code }));
  process.exitCode = code;
} finally {
  server.stop(true);
  await rm(directory, { recursive: true, force: true });
}

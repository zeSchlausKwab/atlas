import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const file = resolve(root, process.env.ATLAS_FILE ?? "data/local-demo.atlas");
const data = resolve(
  root,
  process.env.ATLAS_DATA_DIR ?? "data/local-demo-state",
);
const port = (name: string, fallback: number) => {
  const value = process.env[name] ?? String(fallback);
  if (!/^\d+$/.test(value) || +value < 1 || +value > 65535)
    throw new Error(`${name} must be an integer from 1 to 65535.`);
  return +value;
};
const serverPort = port("ATLAS_SERVER_PORT", 3100);
const clientPort = port("ATLAS_CLIENT_PORT", 5173);
if (serverPort === clientPort)
  throw new Error("Server and client need different ports.");
const serverUrl = `http://127.0.0.1:${serverPort}/`;
const clientUrl = `http://127.0.0.1:${clientPort}/`;
const clientDemoUrl = `${clientUrl}?transport=http`;
const children: Bun.Subprocess[] = [];
let stopping = false;
const stop = () => {
  stopping = true;
  for (const child of children)
    if (child.exitCode === null) child.kill("SIGTERM");
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
const launch = (
  args: string[],
  env: Record<string, string | undefined> = {},
) => {
  const child = Bun.spawn([process.execPath, ...args], {
    cwd: root,
    env: { ...process.env, ...env },
    stdout: "inherit",
    stderr: "inherit",
  });
  children.push(child);
  return child;
};
try {
  if (!(await Bun.file(file).exists()))
    throw new Error(
      "Run bun run setup first, or set ATLAS_FILE to an existing .atlas file.",
    );
  if (
    !(await Bun.file(
      resolve(root, "packages/renderer/pkg/atlas_renderer_bg.wasm"),
    ).exists())
  )
    throw new Error(
      "Missing WASM. Run bun run setup or bun run build:wasm first.",
    );
  const build = launch(["run", "build:web"], {
    ATLAS_SERVER_URL: serverUrl,
    ATLAS_CLIENT_TRANSPORT: "http",
  });
  if ((await build.exited) !== 0) throw new Error("Browser build failed.");
  if (!stopping) {
    console.log(
      `\nClient: ${clientDemoUrl}\nHost console: ${serverUrl}host\nMap: ${file}\nCtrl+C stops both applications.\n`,
    );
    const server = launch(["apps/server/index.ts"], {
      HOST: "127.0.0.1",
      PORT: String(serverPort),
      ATLAS_FILE: file,
      ATLAS_DATA_DIR: data,
      ATLAS_CLIENT_URL: clientDemoUrl,
      ATLAS_CVM_SECRET: "",
      ATLAS_FIPS_ENABLED: "0",
      ATLAS_HTTP_DELIVERY: "1",
      ATLAS_DISCOVERY_RELAYS: "",
      ATLAS_ADMIN_ORIGINS: "",
      ATLAS_ADMIN_SUBNETS: "",
      ATLAS_SOURCE_SYSTEMD: "0",
      ATLAS_HOST_POLICY: resolve(data, "host-policy.json"),
      ATLAS_CORS_ORIGINS: clientUrl.slice(0, -1),
    });
    const client = launch(["apps/web/server.ts"], {
      HOST: "127.0.0.1",
      PORT: String(clientPort),
      ATLAS_SERVER_URL: serverUrl,
      ATLAS_CLIENT_DIR: resolve(root, "dist/client"),
      ATLAS_CLIENT_TRANSPORT: "http",
    });
    const first = await Promise.race([server.exited, client.exited]);
    if (!stopping) process.exitCode = first || 1;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  stop();
  await Promise.all(children.map((child) => child.exited));
  process.off("SIGINT", stop);
  process.off("SIGTERM", stop);
}

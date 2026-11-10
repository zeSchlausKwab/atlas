import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const input = resolve(root, "data/local-demo.osm.pbf");
const output = resolve(root, "data/local-demo.atlas");
let child: Bun.Subprocess | undefined;
let interrupted = false;
const stop = () => {
  interrupted = true;
  child?.kill("SIGTERM");
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
async function run(command: string[]) {
  if (interrupted)
    throw new Error("Setup interrupted; rerun bun run setup to continue.");
  child = Bun.spawn(command, {
    cwd: root,
    stdout: "inherit",
    stderr: "inherit",
  });
  const code = await child.exited;
  child = undefined;
  if (code !== 0 || interrupted)
    throw new Error(`Setup stopped: ${command.join(" ")}`);
}
try {
  for (const [tool, install] of [
    [
      "cargo",
      "Install Rust from https://rustup.rs (including a native C/C++ toolchain).",
    ],
    ["rustup", "Install Rust from https://rustup.rs."],
    ["wasm-pack", "Install with cargo install wasm-pack --locked."],
  ])
    if (!Bun.which(tool!)) throw new Error(`Missing ${tool}. ${install}`);

  await run(["rustup", "target", "add", "wasm32-unknown-unknown"]);
  if (!(await Bun.file(output).exists())) {
    // Keep the original URL when resuming so a newer daily extract cannot replace it.
    const metadata = Bun.file(`${input}.source.json`);
    const url = (await metadata.exists())
      ? (await metadata.json()).url
      : "https://download.geofabrik.de/europe/liechtenstein-latest.osm.pbf";
    console.log(
      "Preparing Liechtenstein: a small OSM sample with all demo capabilities.",
    );
    await run([
      process.execPath,
      "packages/cli/src/index.ts",
      "fetch",
      "--url",
      url,
      "--out",
      input,
    ]);
    await run([
      process.execPath,
      "packages/cli/src/index.ts",
      "generate",
      "--input",
      input,
      "--output",
      output,
      "--name",
      "Liechtenstein · local demo",
      "--min-zoom",
      "0",
      "--max-zoom",
      "16",
      "--features",
    ]);
  } else
    console.log("Reusing data/local-demo.atlas. No source download needed.");
  await run([process.execPath, "run", "build"]);
  console.log(
    "\nReady. Run bun run demo, then open http://127.0.0.1:5173/?transport=http.\nHost console: http://127.0.0.1:3100/host. No remote map server is needed.",
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = interrupted ? 130 : 1;
} finally {
  process.off("SIGINT", stop);
  process.off("SIGTERM", stop);
}

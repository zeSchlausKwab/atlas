#!/usr/bin/env bun
import { resolve } from "node:path";
import { PackageSource } from "../apps/server/package-source";
import { AtlasReader } from "../packages/format/src/reader";
import {
  amendRouting,
  planRoutingAmendment,
  type RoutingAmendment,
} from "../packages/provisioning/src/amend";
import type { TransportMode } from "../packages/format/src/index";
const args = process.argv.slice(2),
  at = (key: string) => {
    const i = args.indexOf(key);
    return i < 0 ? undefined : args[i + 1];
  };
if (
  args.includes("--help") ||
  !at("--map") ||
  !at("--source") ||
  !at("--profiles") ||
  (!args.includes("--plan") && !at("--output"))
) {
  console.log(
    "Usage: bun run map:amend --map MAP.atlas --source SOURCE.atlas --profiles walking,cycling [--plan | --output NEW.atlas] [--name NAME] [--max-mib N] [--padding 1]",
  );
  process.exit(args.includes("--help") ? 0 : 1);
}
const abort = new AbortController();
process.on("SIGINT", () => abort.abort());
process.on("SIGTERM", () => abort.abort());
const a = await PackageSource.open(resolve(at("--map")!));
let b: PackageSource | undefined;
try {
  b = await PackageSource.open(resolve(at("--source")!));
  const target = await new AtlasReader(a).open(),
    source = await new AtlasReader(b).open();
  const options: RoutingAmendment = {
    targetSnapshot: target.index.manifest.snapshot,
    sourceSnapshot: source.index.manifest.snapshot,
    name:
      at("--name") ?? `${target.index.manifest.name.slice(0, 65)} · routing`,
    profiles: at("--profiles")!.split(",") as TransportMode[],
    paddingCells: Number(at("--padding") ?? 1),
    maxBytes:
      Number(
        at("--max-mib") ?? Math.ceil((a.size + b.size + 1024 ** 2) / 1024 ** 2),
      ) *
      1024 ** 2,
  };
  const result = args.includes("--plan")
    ? await planRoutingAmendment(target, source, options, abort.signal)
    : await amendRouting(
        target,
        source,
        options,
        resolve(at("--output")!),
        abort.signal,
        (p) =>
          console.error(
            `${p.phase}: ${p.message} (${p.completed}/${p.total} ${p.unit ?? ""})`,
          ),
      );
  console.log(JSON.stringify(result, null, 2));
  target.dispose();
  source.dispose();
} finally {
  await a.close();
  await b?.close();
}

#!/usr/bin/env bun
import { AtlasReader, FileSource } from "../packages/format/src/reader";
import { upgradeObjects } from "../packages/objects/src/upgrade";
const [input, output] = process.argv.slice(2);
if (!input || !output)
  throw new Error(
    "Usage: bun scripts/repack-source-objects.ts ORIGINAL.atlas NEW.atlas",
  );
const controller = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => controller.abort());
const reader = await new AtlasReader(new FileSource(Bun.file(input))).open();
try {
  console.log(
    JSON.stringify(
      await upgradeObjects(
        reader,
        reader,
        output,
        controller.signal,
        console.log,
      ),
    ),
  );
} finally {
  reader.dispose();
}

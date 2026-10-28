#!/usr/bin/env bun
import { AtlasReader, FileSource } from "../packages/format/src/reader";
import { upgradeObjects } from "../packages/objects/src/upgrade";
const [input, source, output] = process.argv.slice(2);
if (!input || !source || !output)
  throw new Error(
    "Usage: bun scripts/upgrade-source-objects.ts MAP.atlas OBJECTS.atlas NEW.atlas",
  );
const controller = new AbortController();
process.on("SIGINT", () => controller.abort());
process.on("SIGTERM", () => controller.abort());
const a = await new AtlasReader(new FileSource(Bun.file(input))).open(),
  b = await new AtlasReader(new FileSource(Bun.file(source))).open();
try {
  console.log(
    JSON.stringify(
      await upgradeObjects(a, b, output, controller.signal, console.log),
    ),
  );
} finally {
  a.dispose();
  b.dispose();
}

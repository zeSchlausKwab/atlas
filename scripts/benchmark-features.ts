import assert from "node:assert/strict";
import { AtlasReader, FileSource } from "../packages/format/src/reader";
import { AtlasWorkspace } from "../packages/workspace/src/index";
import { AtlasFeatures } from "../packages/features/src/index";
const directory = process.argv[2] ?? "data/pair-rehearsal";
const bounds = (
  process.argv[3]
    ? process.argv[3].split(",").map(Number)
    : [16.378, 48.203, 16.382, 48.207]
) as [number, number, number, number];
const measurements = [];
let expected: string[] | undefined;
for (const layout of ["legacy", "paged"] as const)
  for (const geometry of [false, true]) {
    const readers: AtlasReader[] = [];
    let reads = 0;
    try {
      for (const side of ["west", "east"]) {
        const file = new FileSource(
          Bun.file(
            `${directory}/${side}${layout === "paged" ? "-paged" : ""}.atlas`,
          ),
        );
        readers.push(
          await new AtlasReader({
            read: (a, b) => {
              reads++;
              return file.read(a, b);
            },
          }).open(),
        );
      }
      const workspace = new AtlasWorkspace(readers),
        start = performance.now();
      const prepared = await workspace.prepare({
        bounds,
        families: ["buildings"],
        geometry,
      });
      const result = workspace.query({ workspace: prepared.workspace });
      const ids: string[] = [];
      for (let offset = 0; offset < result.count; offset += 100)
        ids.push(
          ...workspace
            .result(result.result, offset, 100, ["id"])
            .rows.map((r) => String(r.id)),
        );
      if (expected) assert.deepEqual(ids, expected);
      else expected = ids;
      const height = workspace.query({
        workspace: prepared.workspace,
        where: [{ field: "heightMeters", op: "gte", value: 20 }],
      });
      const loaded = reads;
      readers.forEach((r) => r.dispose());
      workspace.query({ workspace: prepared.workspace });
      workspace.result(height.result);
      assert.equal(reads, loaded);
      measurements.push({
        layout,
        geometry,
        records: result.count,
        tallBuildings: height.count,
        readBytes: prepared.readBytes,
        memoryEstimateBytes: prepared.memoryEstimateBytes,
        elapsedMs: Math.round(performance.now() - start),
        warmSourceReads: reads - loaded,
      });
    } catch (e) {
      measurements.push({
        layout,
        geometry,
        error: e instanceof Error ? e.message : String(e),
      });
    } finally {
      readers.forEach((r) => r.dispose());
    }
  }
// Exact IDs also agree with the legacy full-geometry extraction path (larger scan budget).
const ids = new Set<string>();
for (const side of ["west", "east"]) {
  const reader = await new AtlasReader(
    new FileSource(Bun.file(`${directory}/${side}.atlas`)),
  ).open();
  try {
    for await (const f of new AtlasFeatures(reader).scan({
      kind: "buildings",
      bounds,
    }))
      ids.add(f.id);
  } finally {
    reader.dispose();
  }
}
assert(expected, "Paged workspaces must succeed");
assert.deepEqual([...ids].sort(), [...expected].sort());
console.log(
  JSON.stringify({ bounds, measurements, legacyExactIdsMatch: true }, null, 2),
);

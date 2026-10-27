import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { AtlasWorkspace } from "../packages/workspace/src/index";
import {
  workspaceFixture,
  taskBounds,
} from "../tests/helpers/workspace-fixture";
// Synthetic, deterministic and entirely local; writes two ordinary .atlas files.
const dir = await mkdtemp("/tmp/atlas-workspace-demo-");
let reads = 0;
const west = await workspaceFixture(
  [16, 48, 16.012, 48.02],
  "18",
  () => reads++,
);
const east = await workspaceFixture(
  [16.008, 48, 16.02, 48.02],
  "18",
  () => reads++,
);
await Bun.write(`${dir}/west.atlas`, west.bytes);
await Bun.write(`${dir}/east.atlas`, east.bytes);
const workspace = new AtlasWorkspace([west.reader, east.reader]);
const prepared = await workspace.prepare({
  bounds: taskBounds,
  families: ["locations", "buildings"],
});
const loaded = reads;
west.reader.dispose();
east.reader.dispose();
const cafes = workspace.query({
  workspace: prepared.workspace,
  where: [{ field: "tags.amenity", op: "eq", value: "cafe" }],
});
const accessible = workspace.query({
  workspace: prepared.workspace,
  from: cafes.result,
  where: [{ field: "tags.wheelchair", op: "eq", value: "yes" }],
});
const address = workspace.query({
  workspace: prepared.workspace,
  text: "Testgasse 12 Wien",
});
const buildings = workspace.query({
  workspace: prepared.workspace,
  where: [{ field: "heightMeters", op: "gte", value: 15 }],
});
assert.equal(reads, loaded);
assert.equal(cafes.count, 2);
assert.equal(accessible.count, 1);
assert.equal(address.count, 1);
assert.equal(buildings.count, 1);
console.log(
  JSON.stringify(
    {
      files: [`${dir}/west.atlas`, `${dir}/east.atlas`],
      prepared,
      queries: {
        cafes: cafes.count,
        explicitlyWheelchairAccessible: accessible.count,
        address: workspace.result(address.result, 0, 1, ["id", "address"]),
        tallBuildings: buildings.count,
      },
      additionalReadsAfterPreparation: reads - loaded,
    },
    null,
    2,
  ),
);
workspace.clear();

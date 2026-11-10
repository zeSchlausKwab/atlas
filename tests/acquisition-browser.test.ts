import { expect, test } from "bun:test";
import { pluginFixture, polygon } from "./helpers/plugin-fixture";
import { planAcquisition } from "../packages/acquisition/src/plan";
import {
  areaSummary,
  browserPlanBytes,
  type SavedArea,
} from "../packages/acquisition/src/browser";
import { acquisitionSpecs } from "../packages/acquisition/src/tools";
import Ajv from "ajv";

test("browser review reports source-key storage and compact coverage, without claiming an exported archive", async () => {
  const fixture = await pluginFixture();
  try {
    const request = {
      name: "Lake walk",
      polygon,
      families: ["features"],
      minZoom: 0,
      maxZoom: 0,
      paddingCells: 0,
      sourceIds: ["lake"],
    };
    const plan = await planAcquisition(
      request,
      [
        {
          id: "lake",
          reader: fixture.reader,
          manifest: fixture.reader.index.manifest,
          verified: true,
          location: "remote",
          bytes: fixture.bytes.length,
        },
      ],
      new AbortController().signal,
    );
    const selected = new Map(
      plan.parts.flatMap((p) =>
        p.blocks.map((b) => [p.sourceId + b.key, b.length] as const),
      ),
    );
    expect(browserPlanBytes(plan)).toBe(
      [...selected.values()].reduce((n, b) => n + b, 0),
    );
    // Identical payloads may be stored under different source cells. Export's hash
    // deduplication must not understate the browser's per-key storage requirement.
    expect(browserPlanBytes(plan)).toBeGreaterThan(plan.storedBytes);
    const job: SavedArea = {
      id: "test",
      request,
      plan,
      state: "review",
      message: "Review",
      createdAt: "now",
      updatedAt: "now",
      completed: 0,
      total: 0,
      bytes: 0,
      reusedBytes: 0,
      sources: [],
    };
    const view = areaSummary(job);
    expect(view.plan!.storedBytes).toBe(browserPlanBytes(plan));
    const coverage = view.plan!.coverage[0]!;
    expect((100 * coverage.totals.remote) / coverage.areaM2).toBeCloseTo(
      100,
      3,
    );
    expect(view.plan).not.toHaveProperty("parts");
    expect(view.plan!.notes.join(" ")).not.toContain("indexes are rebuilt");
    expect(view.scope).toContain("not a standalone .atlas");
  } finally {
    fixture.engine.destroy();
    fixture.reader.dispose();
  }
});

test("AI acquisition requires explicit geographic scope and does not default to accepting gaps", () => {
  const ajv = new Ajv({ strict: false });
  const specs = new Map(
    acquisitionSpecs.map(([name, , schema]) => [name, schema]),
  );
  const plan = ajv.compile(specs.get("acquisition_plan")!);
  expect(
    plan({ name: "Trip", families: ["features"], minZoom: 0, maxZoom: 14 }),
  ).toBe(false);
  expect(
    plan({
      name: "Trip",
      polygon,
      families: ["features"],
      minZoom: 0,
      maxZoom: 14,
    }),
  ).toBe(true);
  const save = ajv.compile(specs.get("acquisition_save")!);
  const input = { id: "reviewed-job" };
  expect(save(input)).toBe(true);
  expect(input).not.toHaveProperty("acceptPartial");
  expect(input).not.toHaveProperty("allowStorageRisk");
});

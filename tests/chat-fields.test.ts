import { expect, test } from "bun:test";
import Ajv from "ajv";
import { ChatDataRuntime } from "../packages/chat/src/data";
import { constructionSpecs } from "../packages/chat/src/construction-specs";
import { workspaceFixture, taskBounds } from "./helpers/workspace-fixture";

test("cached source → field → repeated contours retains provenance with zero reads; release/clear reclaim samples", async () => {
  let reads = 0;
  const { reader } = await workspaceFixture(taskBounds, "18", () => reads++);
  const runtime = new ChatDataRuntime([reader]),
    signal = new AbortController().signal;
  try {
    const prepared = await runtime.invoke(
      "workspace_prepare",
      { bounds: taskBounds, families: ["buildings"], geometry: true },
      signal,
    );
    const selected = await runtime.invoke(
      "workspace_query",
      { workspace: prepared.workspace },
      signal,
    );
    const before = reads;
    const field = await runtime.invoke(
      "field_create",
      {
        result: selected.result,
        kind: "distance",
        bounds: taskBounds,
        cellMeters: 25,
      },
      signal,
    );
    expect(field.field).toStartWith("field-");
    expect(field.values).toBeUndefined();
    expect(field.execution.sourceBytes).toBe(0);
    const first = await runtime.invoke(
      "field_contours",
      { field: field.field, thresholds: [0, 100, 500] },
      signal,
    );
    const second = await runtime.invoke(
      "field_contours",
      { field: field.field, thresholds: [25, 150], mode: "lines" },
      signal,
    );
    expect(first.count).toBeGreaterThan(0);
    expect(second.count).toBeGreaterThan(0);
    expect(second.execution.sourceBytes).toBe(0);
    expect(reads).toBe(before);
    expect((await runtime.resolve(first.result)).meta).toMatchObject({
      inputs: [{ inputs: [{ coverage: expect.any(Object) }] }],
    });
    const inspected = await runtime.invoke(
      "field_inspect",
      { field: field.field },
      signal,
    );
    expect(inspected.sampleBytes).toBe(field.samples * 8);
    expect(inspected.min).toBe(field.min);
    const released = await runtime.invoke(
      "field_release",
      { field: field.field },
      signal,
    );
    expect(released.sampleBytesFreed).toBe(field.sampleBytes);
    await expect(
      runtime.invoke(
        "field_contours",
        { field: field.field, thresholds: [0, 100] },
        signal,
      ),
    ).rejects.toThrow("released field");
    expect(
      (await runtime.resolve(first.result)).collection.features.length,
    ).toBe(first.count); // derived results survive
    const replacement = await runtime.invoke(
      "field_create",
      {
        result: selected.result,
        kind: "distance",
        bounds: taskBounds,
        cellMeters: 50,
      },
      signal,
    );
    runtime.clear();
    await expect(
      runtime.invoke("field_inspect", { field: replacement.field }, signal),
    ).rejects.toThrow("released field");
  } finally {
    runtime.clear();
    reader.dispose();
  }
});
test("new tool schemas validate and authored geometry flows through the runtime", async () => {
  const ajv = new Ajv({ strict: false });
  for (const [, , schema] of constructionSpecs)
    expect(() => ajv.compile(schema)).not.toThrow();
  const { reader } = await workspaceFixture();
  const runtime = new ChatDataRuntime([reader]),
    signal = new AbortController().signal;
  try {
    const shape = await runtime.invoke(
      "spatial_shape",
      { kind: "circle", center: [16.01, 48.01], radiusMeters: 150 },
      signal,
    );
    expect(shape.scope).toBe("authored-geometry");
    expect(shape.execution.sourceBytes).toBe(0);
    const bands = await runtime.invoke(
      "spatial_bands",
      { result: shape.result, distancesMeters: [100, 200], bounds: taskBounds },
      signal,
    );
    expect(bands.count).toBe(2);
    expect(bands.inputs[0].scope).toBe("authored-geometry");
  } finally {
    runtime.clear();
    reader.dispose();
  }
});

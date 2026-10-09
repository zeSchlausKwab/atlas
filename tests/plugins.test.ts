import { test, expect } from "bun:test";
import { pluginFixture, water, polygon } from "./helpers/plugin-fixture";
import { OperationHost } from "../packages/operations/src/host";
import { createApiHandler } from "../apps/server/api";
import type { LakeResult } from "../plugins/lakes";
import { hostPolicy } from "../apps/server/policy";
import { rm } from "node:fs/promises";
import { buildPlugins, loadPlugins } from "../scripts/plugins";
test("lake ranking scans beyond display limits, deduplicates cells, excludes rivers, subtracts holes and preserves provenance", async () => {
  const unknown = water(2000, 0.1);
  delete unknown.properties!.tags.water;
  const f = await pluginFixture([
    ...Array.from({ length: 501 }, (_, i) => water(i + 1, 0.002)),
    water(999, 0.1),
    water(1000, 0.1, { water: "lake" }, 0.07),
    water(1001, 0.15, { water: "river" }),
    unknown,
  ]);
  const result = (await f.engine.registry.invoke(f.ref, {
    polygon,
    limit: 2,
  })) as LakeResult;
  expect(result.features.map((f) => f.id)).toEqual(["way/999", "way/1000"]);
  expect(result.matched).toBe(503);
  expect(result.truncated).toBe(true);
  expect(result.analysis.unclassifiedWater).toBe(1);
  expect(
    Number(result.features[1]!.properties.tags["atlas:area_m2"]),
  ).toBeLessThan(
    Number(result.features[0]!.properties.tags["atlas:area_m2"]) * 0.6,
  );
  expect(f.reader.bytesByPurpose.map).toBe(0);
  expect(f.reader.bytesByPurpose.features).toBeGreaterThan(0);
  expect(result.snapshot).toBe(f.reader.index.manifest.snapshot);
  f.reader.dispose();
  f.engine.destroy();
});
test("an area inside a lake hole does not select that lake; multipolygons retain all parts", async () => {
  const multi = water(3, 0.01);
  const part = water(4, 0.02);
  const f = await pluginFixture([
    water(1, 0.1, { water: "lake" }, 0.07),
    {
      ...multi,
      geometry: {
        type: "MultiPolygon",
        coordinates: [multi.geometry.coordinates, part.geometry.coordinates],
      },
    },
  ]);
  const result = (await f.engine.registry.invoke(f.ref, {
    polygon: [
      [9.04, 47.04],
      [9.05, 47.04],
      [9.05, 47.05],
      [9.04, 47.05],
    ],
  })) as LakeResult;
  expect(result.matched).toBe(0);
  const all = (await f.engine.registry.invoke(f.ref, {
    polygon,
  })) as LakeResult;
  expect(all.features.find((f) => f.id === "way/3")?.geometry.type).toBe(
    "MultiPolygon",
  );
  f.reader.dispose();
  f.engine.destroy();
});
test("input, revision, disabled and cancellation checks precede data; offline misses remain errors", async () => {
  const f = await pluginFixture(),
    before = f.reader.bytesRead;
  await expect(
    f.engine.registry.invoke(f.ref, { polygon, limit: 51 }),
  ).rejects.toThrow("Invalid input");
  await expect(
    f.engine.registry.invoke(
      { ...f.ref, implementation: "stale" },
      { polygon },
    ),
  ).rejects.toThrow("changed");
  f.engine.registry.setEnabled(f.ref.id, false);
  await expect(f.engine.registry.invoke(f.ref, { polygon })).rejects.toThrow(
    "disabled",
  );
  expect(f.reader.bytesRead).toBe(before);
  f.engine.registry.setEnabled(f.ref.id, true);
  const controller = new AbortController();
  controller.abort();
  await expect(
    f.engine.registry.invoke(f.ref, { polygon }, controller.signal),
  ).rejects.toThrow();
  expect(f.reader.bytesRead).toBe(before);
  f.reader.offline = true;
  await expect(f.engine.registry.invoke(f.ref, { polygon })).rejects.toThrow();
  f.reader.dispose();
  f.engine.destroy();
});
test("arbitrary plugins appear and execute through HTTP without central dispatch changes; outputs are validated", async () => {
  const f = await pluginFixture(),
    base = f.engine.registry.describe(f.ref.id)!;
  f.engine.registry.register(
    {
      descriptor: {
        ...base,
        id: "test.count",
        title: "Custom count",
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
        outputSchema: {
          type: "object",
          required: ["count"],
          properties: { count: { type: "integer" } },
        },
      },
      run: async () => ({ count: 42 }),
    },
    "count-code",
  );
  const host = new OperationHost(f.engine),
    api = createApiHandler(f.engine, host);
  const catalog = await (
    await api(new Request("http://localhost/api/capabilities"))
  ).json();
  expect(catalog.plugins.find((d: any) => d.id === "test.count")).toBeTruthy();
  const invoke = (id: string, implementation: string, input: unknown) =>
    api(
      new Request(`http://localhost/api/${id}`, {
        method: "POST",
        body: JSON.stringify({
          snapshot: f.reader.index.manifest.snapshot,
          version: "1.0.0",
          implementation,
          input,
        }),
      }),
    );
  expect(
    (await (await invoke("test.count", "count-code", {})).json()).result,
  ).toEqual({ count: 42 });
  const local = await f.engine.registry.invoke(f.ref, { polygon });
  const remote = await (
    await invoke(f.ref.id, f.ref.implementation, { polygon })
  ).json();
  expect(remote.result).toEqual(local);
  expect(remote.provenance.implementation).toBe(f.ref.implementation);
  f.engine.registry.register(
    {
      descriptor: {
        ...base,
        id: "test.invalid",
        inputSchema: { type: "object" },
        outputSchema: { type: "number" },
      },
      run: async () => "wrong",
    },
    "bad-code",
  );
  expect((await invoke("test.invalid", "bad-code", {})).status).toBe(422);
  f.reader.dispose();
  f.engine.destroy();
});
test("host policy persists and revokes HTTP calls, with local-only and origin checks", async () => {
  const f = await pluginFixture(),
    host = new OperationHost(f.engine),
    path = `/tmp/atlas-policy-${crypto.randomUUID()}.json`;
  try {
    const policy = await hostPolicy(host, path),
      make = (origin = "http://localhost") =>
        new Request("http://localhost/admin/operations", {
          method: "POST",
          headers: { "Content-Type": "application/json", Origin: origin },
          body: JSON.stringify({
            id: f.ref.id,
            implementation: f.ref.implementation,
            enabled: false,
          }),
        });
    expect((await policy(make(), "8.8.8.8")).status).toBe(403);
    expect(
      (await policy(make("https://example.org"), "127.0.0.1")).status,
    ).toBe(403);
    expect((await policy(make(), "127.0.0.1")).status).toBe(200);
    await expect(
      host.invoke({
        ...f.ref,
        snapshot: f.reader.index.manifest.snapshot,
        input: { polygon },
      }),
    ).rejects.toThrow("disabled");
    f.engine.registry.setEnabled(f.ref.id, true);
    await hostPolicy(host, path);
    expect(f.engine.registry.describe(f.ref.id)?.enabled).toBe(false);
  } finally {
    await rm(path, { force: true });
    f.reader.dispose();
    f.engine.destroy();
  }
});
test("native plugin execution uses the exact hashed browser bundle", async () => {
  const root = new URL("../", import.meta.url).pathname,
    assets = await buildPlugins(root),
    loaded = await loadPlugins(root, assets),
    f = await pluginFixture();
  const a = assets[0]!,
    p = loaded[0]!;
  expect(
    new Bun.CryptoHasher("sha256")
      .update(await Bun.file(`${root}dist${a.url}`).arrayBuffer())
      .digest("hex"),
  ).toBe(a.implementation);
  const fromSource = await f.engine.registry.invoke(f.ref, { polygon });
  const fromBundle = await p.plugin.run(
    { polygon },
    {
      manifest: f.reader.index.manifest,
      signal: new AbortController().signal,
      data: { scanFeatures: (q) => f.engine.features.scan(q) },
      progress: () => {},
    },
  );
  expect(fromBundle).toEqual(fromSource);
  f.reader.dispose();
  f.engine.destroy();
});

test("lake definition is an explicit input, while wholly unclassified polygons report unsupported data", async () => {
  const f = await pluginFixture([
    water(1, 0.02),
    water(2, 0.1, { water: "oxbow" }),
  ]);
  const strict = (await f.engine.registry.invoke(f.ref, {
    polygon,
  })) as LakeResult;
  const oxbow = (await f.engine.registry.invoke(f.ref, {
    polygon,
    classification: "lake-and-oxbow",
  })) as LakeResult;
  expect(strict.features.map((f) => f.id)).toEqual(["way/1"]);
  expect(oxbow.features.map((f) => f.id)).toEqual(["way/2", "way/1"]);
  f.reader.dispose();
  f.engine.destroy();
  const unknown = water(3, 0.1);
  delete unknown.properties!.tags.water;
  const other = await pluginFixture([unknown]);
  await expect(
    other.engine.registry.invoke(other.ref, { polygon }),
  ).rejects.toThrow("classification unavailable");
  other.reader.dispose();
  other.engine.destroy();
});

test("in-flight results cannot escape cancellation or host revocation; data families are scoped", async () => {
  const f = await pluginFixture(),
    base = f.engine.registry.describe(f.ref.id)!;
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  f.engine.registry.register(
    {
      descriptor: {
        ...base,
        id: "test.pending",
        inputSchema: { type: "object" },
        outputSchema: { type: "object" },
      },
      run: async () => {
        await gate;
        return {};
      },
    },
    "pending",
  );
  const ref = {
    id: "test.pending",
    version: "1.0.0",
    implementation: "pending",
  };
  const running = f.engine.registry.invoke(ref, {});
  f.engine.registry.setEnabled(ref.id, false);
  finish();
  await expect(running).rejects.toThrow("disabled");
  f.engine.registry.setEnabled(ref.id, true);
  const cancellation = new AbortController();
  const cancelled = f.engine.registry.invoke(ref, {}, cancellation.signal);
  cancellation.abort();
  await expect(cancelled).rejects.toThrow();
  const before = f.reader.bytesRead;
  f.engine.registry.register(
    {
      descriptor: {
        ...base,
        id: "test.scope",
        inputSchema: { type: "object" },
        outputSchema: { type: "object" },
      },
      run: async (_, c) => {
        for await (const _ of c.data.scanFeatures({
          kind: "buildings",
          bounds: [9, 47, 9.1, 47.1],
        })) {
        }
        return {};
      },
    },
    "scope",
  );
  await expect(
    f.engine.registry.invoke(
      { id: "test.scope", version: "1.0.0", implementation: "scope" },
      {},
    ),
  ).rejects.toThrow("Undeclared feature family");
  expect(f.reader.bytesRead).toBe(before);
  f.reader.dispose();
  f.engine.destroy();
});

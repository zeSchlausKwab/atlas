import { expect, test } from "bun:test";
import { ChatDataRuntime } from "../packages/chat/src/data";
import { workspaceFixture } from "./helpers/workspace-fixture";
const signal = () => new AbortController().signal;

test("composed search ranks the named place ahead of first-map address matches", async () => {
  const { reader: west } = await workspaceFixture();
  const { reader: east } = await workspaceFixture([16, 48, 16.03, 48.03]);
  const runtime = new ChatDataRuntime([west, east]);
  const response = (id: string, name: string, aliases: string[]) => ({
    matches: [
      {
        id,
        name,
        aliases,
        coordinates: [16.01, 48.01] as [number, number],
        kind: "poi" as const,
        category: "park",
      },
    ],
    total: 1,
    snapshot: "test",
    cached: false,
    scope: "retained-source-data" as const,
  });
  runtime.geocoders[0]!.search = async () =>
    response("node/1", "A café", ["Praterstraße 1"]);
  runtime.geocoders[1]!.search = async () => response("way/10", "Prater", []);
  const found = await runtime.invoke(
    "search",
    { query: "Prater", limit: 1 },
    signal(),
  );
  expect(found.matches[0].name).toBe("Prater");
});

test("a named footprint comes from its search ID, not camera coordinates", async () => {
  const { reader } = await workspaceFixture();
  const runtime = new ChatDataRuntime([reader]);
  const found = await runtime.invoke(
    "search",
    { query: "Testgasse 12" },
    signal(),
  );
  const shape = await runtime.invoke(
    "place_geometry",
    { result: found.result, id: "way/10", family: "buildings" },
    signal(),
  );
  expect(shape.boundaryAvailable).toBe(true);
  expect(shape.bounds).toEqual([16.009, 48.009, 16.011, 48.011]);
  expect(
    (await runtime.resolve(shape.result)).collection.features[0]!.geometry.type,
  ).toBe("Polygon");
  await expect(
    runtime.invoke(
      "place_geometry",
      { result: found.result, id: "way/999" },
      signal(),
    ),
  ).rejects.toThrow("Choose an ID");
  const point = await runtime.invoke(
    "search",
    { query: "Coffee One" },
    signal(),
  );
  const missing = await runtime.invoke(
    "place_geometry",
    { result: point.result, id: "node/1", family: "land" },
    signal(),
  );
  expect(missing.boundaryAvailable).toBe(false);
  expect(missing.count).toBe(0);
  expect(missing.bounds).toBeNull();
});

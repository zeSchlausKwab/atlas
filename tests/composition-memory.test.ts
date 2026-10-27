import { expect, test } from "bun:test";
import { CompositionMap } from "../packages/renderer/src/composition";

test("memory telemetry works before a composition tool source is selected", () => {
  const map = Object.create(CompositionMap.prototype);
  map.sessions = new Map();
  const memory = map.memory;
  expect(memory.reader.directory.bytes).toBe(0);
  expect(memory.meshes.entries).toBe(0);
  expect(Object.keys(memory.reader.decoded).length).toBeGreaterThan(0);
});

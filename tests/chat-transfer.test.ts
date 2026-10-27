import { expect, test } from "bun:test";
import { AtlasReader } from "../packages/format/src/reader";
import { TransferLedger } from "../packages/format/src/transfer-ledger";
import { ChatDataRuntime } from "../packages/chat/src/data";
import { workspaceFixture, taskBounds } from "./helpers/workspace-fixture";

test("AI scoped readers report successful reads once, reuse adds no bytes, new chat keeps session accounting", async () => {
  const { reader } = await workspaceFixture();
  const ledger = new TransferLedger();
  let physicalBytes = 0,
    physicalReads = 0;
  const analysis = reader.fork(
    { onTransfer: (e) => ledger.record(e) },
    {
      read: async (a, b) => {
        const value = await reader.source.read(a, b);
        physicalBytes += value.length;
        physicalReads++;
        return value;
      },
    },
  );
  const runtime = new ChatDataRuntime([analysis]);
  const signal = new AbortController().signal;
  const p = await runtime.invoke(
    "workspace_prepare",
    { bounds: taskBounds, families: ["buildings"], geometry: true },
    signal,
  );
  expect(ledger.bytes).toBeGreaterThan(0);
  expect(ledger.forPurpose("features")).toBeGreaterThan(0);
  expect(ledger.bytes).toBe(physicalBytes);
  expect(ledger.requests).toBe(physicalReads);
  const before = ledger.bytes;
  await runtime.invoke("workspace_query", { workspace: p.workspace }, signal);
  expect(ledger.bytes).toBe(before);
  runtime.clear();
  expect(ledger.bytes).toBe(before);
  ledger.record({
    key: "features/buildings/1",
    start: 0,
    end: 100,
    bytes: 100,
    cached: true,
  });
  expect(ledger.bytes).toBe(before);
  reader.dispose();
  analysis.dispose();
});
test("failed range transfers are not counted", async () => {
  const ledger = new TransferLedger();
  const reader = new AtlasReader(
    {
      read: async () => {
        throw new Error("offline");
      },
    },
    undefined,
    { onTransfer: (e) => ledger.record(e) },
  );
  await expect(reader.open()).rejects.toThrow("offline");
  expect(ledger.bytes).toBe(0);
  expect(ledger.requests).toBe(0);
});

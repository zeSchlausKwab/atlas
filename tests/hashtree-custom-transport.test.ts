import { expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { buildTreeIndex, IndexedTree } from "../packages/hashtree/src/build";
import {
  HashtreeSource,
  MAX_BLOB_BYTES,
  parseTree,
  type TreeOffer,
} from "../packages/hashtree/src/source";
import type { BlockStore } from "../packages/format/src/store";

async function fixture() {
  const dir = await mkdtemp("/tmp/atlas-custom-transport-");
  const data = randomBytes(200_000);
  await Bun.write(`${dir}/map.atlas`, data);
  const info = await buildTreeIndex(`${dir}/map.atlas`, `${dir}/index`);
  const index = IndexedTree.open(`${dir}/index`);
  const tree: TreeOffer = {
    version: 1,
    root: info.root,
    bytes: info.bytes,
    chunkBytes: info.chunkBytes,
    providers: ["https://unused.example/blobs"],
  };
  return {
    data,
    index,
    tree,
    close: async () => {
      index.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test("custom transport reads verified ranges and preserves counters, memory and offline storage", async () => {
  const f = await fixture();
  const fetchSpy = spyOn(globalThis, "fetch").mockRejectedValue(
    new Error("HTTP forbidden"),
  );
  const blocks = new Map<string, Uint8Array>();
  const store: BlockStore = {
    available: true,
    getIndex: async () => undefined,
    putIndex: async () => {},
    keys: async () => [...blocks.keys()],
    get: async (snapshot, block) => blocks.get(`${snapshot}:${block.hash}`),
    put: async (snapshot, block, bytes) => {
      blocks.set(`${snapshot}:${block.hash}`, bytes);
    },
  };
  let offline = false,
    calls = 0,
    transferred = 0;
  try {
    const noHttpProviders = { ...f.tree, providers: [] };
    expect(() => parseTree(noHttpProviders, noHttpProviders.bytes)).toThrow(
      "Invalid Hashtree offer",
    );
    expect(
      () => new HashtreeSource("fips://peer/root", noHttpProviders),
    ).toThrow("Invalid Hashtree offer");
    const source = new HashtreeSource(
      "fips://peer/root",
      noHttpProviders,
      undefined,
      {
        store,
        offline: () => offline,
        fetchBlob: async (hash, signal) => {
          expect(signal).toBeInstanceOf(AbortSignal);
          signal.throwIfAborted();
          calls++;
          const bytes = await f.index.get(hash);
          transferred += bytes?.length ?? 0;
          return bytes;
        },
      },
    );
    const expected = new Uint8Array(f.data.slice(65530, 65560));
    expect(await source.read(65530, 65560)).toEqual(expected);
    expect(calls).toBe(3);
    expect(source.requests).toBe(calls);
    expect(source.networkBytes).toBe(transferred);
    expect(source.failovers).toBe(0);
    expect(await source.read(65530, 65560)).toEqual(expected);
    expect(calls).toBe(3);
    offline = true;
    source.clear();
    expect(await source.read(65530, 65560)).toEqual(expected);
    expect(calls).toBe(3);
    expect(source.networkBytes).toBe(transferred);
    await expect(source.read(180000, 180010)).rejects.toThrow("Missing cached");
    expect(fetchSpy).not.toHaveBeenCalled();
  } finally {
    fetchSpy.mockRestore();
    await f.close();
  }
});

test("custom transport rejects corrupt and oversized blobs without HTTP fallback or caching", async () => {
  const f = await fixture();
  const fetchSpy = spyOn(globalThis, "fetch").mockRejectedValue(
    new Error("HTTP forbidden"),
  );
  try {
    let response = new Uint8Array([1, 2, 3]);
    const source = new HashtreeSource(
      "https://unused.example/map",
      f.tree,
      undefined,
      {
        fetchBlob: async () => response,
      },
    );
    await expect(source.read(0, 1)).rejects.toThrow("Blob hash mismatch");
    response = new Uint8Array(MAX_BLOB_BYTES + 1);
    await expect(source.read(0, 1)).rejects.toThrow("Oversized blob");
    expect(source.requests).toBe(2);
    expect(source.failovers).toBe(2);
    expect(fetchSpy).not.toHaveBeenCalled();
  } finally {
    fetchSpy.mockRestore();
    await f.close();
  }
});

test("custom transport errors and misses remain retryable and never fall through to HTTP", async () => {
  const f = await fixture();
  const fetchSpy = spyOn(globalThis, "fetch").mockRejectedValue(
    new Error("HTTP forbidden"),
  );
  try {
    let mode: "error" | "missing" | "found" = "error";
    const source = new HashtreeSource(
      "https://unused.example/map",
      f.tree,
      undefined,
      {
        fetchBlob: async (hash) => {
          if (mode === "error") throw new Error("FIPS disconnected");
          return mode === "missing" ? null : f.index.get(hash);
        },
      },
    );
    await expect(source.read(0, 1)).rejects.toThrow("FIPS disconnected");
    mode = "missing";
    await expect(source.read(0, 1)).rejects.toThrow("Blob unavailable");
    mode = "found";
    expect(await source.read(0, 1)).toEqual(new Uint8Array(f.data.slice(0, 1)));
    expect(source.requests).toBe(4);
    expect(source.failovers).toBe(2);
    expect(fetchSpy).not.toHaveBeenCalled();
  } finally {
    fetchSpy.mockRestore();
    await f.close();
  }
});

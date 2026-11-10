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

test("custom transport allows a valid blob beyond the default deadline when configured", async () => {
  const f = await fixture();
  const fetchSpy = spyOn(globalThis, "fetch").mockRejectedValue(
    new Error("HTTP forbidden"),
  );
  let elapsed = 0;
  const deadlines: Array<{
    delay: number;
    expiresAt: number;
    controller: AbortController;
  }> = [];
  // Drive the real request signal without waiting ten wall-clock seconds.
  // Each timeout still aborts with the same reason the browser reports.
  const timeoutSpy = spyOn(AbortSignal, "timeout").mockImplementation(
    (delay) => {
      const controller = new AbortController();
      deadlines.push({ delay, expiresAt: elapsed + delay, controller });
      return controller.signal;
    },
  );
  const advance = (milliseconds: number) => {
    elapsed += milliseconds;
    for (const deadline of deadlines)
      if (deadline.expiresAt <= elapsed && !deadline.controller.signal.aborted)
        deadline.controller.abort(
          new DOMException("signal timed out", "TimeoutError"),
        );
  };
  let calls = 0;
  try {
    const options = {
      requestTimeoutMs: 30_000,
      fetchBlob: async (hash: string, signal: AbortSignal) => {
        const bytes = await f.index.get(hash);
        if (++calls === 1) advance(12_000);
        signal.throwIfAborted();
        return bytes;
      },
    };
    const source = new HashtreeSource(
      "fips://peer/root",
      { ...f.tree, providers: [] },
      undefined,
      options,
    );

    expect(await source.read(0, 1)).toEqual(new Uint8Array(f.data.slice(0, 1)));
    expect(deadlines[0]?.delay).toBe(30_000);
    expect(calls).toBe(2);
    expect(source.failovers).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  } finally {
    timeoutSpy.mockRestore();
    fetchSpy.mockRestore();
    await f.close();
  }
});

test("custom transport enforces an explicitly short deadline without HTTP fallback", async () => {
  const f = await fixture();
  const fetchSpy = spyOn(globalThis, "fetch").mockRejectedValue(
    new Error("HTTP forbidden"),
  );
  try {
    const source = new HashtreeSource(
      "fips://peer/root",
      { ...f.tree, providers: [] },
      undefined,
      {
        requestTimeoutMs: 10,
        fetchBlob: (_hash, signal) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), {
              once: true,
            });
          }),
      },
    );
    await expect(source.read(0, 1)).rejects.toThrow("TimeoutError");
    expect(source.requests).toBe(1);
    expect(source.failovers).toBe(1);
    expect(source.networkBytes).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  } finally {
    fetchSpy.mockRestore();
    await f.close();
  }
}, 1000);

test("caller cancellation interrupts a custom transport with a longer configured deadline", async () => {
  const f = await fixture();
  const fetchSpy = spyOn(globalThis, "fetch").mockRejectedValue(
    new Error("HTTP forbidden"),
  );
  const caller = new AbortController();
  const started = Promise.withResolvers<AbortSignal>();
  try {
    const source = new HashtreeSource(
      "fips://peer/root",
      { ...f.tree, providers: [] },
      undefined,
      {
        requestTimeoutMs: 30_000,
        fetchBlob: (_hash, signal) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), {
              once: true,
            });
            started.resolve(signal);
          }),
      },
    );
    const reading = source.read(0, 1, caller.signal);
    void reading.catch(() => {});
    const transportSignal = await started.promise;
    const reason = new DOMException("Map closed", "AbortError");
    caller.abort(reason);
    await expect(reading).rejects.toBe(reason);
    expect(transportSignal.aborted).toBe(true);
    expect(source.failovers).toBe(0);
    expect(source.networkBytes).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  } finally {
    caller.abort();
    fetchSpy.mockRestore();
    await f.close();
  }
}, 1000);

test("Hashtree request deadlines must be positive finite safe integers", async () => {
  const f = await fixture();
  try {
    for (const requestTimeoutMs of [
      0,
      -1,
      1.5,
      NaN,
      Infinity,
      Number.MAX_SAFE_INTEGER + 1,
    ])
      expect(
        () =>
          new HashtreeSource("https://unused.example/map", f.tree, undefined, {
            requestTimeoutMs,
          }),
      ).toThrow("Invalid Hashtree request timeout");
    for (const requestTimeoutMs of [1, 30_000, Number.MAX_SAFE_INTEGER])
      expect(
        () =>
          new HashtreeSource("https://unused.example/map", f.tree, undefined, {
            requestTimeoutMs,
          }),
      ).not.toThrow();
  } finally {
    await f.close();
  }
});

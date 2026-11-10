import {
  initialPublishedView,
  requestedMapIds,
  resolveViewSources,
} from "../apps/web/src/composition-selection";
import {
  defaultPresentation,
  type ViewRecipe,
} from "../packages/views/src/index";
import {
  viewAnnouncement,
  parseViewAnnouncement,
} from "../packages/views/src/announcement";
import { finalizeEvent, generateSecretKey } from "nostr-tools/pure";
import { expect, spyOn, test } from "bun:test";
import {
  deliveryChoice,
  deliveryLabel,
  fipsOperationRequest,
  mapSource,
  remoteForSource,
  sourceDelivery,
  type FipsRequest,
} from "../apps/web/src/transport";
import {
  clientConnection,
  discoveryConnection,
} from "../apps/web/src/connection";
import { clientHandler } from "../apps/web/server";
import { clientLink } from "../apps/shared/urls";
import { RemoteOperations } from "../packages/operations/src/index";
import type { TreeOffer } from "../packages/hashtree/src/source";
import type { MapOffer } from "../packages/format/src/catalog";
import { workspaceFixture } from "./helpers/workspace-fixture";

const root = "a".repeat(64),
  snapshot = "c".repeat(64);
const tree: TreeOffer = {
  version: 1,
  root,
  bytes: 100,
  chunkBytes: 65536,
  providers: ["https://unused.example/blobs"],
  fips: [
    {
      peerId: "02" + "b".repeat(64),
      seedUrls: ["wss://seed.example/fips"],
      rpcPort: 39019,
    },
  ],
};

test("FIPS is the client default; HTTP and fallback require explicit choices", () => {
  expect(deliveryChoice(new URLSearchParams())).toEqual({
    transport: "fips",
    allowHttpFallback: false,
  });
  expect(
    deliveryChoice(new URLSearchParams("transport=http&httpFallback=1")),
  ).toEqual({ transport: "http", allowHttpFallback: false });
  expect(deliveryChoice(new URLSearchParams("httpFallback=1"))).toEqual({
    transport: "fips",
    allowHttpFallback: true,
  });
  expect(deliveryChoice(new URLSearchParams(), "http").transport).toBe("http");
  expect(
    deliveryChoice(new URLSearchParams("transport=fips"), "http").transport,
  ).toBe("fips");
  expect(() =>
    deliveryChoice(new URLSearchParams("transport=automatic")),
  ).toThrow("Choose FIPS or HTTP");
  expect(
    deliveryLabel({ ...tree, fips: [] }, deliveryChoice(new URLSearchParams())),
  ).toContain("FIPS unavailable");
});

test("publisher and relays are a self-contained discovery address, independent of HTTP", () => {
  expect(
    discoveryConnection(
      new URLSearchParams(
        `publisher=${root}&relay=wss://relay.example&relay=wss://relay.example`,
      ),
    ),
  ).toEqual({ publisher: root, relays: ["wss://relay.example/"] });
  expect(discoveryConnection(new URLSearchParams())).toBeUndefined();
  expect(() =>
    discoveryConnection(new URLSearchParams(`publisher=${root}`)),
  ).toThrow("relay");
  expect(() =>
    discoveryConnection(
      new URLSearchParams("publisher=alice&relay=wss://relay.example"),
    ),
  ).toThrow("public key");
  expect(() =>
    discoveryConnection(
      new URLSearchParams(`publisher=${root}&relay=https://relay.example`),
    ),
  ).toThrow();
});

test("FIPS tools preserve pinned roots, snapshots, method, arguments and response headers without HTTP", async () => {
  const http = spyOn(globalThis, "fetch").mockRejectedValue(
    new Error("No HTTP permitted"),
  );
  const calls: Parameters<FipsRequest>[] = [];
  const invoke: FipsRequest = async (...args) => {
    calls.push(args);
    return {
      status: 200,
      headers: { "X-Atlas-Snapshot": snapshot },
      body: {
        result: { snapshot, name: "Peak", elevation: 100 },
        execution: {
          side: "server",
          operation: "peak",
          computeMs: 1,
          sourceBytes: 7,
        },
      },
    };
  };
  try {
    const client = new RemoteOperations(
      `htree://${root}`,
      snapshot,
      fipsOperationRequest(tree, invoke),
    );
    const result = await client.call("peak", {});
    expect(result.result.snapshot).toBe(snapshot);
    expect(result.execution.side).toBe("server");
    expect(result.execution.responseBytes).toBeGreaterThan(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]![0]).toEqual(tree.fips![0]!);
    expect(calls[0]![1]).toEqual({
      root,
      path: "/peak",
      method: "POST",
      body: { snapshot, input: {} },
    });
    expect(http).not.toHaveBeenCalled();
    const wrong = new RemoteOperations(
      `htree://${root}`,
      snapshot,
      fipsOperationRequest(tree, async () => ({
        status: 200,
        headers: { "X-Atlas-Snapshot": root },
        body: {},
      })),
    );
    await expect(wrong.call("peak", {})).rejects.toThrow(
      "different map snapshot",
    );
  } finally {
    http.mockRestore();
  }
});

test("FIPS binary offline exports keep their bytes and execution metadata", async () => {
  const bytes = new Uint8Array([65, 84, 76, 83]);
  const request = fipsOperationRequest(tree, async () => ({
    status: 200,
    bytes,
    headers: {
      "X-Atlas-Snapshot": snapshot,
      "X-Atlas-Compute-Ms": "21",
      "X-Atlas-Source-Bytes": "99",
      "content-type": "application/vnd.atlas",
    },
  }));
  const response = await request("/members/m0/offline", {
    method: "POST",
    body: JSON.stringify({ snapshot, input: {} }),
  });
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
  expect(response.headers.get("X-Atlas-Source-Bytes")).toBe("99");
  expect(response.headers.get("Content-Type")).toBe("application/vnd.atlas");
});

test("remote errors and cancellation never replay a stateful operation on another provider", async () => {
  let calls = 0;
  const request = fipsOperationRequest(
    {
      ...tree,
      fips: [
        ...tree.fips!,
        { ...tree.fips![0]!, peerId: "03" + "d".repeat(64) },
      ],
    },
    async () => {
      calls++;
      throw new Error("Connection lost after dispatch");
    },
  );
  await expect(
    request("/workspace.prepare", { method: "POST", body: "{}" }),
  ).rejects.toThrow("Connection lost");
  expect(calls).toBe(1);
  const abort = new AbortController();
  abort.abort(new Error("Cancelled"));
  await expect(
    request("/capabilities", { signal: abort.signal }),
  ).rejects.toThrow("Cancelled");
  expect(calls).toBe(1);
  await expect(
    fipsOperationRequest({
      ...tree,
      fips: [{ ...tree.fips![0]!, rpcPort: undefined }],
    })("/capabilities"),
  ).rejects.toThrow("does not advertise server tools");
});

test("reader policy also governs server tools; data fallback never opts into HTTP RPC", async () => {
  const fixture = await workspaceFixture();
  try {
    const offer: MapOffer = {
      id: "fixture",
      url: `htree://${root}`,
      api: "https://unused.example/api",
      bytes: 100,
      manifest: fixture.reader.index.manifest,
      hashtree: tree,
    };
    const fips = mapSource(offer);
    expect(sourceDelivery(fips).transport).toBe("fips");
    expect(remoteForSource(fips, snapshot, sourceDelivery(fips))).toBeDefined();
    const http = mapSource(offer, {
      transport: "http",
      allowHttpFallback: false,
    });
    expect(sourceDelivery(http).transport).toBe("http");
    expect(
      remoteForSource(http, snapshot, sourceDelivery(http), "/members/m0")!.url,
    ).toBe("https://unused.example/api/members/m0");
    const noRpc = mapSource(
      {
        ...offer,
        hashtree: {
          ...tree,
          fips: tree.fips!.map((p) => ({ ...p, rpcPort: undefined })),
        },
      },
      { transport: "fips", allowHttpFallback: true },
    );
    expect(
      remoteForSource(noRpc, snapshot, sourceDelivery(noRpc)),
    ).toBeUndefined();
  } finally {
    fixture.reader.dispose();
  }
});

test("standalone demo can explicitly configure HTTP without changing the normal default", async () => {
  const handler = clientHandler(
    "/tmp",
    "http://127.0.0.1:3100",
    undefined,
    "http",
  );
  const response = await handler(
    new Request("http://127.0.0.1/client-config.json"),
  );
  expect(await response.json()).toEqual({
    serverUrl: "http://127.0.0.1:3100/",
    transport: "http",
  });
});

test("a signed discovery launch never requests an HTTP bootstrap or client config", async () => {
  const previousDocument = Object.getOwnPropertyDescriptor(
    globalThis,
    "document",
  );
  const previousLocation = Object.getOwnPropertyDescriptor(
    globalThis,
    "location",
  );
  const nodes = new Map<string, Record<string, unknown>>();
  const node = (id: string) => {
    if (!nodes.has(id)) nodes.set(id, {});
    return nodes.get(id)!;
  };
  const url = new URL(
    `http://client.example/?publisher=${root}&relay=wss://relay.example`,
  );
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { getElementById: node, querySelector: node },
  });
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: { search: url.search, href: url.href },
  });
  const http = spyOn(globalThis, "fetch").mockRejectedValue(
    new Error("No HTTP bootstrap permitted"),
  );
  try {
    const connection = await clientConnection();
    expect(connection.discovery).toEqual({
      publisher: root,
      relays: ["wss://relay.example/"],
    });
    expect(connection.catalog).toBeUndefined();
    expect(connection.server).toBeUndefined();
    expect(connection.delivery.transport).toBe("fips");
    expect(nodes.get("host-console")!.hidden).toBe(true);
    expect(http).not.toHaveBeenCalled();
    url.searchParams.set("source", "https://map.example/demo.atlas");
    Object.defineProperty(globalThis, "location", {
      configurable: true,
      value: { search: url.search, href: url.href },
    });
    await expect(clientConnection()).rejects.toThrow("explicit HTTP delivery");
    url.searchParams.set("transport", "http");
    Object.defineProperty(globalThis, "location", {
      configurable: true,
      value: { search: url.search, href: url.href },
    });
    expect((await clientConnection()).source).toBe(
      "https://map.example/demo.atlas",
    );
    expect(http).not.toHaveBeenCalled();
  } finally {
    http.mockRestore();
    if (previousDocument)
      Object.defineProperty(globalThis, "document", previousDocument);
    else Reflect.deleteProperty(globalThis, "document");
    if (previousLocation)
      Object.defineProperty(globalThis, "location", previousLocation);
    else Reflect.deleteProperty(globalThis, "location");
  }
});

test("switching to an explicit HTTP bootstrap clears a prior publisher address", () => {
  const url = new URL(
    clientLink(
      `http://client.example/?publisher=${root}&relay=wss://relay.example&transport=http`,
      "http://127.0.0.1:3100/",
      { maps: ["demo"] },
    ),
  );
  expect(url.searchParams.get("server")).toBe("http://127.0.0.1:3100/");
  expect(url.searchParams.has("publisher")).toBe(false);
  expect(url.searchParams.has("relay")).toBe(false);
  expect(url.searchParams.get("transport")).toBe("http");
});

test("stateful FIPS tools stay on one provider across reordered offers and reject its withdrawal", async () => {
  const offer = structuredClone(tree);
  const peer = offer.fips![0]!;
  const other = { ...peer, peerId: "03" + "d".repeat(64) };
  const dispatched: Parameters<FipsRequest>[] = [];
  const request = fipsOperationRequest(offer, async (...args) => {
    dispatched.push(args);
    return { status: 200, body: {} };
  });
  await request("/workspace.prepare", { method: "POST", body: "{}" });
  offer.fips = [other, peer];
  await request("/workspace.query", { method: "POST", body: "{}" });
  expect(dispatched.map(([provider]) => provider.peerId)).toEqual([
    peer.peerId,
    peer.peerId,
  ]);
  offer.fips = [other];
  await expect(
    request("/workspace.query", { method: "POST", body: "{}" }),
  ).rejects.toThrow("withdrawn");
  expect(dispatched).toHaveLength(2);
});

test("legacy map IDs use the same selection policy as multi-map discovery", () => {
  expect(requestedMapIds(new URLSearchParams("map=demo"))).toEqual(["demo"]);
  expect(requestedMapIds(new URLSearchParams("map=old&maps=a,b"))).toEqual([
    "a",
    "b",
  ]);
  expect(requestedMapIds(new URLSearchParams())).toBeUndefined();
});

test("a partially available publisher view keeps its roots and never selects unrelated offers", async () => {
  const fixture = await workspaceFixture();
  try {
    const key = generateSecretKey();
    const recipe: ViewRecipe = {
      version: 1,
      id: "default",
      name: "Pinned pair",
      sources: [root, "d".repeat(64)].map((root) => ({
        root,
        url: `htree://${root}`,
        enabled: true,
        layers: ["water"],
        labels: false,
      })),
      presentation: defaultPresentation(),
      coverage: true,
    };
    const event = viewAnnouncement(recipe, key);
    const selected = parseViewAnnouncement(
      finalizeEvent(
        {
          kind: event.kind,
          created_at: event.created_at,
          content: event.content,
          tags: [...event.tags, ["default", "true"]],
        },
        key,
      ),
    );
    const chosen = initialPublishedView(
      [selected],
      selected.event.pubkey,
      null,
    )!;
    const offer: MapOffer = {
      id: "available",
      url: `htree://${root}`,
      bytes: 100,
      manifest: fixture.reader.index.manifest,
      hashtree: tree,
    };
    const unrelated = {
      ...offer,
      id: "unrelated",
      url: `htree://${snapshot}`,
      hashtree: { ...tree, root: snapshot },
    };
    const result = resolveViewSources(chosen.recipe, [offer, unrelated]);
    expect(result.available.get(offer)?.enabled).toBe(true);
    expect(result.available.get(offer)?.layers).toEqual(["water"]);
    expect(result.available.get(unrelated)).toBeUndefined();
    expect(result.missing.map((source) => source.root)).toEqual([
      "d".repeat(64),
    ]);
    expect(() =>
      initialPublishedView([selected], selected.event.pubkey, "e".repeat(64)),
    ).toThrow("No maps were selected in its place");
  } finally {
    fixture.reader.dispose();
  }
});

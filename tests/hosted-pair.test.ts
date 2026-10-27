import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { hostedPair, type PairPlan } from "../scripts/hosted-pair";
import type { PackageSelection } from "../packages/provisioning/src/selection";
test("hosted pair coordinator reuses persisted jobs and stops on failed builds", async () => {
  const dir = await mkdtemp("/tmp/atlas-pair-coordinator-"),
    jobs: any[] = [],
    pubs: any[] = [];
  let posts = 0,
    failed = false;
  const base = {
    snapshot: "geofabrik",
    name: "Parent",
    polygon: [
      [16, 48],
      [17, 48],
      [17, 49],
      [16, 49],
    ],
    minZoom: 0,
    maxZoom: 16,
    layers: ["water"],
    profiles: ["walking", "cycling", "driving"],
    featureKinds: ["water"],
    placeNames: true,
    streetNames: true,
    pois: true,
    search: true,
    reverse: true,
    peaks: true,
    paddingCells: 1,
    maxBytes: 1024 ** 3,
  } as PackageSelection;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const p = new URL(req.url).pathname;
      if (p === "/admin/preparations") {
        if (req.method === "GET")
          return Response.json({
            cachedSources: [{ id: "source", sha256: "pinned" }],
            jobs,
          });
        posts++;
        const s = await req.json();
        const j = {
          id: crypto.randomUUID(),
          name: s.name,
          selection: s,
          createdAt: new Date().toISOString(),
          state: failed ? "failed" : "ready",
          size: 123,
          manifest: {
            snapshot: "snapshot-" + posts,
            selection: s.sourceAtlasId
              ? { parentSnapshot: s.snapshot }
              : undefined,
            semantics: { addresses: "osm-explicit" },
            transport: {
              graphSnapshot: "graph",
              profiles: { walking: {}, cycling: {}, driving: {} },
            },
          },
          progress: { message: "Ready" },
        };
        jobs.push(j);
        return Response.json(j);
      }
      if (req.method === "POST") {
        const { id } = await req.json();
        pubs.push({ id, state: "ready" });
      }
      return Response.json({ jobs: pubs });
    },
  });
  try {
    const plan: PairPlan = {
      server: server.url.origin,
      sourceId: "source",
      sourceHash: "pinned",
      parent: base,
      chunks: [
        { ...base, name: "West" },
        { ...base, name: "East" },
      ],
    };
    expect((await hostedPair(plan, dir + "/state", 1)).phase).toBe("ready");
    expect(posts).toBe(3);
    expect(pubs.length).toBe(2);
    await hostedPair(plan, dir + "/state", 1);
    expect(posts).toBe(3);
    expect(pubs.length).toBe(2);
    failed = true;
    const changed = { ...plan, parent: { ...base, name: "Other parent" } };
    await expect(hostedPair(changed, dir + "/other-state", 1)).rejects.toThrow(
      "failed",
    );
    expect(posts).toBe(4);
  } finally {
    server.stop(true);
    await rm(dir, { recursive: true, force: true });
  }
});

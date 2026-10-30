import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { Federation } from "../apps/server/federation";
import { ArchiveUploads } from "../apps/server/archive-uploads";
import { Preparations } from "../apps/server/preparations";
import { adminAccess } from "../apps/server/admin-access";
import { pluginFixture, polygon } from "./helpers/plugin-fixture";
import { publishedHost } from "./helpers/published-host";
import { encodePackage } from "../packages/format/src/writer";
import { AtlasReader, FileSource } from "../packages/format/src/reader";
import { packComposition } from "../packages/provisioning/src/composition";
import type { MapOffer } from "../packages/format/src/catalog";
async function until(check: () => boolean) {
  const end = Date.now() + 20000;
  while (!check()) {
    if (Date.now() > end) throw Error("Timed out");
    await Bun.sleep(10);
  }
}
async function setup(large = false) {
  const dir = await mkdtemp("/tmp/atlas-federation-"),
    fixture = await pluginFixture();
  const bytes = large
    ? await encodePackage(
        { ...fixture.reader.index.manifest, name: "Mirror fixture" },
        [{ key: "custom/payload", bytes: randomBytes(9 * 1024 ** 2) }],
        { paged: true },
      )
    : fixture.bytes;
  const path = dir + "/source.atlas";
  await Bun.write(path, bytes);
  const reader = await new AtlasReader(new FileSource(Bun.file(path))).open();
  const manager = await Preparations.open(
    dir + "/hosted",
    path,
    reader.index.manifest,
  );
  let uploads = await ArchiveUploads.open(dir + "/uploads", manager),
    local: Array<{ id: string; path: string; offer: MapOffer }> = [];
  let federation = await Federation.open(
    dir + "/federation",
    adminAccess(),
    () => local,
    uploads,
  );
  const host = await publishedHost(path, dir + "/publisher");
  const call = (action = "", body?: unknown, origin = "http://localhost") =>
    federation.handle(
      new Request("http://localhost/admin/federation" + action, {
        method: body === undefined ? "GET" : "POST",
        headers: { Origin: origin },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      "127.0.0.1",
    );
  return {
    dir,
    fixture,
    reader,
    bytes,
    path,
    host,
    manager,
    call,
    get uploads() {
      return uploads;
    },
    get federation() {
      return federation;
    },
    setLocal: (values: typeof local) => {
      local = values;
    },
    restart: async () => {
      await federation.close();
      uploads = await ArchiveUploads.open(dir + "/uploads", manager);
      federation = await Federation.open(
        dir + "/federation",
        adminAccess(),
        () => local,
        uploads,
      );
    },
    close: async () => {
      await federation.close();
      await manager.close();
      await host.close();
      reader.dispose();
      fixture.engine.destroy();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
const req = { polygon, family: "features", zoom: 14 };
test("host consumes signed offers and verified Hashtree metadata; failed access becomes unknown", async () => {
  const s = await setup();
  try {
    expect((await s.call("/peer", { url: s.host.origin })).status).toBe(200);
    await s.federation.settled();
    const state = s.federation.view();
    expect(state.peers[0]!.pubkey).toBe(s.host.pubkey);
    expect(state.sources[0]!.verified).toBe(true);
    let plan = s.federation.plan(req);
    expect(plan.totals.remote).toBeCloseTo(plan.areaM2, 3);
    expect(plan.providers[0]!.root).toBe(s.host.offer.hashtree!.root);
    expect(s.host.stats().rawRequests).toBe(0);
    expect(s.host.stats().blobRequests).toBeGreaterThan(0);
    s.host.unavailable();
    s.federation.refresh();
    await s.federation.settled();
    plan = s.federation.plan(req);
    expect(plan.totals.unknown).toBeCloseTo(plan.areaM2, 3);
    expect(plan.totals.remote).toBe(0);
    expect((await s.call("/mirror", { id: state.sources[0]!.id })).status).toBe(
      400,
    );
  } finally {
    await s.close();
  }
}, 20000);
test("host controls require same-origin administration and pin publisher identities", async () => {
  const s = await setup();
  let fake: Bun.Server<any> | undefined;
  try {
    expect((await s.call("/refresh", {}, "http://evil.test")).status).toBe(403);
    expect(
      (
        await s.federation.handle(
          new Request("http://public.test/admin/federation"),
          "8.8.8.8",
        )
      ).status,
    ).toBe(403);
    let key = "a".repeat(64);
    fake = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => Response.json({ pubkey: key, publications: [] }),
    });
    expect((await s.call("/peer", { url: fake.url.origin })).status).toBe(200);
    await s.federation.settled();
    key = "b".repeat(64);
    const changed = await s.call("/peer", { url: fake.url.origin });
    expect(changed.status).toBe(400);
    expect((await changed.json()).error).toContain("key changed");
    expect(s.federation.view().peers[0]!.pubkey).toBe("a".repeat(64));
    expect(
      (await s.call("/remove-peer", { url: fake.url.origin })).status,
    ).toBe(200);
    expect(s.federation.view().peers).toHaveLength(0);
  } finally {
    fake?.stop(true);
    await s.close();
  }
});
test("mirroring pauses, survives restart, verifies and registers exactly one self-contained archive", async () => {
  const s = await setup(true);
  try {
    await s.call("/peer", { url: s.host.origin });
    await s.federation.settled();
    const id = s.federation.view().sources[0]!.id;
    const saved = Promise.withResolvers<void>(),
      acknowledge = Promise.withResolvers<void>();
    const upload = s.uploads.handle.bind(s.uploads);
    s.uploads.handle = async (...args) => {
      const response = await upload(...args);
      if (args[0].method === "PUT") {
        saved.resolve();
        await acknowledge.promise;
      }
      return response;
    };
    const created = await s.call("/mirror", { id });
    expect(created.status).toBe(202);
    const m = await created.json();
    await saved.promise;
    const pausing = s.call("/pause", { id: m.id });
    acknowledge.resolve();
    expect((await pausing).status).toBe(200);
    expect(s.federation.view().mirrors[0]!.state).toBe("paused");
    const offset = s.federation.view().mirrors[0]!.offset;
    expect(offset).toBe(4 * 1024 ** 2);
    await s.restart();
    expect(s.federation.view().mirrors[0]!.offset).toBe(offset);
    expect((await s.call("/resume", { id: m.id })).status).toBe(202);
    await until(() =>
      ["queued-import", "failed"].includes(
        s.federation.view().mirrors[0]!.state,
      ),
    );
    expect(s.federation.view().mirrors[0]!.error).toBeUndefined();
    expect(s.federation.view().mirrors[0]!.state).toBe("queued-import");
    await until(() =>
      ["ready", "failed"].includes(s.manager.jobs.get(m.id)!.state),
    );
    const job = s.manager.jobs.get(m.id)!;
    expect(job.error).toBeUndefined();
    expect(job.state).toBe("ready");
    expect(
      new Uint8Array(await Bun.file(s.manager.path(m.id)).arrayBuffer()),
    ).toEqual(s.bytes);
    expect((await s.call("/resume", { id: m.id })).status).toBe(202);
    expect(s.manager.jobs.size).toBe(1);
    expect(s.host.stats().rawRequests).toBe(0);
  } finally {
    await s.close();
  }
}, 30000);
test("portable composition coverage uses member areas rather than the parent envelope", async () => {
  const s = await setup();
  let parent: AtlasReader | undefined, b: AtlasReader | undefined;
  try {
    const bytes = await encodePackage(
      {
        ...s.reader.index.manifest,
        name: "Far away",
        bounds: [20, 47, 20.2, 47.2],
      },
      [],
    );
    b = await new AtlasReader(new FileSource(new Blob([bytes]))).open();
    const path = s.dir + "/combined.atlas";
    await packComposition(
      [s.reader, b],
      "Combined",
      path,
      1024 ** 2,
      new AbortController().signal,
      () => {},
    );
    parent = await new AtlasReader(new FileSource(Bun.file(path))).open();
    s.setLocal([
      {
        id: "combo",
        path,
        offer: {
          id: "combo",
          url: "/maps/combo.atlas",
          api: "/api",
          bytes: Bun.file(path).size,
          manifest: parent.index.manifest,
        },
      },
    ]);
    s.federation.refresh();
    await s.federation.settled();
    expect(s.federation.view().sources).toHaveLength(2);
    const r = s.federation.plan({
      ...req,
      polygon: [
        [12, 47],
        [13, 47],
        [13, 47.2],
        [12, 47.2],
      ],
    });
    expect(r.totals.local).toBe(0);
    expect(r.totals.missing).toBeCloseTo(r.areaM2, 3);
    expect(s.federation.plan(req).totals.local).toBeGreaterThan(0);
  } finally {
    parent?.dispose();
    b?.dispose();
    await s.close();
  }
});

test("area API requires partial-coverage review and imports a portable file that survives cache deletion", async () => {
  const s = await setup();
  try {
    await s.call("/peer", { url: s.host.origin });
    await s.federation.settled();
    const source = s.federation.view().sources[0]!;
    const body = {
      name: "Selected offline data",
      polygon,
      families: ["features", "addresses"],
      minZoom: 0,
      maxZoom: 0,
      paddingCells: 0,
      sourceIds: [source.id],
    };
    expect((await s.call("/area-plan", body, "http://evil.test")).status).toBe(
      403,
    );
    const created = await s.call("/area-plan", body);
    expect(created.status).toBe(202);
    const { id } = await created.json();
    await until(() => s.federation.view().acquisitions[0]?.state === "review");
    expect(s.federation.view().acquisitions[0]!.plan!.incomplete).toBe(true);
    await s.restart();
    const denied = await s.call("/area-resume", { id });
    expect(denied.status).toBe(400);
    expect((await denied.json()).error).toContain("Coverage has gaps");
    expect(
      (await s.call("/area-resume", { id, acceptPartial: true })).status,
    ).toBe(202);
    await until(() =>
      ["ready", "failed"].includes(s.federation.view().acquisitions[0]!.state),
    );
    expect(s.federation.view().acquisitions[0]!.error).toBeUndefined();
    await s.restart();
    s.host.unavailable();
    const download = await s.call(`/area-file/${id}`);
    expect(download.status).toBe(200);
    expect(download.headers.get("Content-Disposition")).toContain("attachment");
    const exported = new Uint8Array(await download.arrayBuffer());
    expect((await s.call("/area-publish", { id })).status).toBe(202);
    await until(() =>
      ["ready", "failed"].includes(s.manager.jobs.get(id)?.state ?? ""),
    );
    expect(s.manager.jobs.get(id)!.error).toBeUndefined();
    expect((await s.call("/area-publish", { id })).status).toBe(202);
    expect(s.manager.jobs.size).toBe(1);
    expect((await s.call("/area-delete", { id })).status).toBe(200);
    expect(s.federation.view().acquisitions).toHaveLength(0);
    expect(
      new Uint8Array(await Bun.file(s.manager.path(id)).arrayBuffer()),
    ).toEqual(exported);
    expect(s.host.stats().rawRequests).toBe(0);
  } finally {
    await s.close();
  }
}, 30000);

import type { ServerWebSocket } from "bun";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { generateSecretKey, getPublicKey, type Event } from "nostr-tools/pure";
import { toHex, fromHex } from "@hashtree/core";
import { buildTreeIndex, IndexedTree } from "../../packages/hashtree/src/build";
import {
  mapAnnouncement,
  publishAnnouncement,
} from "../../packages/hashtree/src/discovery";
import { parseCatalog, type MapOffer } from "../../packages/format/src/catalog";
import type { AdminAccess } from "./admin-access";
export type DiscoveryPeer = ServerWebSocket<{
  subscriptions: Map<string, Record<string, unknown>[]>;
}>;
interface Publication {
  id: string;
  state: "indexing" | "ready" | "failed";
  completed: number;
  bytes: number;
  message: string;
  event?: Event;
  offer?: MapOffer;
}
/** This host's read-only Nostr relay. It never accepts or forwards third-party events. */
export class MapDiscovery {
  readonly jobs = new Map<string, Publication>();
  private indexes = new Map<string, IndexedTree>();
  private peers = new Set<DiscoveryPeer>();
  private pending?: Promise<void>;
  private abort = new AbortController();
  private constructor(
    readonly directory: string,
    private key: Uint8Array,
    private access: AdminAccess,
    private maps: () => Array<{ id: string; path: string; offer: MapOffer }>,
  ) {}
  get pubkey() {
    return getPublicKey(this.key);
  }
  static async open(
    directory: string,
    access: AdminAccess,
    maps: () => Array<{ id: string; path: string; offer: MapOffer }>,
  ) {
    await mkdir(directory, { recursive: true });
    const keyPath = join(directory, "host-key");
    let key: Uint8Array;
    try {
      key = fromHex((await readFile(keyPath, "utf8")).trim());
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      key = generateSecretKey();
      await writeFile(keyPath, toHex(key), { flag: "wx", mode: 0o600 });
    }
    const d = new MapDiscovery(directory, key, access, maps);
    for (const name of await readdir(directory)) {
      if (!/^(demo|[a-f0-9-]{36})\.json$/.test(name)) continue;
      try {
        const job = JSON.parse(
          await readFile(join(directory, name), "utf8"),
        ) as Publication;
        if (job.state === "ready" && job.offer) {
          const m = maps().find((m) => m.id === job.id);
          if (!m || m.offer.manifest.snapshot !== job.offer.manifest.snapshot)
            continue;
          const index = IndexedTree.open(join(directory, `${job.id}.sqlite`));
          try {
            await index.assertUnchanged();
          } catch (e) {
            index.close();
            throw e;
          }
          d.indexes.set(index.info.root, index);
          job.event = mapAnnouncement(job.offer, key);
        } else {
          job.state = "failed";
          job.message = "Indexing interrupted. Publish again to restart.";
        }
        d.jobs.set(job.id, job);
      } catch {
        /* Missing or changed files must be republished. */
      }
    }
    return d;
  }
  offer(id: string) {
    return this.jobs.get(id)?.state === "ready"
      ? this.jobs.get(id)!.offer?.hashtree
      : undefined;
  }
  private async save(job: Publication) {
    const path = join(this.directory, `${job.id}.json`);
    await writeFile(path + ".tmp", JSON.stringify(job));
    await rename(path + ".tmp", path);
  }
  async publish(id: string, origin: string) {
    if (this.pending)
      throw new Error("Another Hashtree publication is running");
    const m = this.maps().find((m) => m.id === id);
    if (!m) throw new Error("Map not found");
    const job: Publication = {
      id,
      state: "indexing",
      completed: 0,
      bytes: m.offer.bytes,
      message: "Indexing map bytes…",
    };
    this.jobs.set(id, job);
    await this.save(job);
    this.pending = (async () => {
      try {
        const path = join(this.directory, `${id}.sqlite`);
        const info = await buildTreeIndex(m.path, path, {
          signal: this.abort.signal,
          progress: (bytes) => {
            job.completed = bytes;
          },
        });
        const index = IndexedTree.open(path);
        this.indexes.get(info.root)?.close();
        this.indexes.set(info.root, index);
        const offer = parseCatalog(
          {
            maps: [
              {
                ...m.offer,
                hashtree: {
                  version: 1,
                  root: info.root,
                  bytes: info.bytes,
                  chunkBytes: info.chunkBytes,
                  providers: [`${origin}/hashtree/${info.root}`],
                },
              },
            ],
          },
          origin,
        )[0]!;
        job.offer = offer;
        job.event = mapAnnouncement(offer, this.key);
        job.state = "ready";
        job.message =
          "Published to this host’s Nostr relay. Atlas file remains independently downloadable.";
        await this.save(job);
        this.broadcast(job.event);
        for (const relay of (process.env.ATLAS_DISCOVERY_RELAYS ?? "")
          .split(",")
          .filter(Boolean)) {
          try {
            await publishAnnouncement(relay.trim(), job.event);
          } catch (e) {
            job.message += ` Relay publication failed: ${String(e)}`;
          }
        }
        await this.save(job);
      } catch (e) {
        job.state = "failed";
        job.message = String(e);
        await this.save(job);
      }
    })().finally(() => {
      this.pending = undefined;
    });
    return job;
  }
  async settled() {
    await this.pending;
  }
  async remove(id: string) {
    // A publication may be reading this file; settle it before closing/removing indexes.
    if (this.jobs.get(id)?.state === "indexing") await this.pending;
    const root = this.jobs.get(id)?.offer?.hashtree?.root;
    this.jobs.delete(id);
    if (
      root &&
      ![...this.jobs.values()].some((j) => j.offer?.hashtree?.root === root)
    ) {
      this.indexes.get(root)?.close();
      this.indexes.delete(root);
    }
    await rm(join(this.directory, `${id}.json`), { force: true });
    await rm(join(this.directory, `${id}.sqlite`), { force: true });
  }
  async handle(request: Request, peer?: string): Promise<Response | undefined> {
    const u = new URL(request.url);
    if (u.pathname === "/discovery")
      return Response.json({
        pubkey: this.pubkey,
        relay: `${u.protocol === "https:" ? "wss:" : "ws:"}//${u.host}/nostr`,
        profile: "atlas-map-v1",
        publications: [...this.jobs.values()]
          .filter((j) => j.state === "ready")
          .map((j) => j.event),
      });
    const blob = u.pathname.match(
      /^\/hashtree\/([a-f0-9]{64})\/([a-f0-9]{64})$/,
    );
    if (blob) {
      if (!["GET", "HEAD"].includes(request.method))
        return new Response(null, { status: 405 });
      const tree = this.indexes.get(blob[1]!);
      if (!tree) return new Response(null, { status: 404 });
      try {
        const bytes = await tree.get(blob[2]!);
        if (!bytes) return new Response(null, { status: 404 });
        return new Response(
          request.method === "HEAD" ? null : new Uint8Array(bytes),
          {
            headers: {
              "Content-Type": "application/octet-stream",
              "Content-Length": String(bytes.length),
              "Cache-Control": "public, max-age=31536000, immutable",
              ETag: `"${blob[2]}"`,
            },
          },
        );
      } catch {
        return new Response("Indexed map unavailable; republish it", {
          status: 503,
        });
      }
    }
    if (!u.pathname.startsWith("/admin/discovery")) return;
    if (!this.access(request, peer))
      return Response.json({ error: "Administration denied" }, { status: 403 });
    if (request.method === "GET")
      return Response.json({
        pubkey: this.pubkey,
        jobs: [...this.jobs.values()],
      });
    if (
      request.method !== "POST" ||
      request.headers.get("Origin") !== u.origin ||
      request.headers.get("Content-Type") !== "application/json"
    )
      return Response.json(
        { error: "Same-origin JSON request required" },
        { status: 403 },
      );
    try {
      const { id } = await request.json();
      return Response.json(
        await this.publish(id, process.env.ATLAS_PUBLIC_URL ?? u.origin),
        { status: 202 },
      );
    } catch (e) {
      return Response.json({ error: String(e) }, { status: 400 });
    }
  }
  private matches(e: Event, f: Record<string, unknown>) {
    return (
      (!f.ids || (Array.isArray(f.ids) && f.ids.includes(e.id))) &&
      (f.since === undefined ||
        (typeof f.since === "number" && e.created_at >= f.since)) &&
      (f.until === undefined ||
        (typeof f.until === "number" && e.created_at <= f.until)) &&
      (!f.kinds || (Array.isArray(f.kinds) && f.kinds.includes(e.kind))) &&
      (!f.authors ||
        (Array.isArray(f.authors) && f.authors.includes(e.pubkey))) &&
      Object.entries(f)
        .filter(([k]) => k.startsWith("#"))
        .every(
          ([k, v]) =>
            Array.isArray(v) &&
            e.tags.some((t) => t[0] === k.slice(1) && v.includes(t[1])),
        )
    );
  }
  private send(
    ws: DiscoveryPeer,
    sub: string,
    filters: Record<string, unknown>[],
    e: Event,
  ) {
    if (filters.some((f) => this.matches(e, f)))
      ws.send(JSON.stringify(["EVENT", sub, e]));
  }
  private broadcast(e: Event) {
    for (const ws of this.peers)
      for (const [sub, filters] of ws.data.subscriptions)
        this.send(ws, sub, filters, e);
  }
  readonly websocket = {
    maxPayloadLength: 8192,
    idleTimeout: 120,
    sendPings: true,
    open: (ws: DiscoveryPeer) => {
      if (this.peers.size >= 128) {
        ws.close(1013, "Relay connection limit");
        return;
      }
      this.peers.add(ws);
    },
    close: (ws: DiscoveryPeer) => {
      this.peers.delete(ws);
    },
    message: (ws: DiscoveryPeer, raw: string | Buffer) => {
      try {
        const [type, sub, ...filters] = JSON.parse(String(raw));
        if (type === "EVENT") {
          ws.send(
            JSON.stringify([
              "OK",
              sub?.id ?? "",
              false,
              "restricted: read-only host relay",
            ]),
          );
          return;
        }
        if (typeof sub !== "string" || sub.length > 64) throw new Error();
        if (type === "CLOSE") {
          ws.data.subscriptions.delete(sub);
          return;
        }
        if (
          type !== "REQ" ||
          !filters.length ||
          filters.length > 8 ||
          (!ws.data.subscriptions.has(sub) &&
            ws.data.subscriptions.size >= 16) ||
          filters.some(
            (f: unknown) => !f || typeof f !== "object" || Array.isArray(f),
          )
        )
          throw new Error();
        ws.data.subscriptions.set(sub, filters);
        for (const job of this.jobs.values())
          if (job.state === "ready" && job.event)
            this.send(ws, sub, filters, job.event);
        ws.send(JSON.stringify(["EOSE", sub]));
      } catch {
        ws.send(JSON.stringify(["NOTICE", "Invalid request"]));
      }
    },
  };
  async close() {
    this.abort.abort();
    await this.pending;
    for (const p of this.peers) p.close();
    for (const i of this.indexes.values()) i.close();
  }
}

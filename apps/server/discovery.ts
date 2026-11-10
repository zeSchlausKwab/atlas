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
import {
  generateSecretKey,
  getPublicKey,
  finalizeEvent,
  type Event,
} from "nostr-tools/pure";
import { toHex, fromHex } from "@hashtree/core";
import { buildTreeIndex, IndexedTree } from "../../packages/hashtree/src/build";
import {
  mapAnnouncement,
  publishAnnouncement,
  MAP_KIND,
} from "../../packages/hashtree/src/discovery";
import { parseCatalog, type MapOffer } from "../../packages/format/src/catalog";
import { parseViewRecipe } from "../../packages/views/src/index";
import {
  viewAnnouncement,
  parseViewAnnouncement,
} from "../../packages/views/src/announcement";
import type { AdminAccess } from "./admin-access";
import type { FipsProvider } from "../../packages/hashtree/src/source";
export interface DiscoveryDelivery {
  origin: string;
  httpEnabled: boolean;
  fips: FipsProvider[];
  relays: string[];
}
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
  lastEventAt?: number;
  relayErrors?: string[];
  relayPending?: boolean;
}
interface RelayWork {
  key: string;
  event: Event;
  urls: string[];
  controller: AbortController;
  finish: (errors: string[]) => Promise<void>;
}
/** This host's read-only Nostr relay. It never accepts or forwards third-party events. */
export class MapDiscovery {
  readonly jobs = new Map<string, Publication>();
  readonly views = new Map<string, Event>();
  private viewRevisions = new Map<string, Event>();
  private defaultView?: string;
  private viewWrites: Promise<unknown> = Promise.resolve();
  private indexes = new Map<string, IndexedTree>();
  private peers = new Set<DiscoveryPeer>();
  private pending?: Promise<void>;
  private automatic?: ReturnType<typeof setInterval>;
  private automaticBusy = false;
  private delivery?: DiscoveryDelivery;
  private withdrawals = new Map<string, Event>();
  private lastRelayAttempt = 0;
  private announcementWrites: Promise<unknown> = Promise.resolve();
  private pendingWithdrawals = new Set<string>();
  private pendingViews = new Set<string>();
  private relayWork = new Map<string, RelayWork>();
  private relayActive = new Map<RelayWork, Promise<void>>();
  private updateAnnouncements<T>(work: () => Promise<T>): Promise<T> {
    const next = this.announcementWrites.then(work);
    this.announcementWrites = next.catch(() => {});
    return next;
  }
  private isLive(job: Publication) {
    const live = this.maps().find((m) => m.id === job.id);
    return (
      job.state === "ready" &&
      live &&
      live.offer.manifest.snapshot === job.offer?.manifest.snapshot
    );
  }
  /** Every data transport uses the same current served-map allow-list. */
  async getBlob(hash: string): Promise<Uint8Array | null> {
    if (!/^[a-f0-9]{64}$/.test(hash)) return null;
    const roots = new Set(
      [...this.jobs.values()]
        .filter((j) => this.isLive(j) && j.event)
        .map((j) => j.offer?.hashtree?.root)
        .filter((r): r is string => !!r),
    );
    for (const root of roots) {
      const index = this.indexes.get(root);
      if (!index) continue;
      const bytes = await index.get(hash);
      if (bytes) return bytes;
    }
    return null;
  }
  publishedOffers(): MapOffer[] {
    return [...this.jobs.values()]
      .filter((j) => this.isLive(j) && j.event && j.offer)
      .map((j) => j.offer!);
  }
  publishedMap(root: string) {
    return this.publishedOffers().find((m) => m.hashtree?.root === root);
  }
  get relayUrls() {
    return (
      this.delivery?.relays ??
      (process.env.ATLAS_DISCOVERY_RELAYS ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    );
  }
  async setDelivery(value: DiscoveryDelivery) {
    await this.updateAnnouncements(async () => {
      this.delivery = value;
      await this.refreshAnnouncementsNow(true);
    });
  }
  private timestamp(job?: Publication) {
    return Math.max(
      Math.floor(Date.now() / 1000),
      Math.max(
        job?.lastEventAt ?? job?.event?.created_at ?? 0,
        job ? (this.withdrawals.get(job.id)?.created_at ?? 0) : 0,
      ) + 1,
    );
  }
  /** Coalesce by address, cancel obsolete sends and keep network I/O off the mutation path. */
  private queueRelay(key: string, event: Event, finish: RelayWork["finish"]) {
    const previous = this.relayWork.get(key);
    if (
      previous?.event.id === event.id &&
      JSON.stringify(previous.urls) === JSON.stringify(this.relayUrls) &&
      !previous.controller.signal.aborted
    )
      return;
    previous?.controller.abort();
    const work: RelayWork = {
      key,
      event,
      urls: [...this.relayUrls],
      controller: new AbortController(),
      finish,
    };
    this.relayWork.set(key, work);
    queueMicrotask(() => this.pumpRelays());
  }
  private pumpRelays() {
    if (this.abort.signal.aborted) return;
    for (const work of this.relayWork.values()) {
      if (this.relayActive.size >= 4) break;
      if (this.relayActive.has(work)) continue;
      const run = (async () => {
        const errors: string[] = [];
        await Promise.all(
          work.urls.map(async (url) => {
            try {
              await this.publishRelay(
                url,
                work.event,
                10_000,
                work.controller.signal,
              );
            } catch (error) {
              if (!work.controller.signal.aborted)
                errors.push(`${url}: ${String(error)}`);
            }
          }),
        );
        // A newer offer or withdrawal supersedes this result; never persist stale status.
        if (
          this.relayWork.get(work.key) === work &&
          !work.controller.signal.aborted
        )
          await this.updateAnnouncements(async () => {
            if (
              this.relayWork.get(work.key) === work &&
              !work.controller.signal.aborted
            )
              await work.finish(errors);
          });
      })()
        .catch((error) => console.error("Discovery relay publication:", error))
        .finally(() => {
          this.relayActive.delete(work);
          if (this.relayWork.get(work.key) === work)
            this.relayWork.delete(work.key);
          this.pumpRelays();
        });
      this.relayActive.set(work, run);
    }
  }
  private announceMap(job: Publication) {
    const event = job.event!;
    job.relayPending = this.relayUrls.length > 0;
    job.relayErrors = [];
    job.message = job.relayPending
      ? "Published locally; sending signed discovery announcements…"
      : "Published locally; no external discovery relays configured.";
    this.queueRelay(`map:${job.id}`, event, async (errors) => {
      if (this.jobs.get(job.id) !== job || job.event?.id !== event.id) return;
      job.relayPending = false;
      job.relayErrors = errors;
      job.message = errors.length
        ? "Published locally; discovery relay delivery will retry."
        : "Published with the current delivery settings.";
      await this.save(job);
    });
  }
  private announceWithdrawal(id: string, event: Event) {
    this.pendingWithdrawals.add(id);
    this.queueRelay(`map:${id}`, event, async (errors) => {
      if (this.withdrawals.get(id)?.id !== event.id) return;
      if (!errors.length) this.pendingWithdrawals.delete(id);
      const job = this.jobs.get(id);
      if (job && !job.event) {
        job.relayPending = false;
        job.relayErrors = errors;
        await this.save(job);
      }
    });
  }
  private announceView(event: Event) {
    const id = parseViewAnnouncement(event).recipe.id;
    this.pendingViews.add(id);
    this.queueRelay(`view:${id}`, event, async (errors) => {
      if (this.views.get(id)?.id !== event.id) return;
      if (!errors.length) this.pendingViews.delete(id);
    });
  }
  private offerFor(job: Publication, origin: string): MapOffer | undefined {
    const live = this.maps().find((m) => m.id === job.id);
    const tree = job.offer?.hashtree;
    if (!live || !tree) return;
    const delivery = this.delivery ?? {
      origin,
      httpEnabled: true,
      fips: [],
      relays: this.relayUrls,
    };
    if (!delivery.httpEnabled && !delivery.fips.length) return;
    return parseCatalog(
      {
        maps: [
          {
            ...live.offer,
            url: delivery.fips.length ? `htree://${tree.root}` : live.offer.url,
            api: delivery.httpEnabled ? live.offer.api : undefined,
            hashtree: {
              ...tree,
              providers: delivery.httpEnabled
                ? [
                    `${delivery.origin.replace(/\/$/, "")}/hashtree/${tree.root}`,
                  ]
                : [],
              ...(delivery.fips.length
                ? { fips: delivery.fips }
                : { fips: undefined }),
            },
          },
        ],
      },
      delivery.origin,
    )[0];
  }
  private async saveWithdrawals() {
    const path = join(this.directory, "withdrawals.json");
    await writeFile(
      path + ".tmp",
      JSON.stringify([...this.withdrawals.values()].slice(-1000)),
    );
    await rename(path + ".tmp", path);
  }
  private async withdraw(job: Publication) {
    if (!job.event) return;
    const event = finalizeEvent(
      {
        kind: 5,
        created_at: this.timestamp(job),
        tags: [
          ["e", job.event.id],
          ["a", `${MAP_KIND}:${this.pubkey}:atlas/${job.id}`],
        ],
        content: "Map is no longer offered by this host",
      },
      this.key,
    );
    job.lastEventAt = event.created_at;
    job.event = undefined;
    this.withdrawals.set(job.id, event);
    await this.saveWithdrawals();
    this.broadcast(event);
    job.relayPending = this.relayUrls.length > 0;
    this.announceWithdrawal(job.id, event);
  }
  /** Renew offers before their seven-day expiry, and retry failed relay delivery. */
  async refreshAnnouncements(force = false) {
    await this.updateAnnouncements(() => this.refreshAnnouncementsNow(force));
  }
  private async refreshAnnouncementsNow(force = false) {
    const now = Math.floor(Date.now() / 1000);
    const retry = Date.now() - this.lastRelayAttempt > 60_000;
    if (retry) this.lastRelayAttempt = Date.now();
    for (const job of this.jobs.values()) {
      if (!this.isLive(job)) {
        if (job.state === "ready" && job.event) {
          await this.withdraw(job);
          await this.save(job);
        }
        continue;
      }
      const offer = this.offerFor(job, this.delivery?.origin ?? job.offer!.url);
      if (!offer) {
        await this.withdraw(job);
        await this.save(job);
        continue;
      }
      if (force || !job.event || now - job.event.created_at >= 86400) {
        job.offer = offer;
        job.event = mapAnnouncement(offer, this.key, this.timestamp(job));
        job.lastEventAt = job.event.created_at;
        this.withdrawals.delete(job.id);
        this.pendingWithdrawals.delete(job.id);
        await this.saveWithdrawals();
        this.broadcast(job.event);
        this.announceMap(job);
        await this.save(job);
      } else if (retry && job.relayErrors?.length) {
        this.announceMap(job);
        await this.save(job);
      }
    }
    if (force) {
      await this.saveWithdrawals();
      for (const event of this.views.values()) this.announceView(event);
    }
    if (retry && !force)
      for (const id of this.pendingViews) {
        const event = this.views.get(id);
        if (event) this.announceView(event);
      }
    if (force || retry) {
      for (const [id, event] of this.withdrawals) {
        if (!force && !this.pendingWithdrawals.has(id)) continue;
        this.announceWithdrawal(id, event);
      }
    }
  }
  /** Publish finished served files serially; no second copy of the archive is made. */
  startAutomatic(origin: string) {
    clearInterval(this.automatic);
    const tick = async () => {
      if (this.automaticBusy || this.pending || this.abort.signal.aborted)
        return;
      this.automaticBusy = true;
      try {
        const next = this.maps().find(
          (m) =>
            m.offer.manifest.capabilities.length > 0 && !this.jobs.has(m.id),
        );
        if (next) {
          await this.publish(next.id, origin);
          await this.settled();
        }
        await this.refreshAnnouncements();
      } catch (error) {
        console.error("Hashtree publication:", error);
      } finally {
        this.automaticBusy = false;
      }
    };
    this.automatic = setInterval(() => void tick(), 5000);
    this.automatic.unref();
    void tick();
  }
  private abort = new AbortController();
  private constructor(
    readonly directory: string,
    private key: Uint8Array,
    private access: AdminAccess,
    private maps: () => Array<{ id: string; path: string; offer: MapOffer }>,
    private publishRelay: typeof publishAnnouncement,
  ) {}
  get pubkey() {
    return getPublicKey(this.key);
  }
  static async open(
    directory: string,
    access: AdminAccess,
    maps: () => Array<{ id: string; path: string; offer: MapOffer }>,
    options: { publishRelay?: typeof publishAnnouncement } = {},
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
    const d = new MapDiscovery(
      directory,
      key,
      access,
      maps,
      options.publishRelay ?? publishAnnouncement,
    );
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
          // A stopped host can have a valid index without a publishable offer.
          // The delivery controller republishes it after loading settings.
          if (job.event) {
            job.event = mapAnnouncement(
              job.offer,
              key,
              Math.max(
                Math.floor(Date.now() / 1000),
                (job.lastEventAt ?? job.event.created_at) + 1,
              ),
            );
            job.lastEventAt = job.event.created_at;
          }
        } else {
          job.state = "failed";
          job.message = "Indexing interrupted. Publish again to restart.";
        }
        d.jobs.set(job.id, job);
      } catch {
        /* Missing or changed files must be republished. */
      }
    }
    try {
      const saved = JSON.parse(
        await readFile(join(directory, "views.json"), "utf8"),
      );
      for (const event of saved.revisions ?? []) {
        const parsed = parseViewAnnouncement(event, d.pubkey);
        d.viewRevisions.set(parsed.event.id, parsed.event);
      }
      for (const id of saved.current ?? []) {
        const event = d.viewRevisions.get(id);
        if (event) d.views.set(parseViewAnnouncement(event).recipe.id, event);
      }
      if (d.views.has(saved.defaultView)) d.defaultView = saved.defaultView;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        console.error("Saved views unavailable:", error);
    }
    try {
      for (const event of JSON.parse(
        await readFile(join(directory, "withdrawals.json"), "utf8"),
      )) {
        const id = event.tags
          ?.find((t: string[]) => t[0] === "a")?.[1]
          ?.split(":atlas/")[1];
        if (id && event.pubkey === d.pubkey && event.kind === 5) {
          d.withdrawals.set(id, event);
          d.pendingWithdrawals.add(id);
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        console.error("Saved withdrawals unavailable:", error);
    }
    if (d.defaultView) {
      const event = d.views.get(d.defaultView)!;
      if (!event.tags.some((t) => t[0] === "default" && t[1] === "true"))
        await d
          .publishView(parseViewAnnouncement(event).recipe, true, false)
          .catch((error) =>
            console.error("Default view migration deferred:", error),
          );
    }
    return d;
  }
  private viewCatalog() {
    return {
      pubkey: this.pubkey,
      defaultView: this.defaultView,
      views: [...this.views.values()],
    };
  }
  private async publishView(
    value: unknown,
    makeDefault: boolean,
    publish = true,
  ) {
    const recipe = parseViewRecipe(value);
    for (const source of recipe.sources) {
      const offer = [...this.jobs.values()].find(
        (j) => this.isLive(j) && j.offer?.hashtree?.root === source.root,
      )?.offer;
      if (!offer)
        throw new Error(
          "Every view source must be published on this host at the pinned revision",
        );
      if (source.layers.some((l) => !offer.manifest.tileLayers?.includes(l)))
        throw new Error(
          "View requests a geometry layer missing from its source",
        );
    }
    if (!this.views.has(recipe.id) && this.views.size >= 100)
      throw new Error("At most 100 published views per host");
    const previous = this.views.get(recipe.id);
    const basic = viewAnnouncement(
      recipe,
      this.key,
      Math.max(Math.floor(Date.now() / 1000), (previous?.created_at ?? 0) + 1),
    );
    const event = makeDefault
      ? finalizeEvent(
          {
            kind: basic.kind,
            created_at: basic.created_at,
            tags: [...basic.tags, ["default", "true"]],
            content: basic.content,
          },
          this.key,
        )
      : basic;
    const views = new Map(this.views).set(recipe.id, event);
    const revisions = new Map(this.viewRevisions).set(event.id, event);
    const defaultView = makeDefault
      ? recipe.id
      : this.defaultView === recipe.id
        ? undefined
        : this.defaultView;
    let replacedDefault: Event | undefined;
    if (makeDefault && this.defaultView && this.defaultView !== recipe.id) {
      const old = this.views.get(this.defaultView);
      if (old) {
        replacedDefault = finalizeEvent(
          {
            kind: old.kind,
            created_at: Math.max(
              Math.floor(Date.now() / 1000),
              old.created_at + 1,
            ),
            tags: old.tags.filter((t) => t[0] !== "default"),
            content: old.content,
          },
          this.key,
        );
        views.set(this.defaultView, replacedDefault);
        revisions.set(replacedDefault.id, replacedDefault);
      }
    }
    const path = join(this.directory, "views.json");
    await writeFile(
      path + ".tmp",
      JSON.stringify({
        defaultView,
        current: [...views.values()].map((e) => e.id),
        revisions: [...revisions.values()],
      }),
    );
    await rename(path + ".tmp", path);
    this.views.clear();
    for (const [id, value] of views) this.views.set(id, value);
    this.viewRevisions = revisions;
    this.defaultView = defaultView;
    if (replacedDefault) {
      this.broadcast(replacedDefault);
      if (publish) this.announceView(replacedDefault);
    }
    this.broadcast(event);
    if (publish) this.announceView(event);
    return event;
  }
  offer(id: string) {
    const job = this.jobs.get(id);
    return job && this.isLive(job) && job.event
      ? job.offer?.hashtree
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
    this.pending = (async () => {
      try {
        await this.save(job);
        const path = join(this.directory, `${id}.sqlite`);
        const info = await buildTreeIndex(m.path, path, {
          signal: this.abort.signal,
          progress: (bytes) => {
            job.completed = bytes;
          },
        });
        await this.updateAnnouncements(async () => {
          const index = IndexedTree.open(path);
          this.indexes.get(info.root)?.close();
          this.indexes.set(info.root, index);
          job.offer = {
            ...m.offer,
            hashtree: {
              version: 1,
              root: info.root,
              bytes: info.bytes,
              chunkBytes: info.chunkBytes,
              providers: [],
            },
          };
          job.state = "ready";
          const offer = this.offerFor(job, origin);
          if (offer) {
            job.offer = offer;
            job.event = mapAnnouncement(offer, this.key, this.timestamp(job));
            job.lastEventAt = job.event.created_at;
            this.withdrawals.delete(job.id);
            await this.saveWithdrawals();
            this.broadcast(job.event);
            this.announceMap(job);
          } else
            job.message = "Indexed; enable a delivery transport to publish.";
          await this.save(job);
        });
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
    await this.updateAnnouncements(async () => {
      const root = this.jobs.get(id)?.offer?.hashtree?.root;
      const removed = this.jobs.get(id);
      if (removed) await this.withdraw(removed);
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
    });
  }
  async handle(request: Request, peer?: string): Promise<Response | undefined> {
    const u = new URL(request.url);
    if (u.pathname === "/discovery")
      return Response.json({
        relay: `${u.protocol === "https:" ? "wss:" : "ws:"}//${u.host}/nostr`,
        profile: "atlas-map-v1",
        relays: this.relayUrls,
        ...this.viewCatalog(),
        publications: [...this.jobs.values()]
          .filter((j) => this.isLive(j) && j.event)
          .map((j) => j.event),
      });
    if (u.pathname === "/views" && request.method === "GET")
      return Response.json(this.viewCatalog());
    const revision = u.pathname.match(/^\/views\/([a-f0-9]{64})$/);
    if (revision && request.method === "GET") {
      const event = this.viewRevisions.get(revision[1]!);
      return event
        ? Response.json(event, {
            headers: { "Cache-Control": "public, max-age=31536000, immutable" },
          })
        : new Response(null, { status: 404 });
    }
    if (u.pathname === "/admin/views") {
      if (!this.access(request, peer))
        return Response.json(
          { error: "Administration denied" },
          { status: 403 },
        );
      if (request.method === "GET")
        return Response.json({
          ...this.viewCatalog(),
          maps: [...this.jobs.values()]
            .filter((j) => this.isLive(j) && j.event)
            .map((j) => j.offer),
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
        const raw = await request.text();
        if (raw.length > 160 * 1024)
          throw new Error("View recipe is too large");
        const body = JSON.parse(raw);
        const write = this.viewWrites.then(() =>
          this.publishView(body.recipe, body.makeDefault === true),
        );
        this.viewWrites = write.catch(() => {});
        return Response.json({ event: await write }, { status: 201 });
      } catch (error) {
        return Response.json({ error: String(error) }, { status: 400 });
      }
    }
    const blob = u.pathname.match(
      /^\/hashtree\/([a-f0-9]{64})\/([a-f0-9]{64})$/,
    );
    if (blob) {
      if (!["GET", "HEAD"].includes(request.method))
        return new Response(null, { status: 405 });
      if (this.delivery && !this.delivery.httpEnabled)
        return new Response(
          "HTTP map delivery is disabled; use the advertised FIPS providers",
          { status: 403 },
        );
      const tree = this.publishedMap(blob[1]!)
        ? this.indexes.get(blob[1]!)
        : undefined;
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
          if (this.isLive(job) && job.event)
            this.send(ws, sub, filters, job.event);
        for (const event of this.views.values())
          this.send(ws, sub, filters, event);
        for (const event of this.withdrawals.values())
          this.send(ws, sub, filters, event);
        ws.send(JSON.stringify(["EOSE", sub]));
      } catch {
        ws.send(JSON.stringify(["NOTICE", "Invalid request"]));
      }
    },
  };
  async close() {
    clearInterval(this.automatic);
    this.abort.abort();
    for (const work of this.relayWork.values()) work.controller.abort();
    this.relayWork.clear();
    await Promise.allSettled(this.relayActive.values());
    await this.pending;
    await this.viewWrites;
    await this.announcementWrites;
    for (const p of this.peers) p.close();
    for (const i of this.indexes.values()) i.close();
  }
}

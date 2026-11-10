import { Acquisitions, type AcquisitionPin } from "./acquisitions";
import { StorageWarning } from "../../packages/provisioning/src/capacity";
import { mkdir, rename, readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  parseAnnouncement,
  relayUrl,
  watchMaps,
} from "../../packages/hashtree/src/discovery";
import {
  getFipsClient,
  FIPS_REQUEST_TIMEOUT_MS,
} from "../../packages/fips/src/client";
import { HashtreeSource } from "../../packages/hashtree/src/source";
import { verifyPublishedMap } from "../../packages/hashtree/src/published-map";
import { AtlasReader, FileSource } from "../../packages/format/src/reader";
import { openMembers } from "../../packages/format/src/composition";
import type { MapOffer } from "../../packages/format/src/catalog";
import { httpUrl } from "../../packages/format/src/urls";
import {
  coverageFamilies,
  planCoverage,
  type CoverageSource,
  type CoverageRequest,
} from "../../packages/coverage/src/index";
import { inspectRouting } from "../../packages/coverage/src/routing-inspection";
import {
  TRANSPORT_MODES,
  type TransportMode,
} from "../../packages/format/src/index";
import { limitedBody } from "./request-body";
import { ADMIN_DENIED, type AdminAccess } from "./admin-access";
import type { ArchiveUploads, ArchiveUpload } from "./archive-uploads";
interface Peer {
  url: string;
  pubkey: string;
  error?: string;
}
interface Mirror {
  id: string;
  offer: MapOffer;
  publisher: string;
  state: "paused" | "downloading" | "queued-import" | "failed";
  offset: number;
  error?: string;
  jobId?: string;
}
type Entry = AcquisitionPin;
const json = (data: unknown, status = 200) =>
  Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
/** An operator-selected consumer. It reads signed offers and verified Hashtree bytes;
 * it does not accept unsigned catalogs or change the publisher's archived data. */
export class Federation {
  private peers: Peer[] = [];
  private acquisitions!: Acquisitions;
  private entries = new Map<string, Entry>();
  private readers = new Map<string, AtlasReader>();
  private mirrors = new Map<string, Mirror>();
  private work?: Promise<void>;
  private download?: {
    id: string;
    abort: AbortController;
    done: Promise<void>;
  };
  private closing = false;
  private lifetime = new AbortController();
  private inspecting = false;
  private mirrorStarting = false;
  status = "Refresh to inspect the local library and saved publishers.";
  private constructor(
    readonly directory: string,
    private access: AdminAccess,
    private local: () => Array<{ id: string; path: string; offer: MapOffer }>,
    private uploads: ArchiveUploads,
  ) {}
  static async open(
    directory: string,
    access: AdminAccess,
    local: () => Array<{ id: string; path: string; offer: MapOffer }>,
    uploads: ArchiveUploads,
  ) {
    await mkdir(directory, { recursive: true });
    const f = new Federation(directory, access, local, uploads);
    if (await Bun.file(join(directory, "peers.json")).exists())
      f.peers = await Bun.file(join(directory, "peers.json")).json();
    for (const name of await readdir(directory))
      if (/^mirror-[a-f0-9-]{36}\.json$/.test(name)) {
        const m: Mirror = await Bun.file(join(directory, name)).json();
        if (m.state === "downloading") m.state = "paused";
        f.mirrors.set(m.id, m);
      }
    f.acquisitions = await Acquisitions.open(
      join(directory, "areas"),
      (id, path, name, force) => uploads.importPrepared(id, path, name, force),
    );
    return f;
  }
  private async save(name: string, value: unknown) {
    const p = join(this.directory, name);
    await Bun.write(p + ".tmp", JSON.stringify(value));
    await rename(p + ".tmp", p);
  }
  private async announcements(url: string, pubkey?: string) {
    const signal = AbortSignal.any([
      this.lifetime.signal,
      AbortSignal.timeout(15000),
    ]);
    if (/^wss?:/.test(url)) {
      if (!pubkey || !/^[a-f0-9]{64}$/.test(pubkey))
        throw Error(
          "A relay requires the publisher's 64-character public key.",
        );
      const events = new Map<string, unknown>();
      const ready = Promise.withResolvers<void>();
      // A timeout can fire while the WebSocket connection is still opening.
      void ready.promise.catch(() => {});
      const aborted = () => ready.reject(signal.reason);
      signal.addEventListener("abort", aborted, { once: true });
      let close: (() => void) | undefined;
      try {
        signal.throwIfAborted();
        close = await watchMaps(
          url,
          [pubkey],
          (offer, event) => events.set(offer.id, event),
          signal,
          undefined,
          undefined,
          {
            ready: () => ready.resolve(),
            withdrawn: (id) => events.delete(id),
          },
        );
        await ready.promise;
        return { pubkey, publications: [...events.values()] };
      } finally {
        signal.removeEventListener("abort", aborted);
        close?.();
      }
    }
    const r = await fetch(new URL("/discovery", url), {
      signal,
      redirect: "error",
      credentials: "omit",
    });
    if (!r.ok) throw Error(`Discovery HTTP ${r.status}`);
    const data = JSON.parse(
      new TextDecoder().decode(
        await limitedBody(
          new Request(url, { method: "POST", body: r.body }),
          8 * 1024 ** 2,
        ),
      ),
    );
    if (
      !/^[a-f0-9]{64}$/.test(data.pubkey) ||
      !Array.isArray(data.publications) ||
      data.publications.length > 100
    )
      throw Error(
        "Invalid discovery response (up to 100 publications per host)",
      );
    return data as { pubkey: string; publications: unknown[] };
  }
  async addPeer(value: string, publisher?: string) {
    if (this.work || this.inspecting)
      throw Error("Wait for the current inspection or refresh to finish.");
    this.lifetime.signal.throwIfAborted();
    const isRelay = /^wss?:/.test(value);
    const url = isRelay ? relayUrl(value) : new URL(httpUrl(value)).origin;
    const identity = await this.announcements(url, publisher),
      existing = this.peers.find(
        (p) => p.url === url && (!isRelay || p.pubkey === publisher),
      );
    if (publisher && publisher !== identity.pubkey)
      throw Error(
        "The discovered publisher does not match the supplied public key.",
      );
    if (existing && existing.pubkey !== identity.pubkey)
      throw Error(
        "Publisher key changed. Remove and explicitly add this host again to trust its new key.",
      );
    if (!existing) {
      if (this.peers.length >= 16)
        throw Error("Up to 16 trusted hosts per demo inspector");
      this.peers.push({ url, pubkey: identity.pubkey });
      await this.save("peers.json", this.peers);
    }
    this.refresh();
  }
  refresh() {
    if (this.inspecting)
      throw Error("Wait for the routing inspection to finish.");
    if (this.work || this.closing) return;
    this.work = this.refreshSources()
      .catch((e) => {
        this.status = String(e);
      })
      .finally(() => {
        this.work = undefined;
      });
  }
  async settled() {
    await this.work;
  }
  private async retain(entry: Entry, reader: AtlasReader) {
    // A portable composition is inspected through its real members, never its envelope.
    const members = await openMembers(reader);
    this.readers.set(entry.id, reader);
    if (!members.length) {
      this.entries.set(entry.id, entry);
      return;
    }
    for (const member of members) {
      const id = entry.id + "/" + member.id;
      this.entries.set(id, {
        ...entry,
        id,
        memberId: member.id,
        manifest: member.manifest,
      });
      this.readers.set(id, member.reader);
    }
  }
  private async refreshSources() {
    const old = [...this.entries.values()];
    for (const r of this.readers.values()) r.dispose();
    this.readers.clear();
    this.entries.clear();
    for (const m of this.local()) {
      if (this.closing) return;
      const entry: Entry = {
        id: `local:${m.id}`,
        path: m.path,
        manifest: m.offer.manifest,
        location: "local",
        verified: false,
        bytes: m.offer.bytes,
      };
      const r = new AtlasReader(new FileSource(Bun.file(m.path)), undefined, {
        directoryBudget: 1024 ** 2,
      });
      try {
        await r.open();
        if (r.index.manifest.snapshot !== m.offer.manifest.snapshot)
          throw Error("Local archive snapshot changed");
        entry.manifest = r.index.manifest;
        entry.verified = true;
        await this.retain(entry, r);
      } catch (e) {
        r.dispose();
        entry.verified = false;
        entry.error = String(e);
        this.entries.set(entry.id, entry);
      }
    }
    for (const peer of this.peers) {
      if (this.closing) return;
      this.status = `Reading signed offers from ${peer.url}…`;
      try {
        const data = await this.announcements(peer.url, peer.pubkey);
        if (data.pubkey !== peer.pubkey)
          throw Error("Pinned publisher key changed");
        const offers = new Map<string, ReturnType<typeof parseAnnouncement>>();
        for (const raw of data.publications) {
          const parsed = parseAnnouncement(raw);
          if (parsed.event.pubkey !== peer.pubkey)
            throw Error("Unexpected publisher signature");
          const old = offers.get(parsed.offer.id);
          if (
            !old ||
            parsed.event.created_at > old.event.created_at ||
            (parsed.event.created_at === old.event.created_at &&
              parsed.event.id < old.event.id)
          )
            offers.set(parsed.offer.id, parsed);
        }
        for (const { offer } of offers.values()) {
          if (this.closing) return;
          const id = `${peer.pubkey}:${offer.id}`;
          if (this.entries.has(id)) continue;
          this.status = `Verifying ${offer.manifest.name} through Hashtree…`;
          const entry: Entry = {
            id,
            offer,
            manifest: offer.manifest,
            location: "remote",
            verified: false,
            bytes: offer.bytes,
            root: offer.hashtree!.root,
            publisher: peer.pubkey,
          };
          const reader = new AtlasReader(
            new HashtreeSource(offer.url, offer.hashtree!, offer.api, {
              memoryBytes: 512 * 1024,
              requestTimeoutMs: offer.hashtree!.fips?.length
                ? FIPS_REQUEST_TIMEOUT_MS
                : undefined,
              fetchFipsBlob: (hash, providers, signal) =>
                getFipsClient().fetchBlob(hash, providers, signal),
            }),
            undefined,
            { directoryBudget: 1024 ** 2 },
          );
          const dispose = () => reader.dispose();
          this.lifetime.signal.addEventListener("abort", dispose, {
            once: true,
          });
          const timer = setTimeout(
            dispose,
            offer.hashtree!.fips?.length ? FIPS_REQUEST_TIMEOUT_MS : 30000,
          );
          try {
            this.lifetime.signal.throwIfAborted();
            await reader.open();
            entry.manifest = verifyPublishedMap(offer, reader);
            entry.verified = true;
            await this.retain(entry, reader);
          } catch (e) {
            reader.dispose();
            entry.verified = false;
            entry.error = String(e);
            this.entries.set(id, entry);
          } finally {
            clearTimeout(timer);
            this.lifetime.signal.removeEventListener("abort", dispose);
          }
        }
        delete peer.error;
      } catch (e) {
        peer.error = String(e);
        for (const entry of old.filter((e) => e.publisher === peer.pubkey))
          if (!this.entries.has(entry.id))
            this.entries.set(entry.id, {
              ...entry,
              verified: false,
              error: peer.error,
            });
      }
    }
    this.status = `Checked ${this.entries.size} map sources. Coverage is archive scope; detailed cell checks are separate.`;
  }
  view() {
    return {
      peers: this.peers,
      sources: [...this.entries.values()].map(
        ({ offer, path, memberId, ...s }) => ({
          ...s,
          canMirror: !!offer && s.verified,
        }),
      ),
      families: [
        ...new Set(
          [...this.entries.values()].flatMap((s) =>
            coverageFamilies(s.manifest).map((f) => f.id),
          ),
        ),
      ].sort(),
      mirrors: [...this.mirrors.values()].map(({ offer, ...m }) => ({
        ...m,
        state: this.local().some((s) => s.id === m.jobId)
          ? ("ready" as const)
          : m.state,
        name: offer.manifest.name,
        bytes: offer.bytes,
        root: offer.hashtree!.root,
      })),
      acquisitions: this.acquisitions.view(),
      refreshing: !!this.work,
      status: this.status,
    };
  }
  plan(request: CoverageRequest) {
    if (this.work)
      throw Error("Wait for verification to finish before planning.");
    const selected = request.sourceIds;
    if (
      selected &&
      (!Array.isArray(selected) || selected.some((id) => !this.entries.has(id)))
    )
      throw Error("A selected source is no longer available");
    return planCoverage(
      request,
      [...this.entries.values()].filter(
        (e) => !selected || selected.includes(e.id),
      ),
    );
  }
  async inspect(request: CoverageRequest) {
    const plan = this.plan(request),
      mode = request.family.replace("routing:", "") as TransportMode;
    if (!TRANSPORT_MODES.includes(mode) || !plan.reference)
      throw Error("Choose routing and a verified reference map.");
    if (this.inspecting)
      throw Error("A routing inspection is already running.");
    this.inspecting = true;
    try {
      return await inspectRouting(
        request.polygon,
        mode,
        [...this.entries.values()]
          .filter((e) => !request.sourceIds || request.sourceIds.includes(e.id))
          .map((e) => {
            const reader = e.verified ? this.readers.get(e.id) : undefined;
            return reader
              ? { id: e.id, reader }
              : { id: e.id, manifest: e.manifest };
          }),
        plan.reference,
      );
    } finally {
      this.inspecting = false;
    }
  }
  private async upload(
    path: string,
    method = "GET",
    body?: BodyInit,
    contentType = "application/json",
  ) {
    return this.uploads.handle(
      new Request("http://127.0.0.1/admin/imports" + path, {
        method,
        headers: { Origin: "http://127.0.0.1", "Content-Type": contentType },
        body,
      }),
      "127.0.0.1",
    );
  }
  private async startMirror(
    id: string,
    allowStorageRisk = false,
  ): Promise<Response> {
    if (this.download)
      throw Error("A mirror download is already running. Pause it first.");
    const entry = this.entries.get(id);
    if (!entry?.verified || !entry.offer || !entry.publisher)
      throw Error("Refresh and choose a verified remote map.");
    const existing = [...this.mirrors.values()].find(
      (m) => m.offer.hashtree!.root === entry.root,
    );
    if (existing) {
      if (existing.state !== "queued-import") this.runMirror(existing);
      return json(existing, 202);
    }
    const response = await this.upload(
      "",
      "POST",
      JSON.stringify({
        filename: `mirror-${entry.root!.slice(0, 16)}.atlas`,
        size: entry.bytes,
        allowStorageRisk,
      }),
    );
    if (!response.ok) return response;
    const upload = (await response.json()) as ArchiveUpload;
    const mirror: Mirror = {
      id: upload.id,
      offer: entry.offer,
      publisher: entry.publisher,
      state: "paused",
      offset: 0,
    };
    this.mirrors.set(mirror.id, mirror);
    await this.save(`mirror-${mirror.id}.json`, mirror);
    this.runMirror(mirror);
    return json(mirror, 202);
  }
  private runMirror(m: Mirror) {
    if (this.download || this.closing)
      throw Error("A mirror is already running or the server is stopping.");
    const abort = new AbortController();
    const done = (async () => {
      m.state = "downloading";
      delete m.error;
      try {
        await this.save(`mirror-${m.id}.json`, m);
        const response = await this.upload(`/${m.id}`),
          upload = (await response.json()) as ArchiveUpload;
        if (!response.ok) throw Error("Mirror's saved upload is missing");
        if (upload.jobId) {
          m.jobId = upload.jobId;
          m.state = "queued-import";
          return;
        }
        m.offset = upload.offset;
        const source = new HashtreeSource(
          m.offer.url,
          m.offer.hashtree!,
          m.offer.api,
          {
            requestTimeoutMs: m.offer.hashtree!.fips?.length
              ? FIPS_REQUEST_TIMEOUT_MS
              : undefined,
            fetchFipsBlob: (hash, providers, signal) =>
              getFipsClient().fetchBlob(hash, providers, signal),
          },
        );
        while (m.offset < m.offer.bytes) {
          abort.signal.throwIfAborted();
          const bytes = await source.read(
            m.offset,
            Math.min(m.offer.bytes, m.offset + 4 * 1024 ** 2),
            abort.signal,
          );
          abort.signal.throwIfAborted();
          const r = await this.upload(
            `/${m.id}?offset=${m.offset}`,
            "PUT",
            new Uint8Array(bytes),
            "application/octet-stream",
          );
          const data = await r.json();
          if (!r.ok) throw Error(data.error);
          m.offset = data.offset;
          await this.save(`mirror-${m.id}.json`, m);
        }
        abort.signal.throwIfAborted();
        const r = await this.upload(`/${m.id}/finish`, "POST", "{}"),
          data = await r.json();
        if (!r.ok) throw Error(data.error);
        m.jobId = data.jobId;
        m.state = "queued-import";
      } catch (e) {
        m.state = abort.signal.aborted ? "paused" : "failed";
        m.error = abort.signal.aborted ? undefined : String(e);
      } finally {
        await this.save(`mirror-${m.id}.json`, m);
      }
    })()
      .catch((e) => {
        m.state = "failed";
        m.error = String(e);
      })
      .finally(() => {
        this.download = undefined;
      });
    this.download = { id: m.id, abort, done };
  }
  async handle(request: Request, peer?: string) {
    if (
      !this.access(request, peer) ||
      (request.method !== "GET" &&
        request.headers.get("Origin") !== new URL(request.url).origin)
    )
      return json({ error: ADMIN_DENIED }, 403);
    try {
      const action = new URL(request.url).pathname.slice(
        "/admin/federation".length,
      );
      if (request.method === "GET" && action === "") return json(this.view());
      const file = /^\/area-file\/([a-f0-9-]{36})$/.exec(action);
      if (request.method === "GET" && file)
        return new Response(this.acquisitions.file(file[1]!), {
          headers: {
            "Content-Type": "application/octet-stream",
            "Content-Disposition": `attachment; filename="atlas-area-${file[1]}.atlas"`,
          },
        });
      if (request.method !== "POST")
        return json({ error: "Method not allowed" }, 405);
      const body = JSON.parse(
        new TextDecoder().decode(await limitedBody(request, 16384)),
      );
      if (action === "/area-plan") {
        if (this.work) throw Error("Wait for source verification to finish.");
        const id = await this.acquisitions.create(body, [
          ...this.entries.values(),
        ]);
        return json({ id }, 202);
      }
      if (action === "/area-resume") {
        await this.acquisitions.resume(
          body.id,
          body.allowStorageRisk,
          body.acceptPartial,
        );
        return json(this.view(), 202);
      }
      if (action === "/area-pause") {
        await this.acquisitions.pause(body.id);
        return json(this.view());
      }
      if (action === "/area-delete") {
        await this.acquisitions.remove(body.id);
        return json(this.view());
      }
      if (action === "/area-publish") {
        await this.acquisitions.publishFile(body.id, body.allowStorageRisk);
        return json(this.view(), 202);
      }
      if (action === "/peer") {
        await this.addPeer(body.url, body.pubkey || undefined);
        return json(this.view());
      }
      if (action === "/remove-peer") {
        if (this.work || this.inspecting)
          throw Error("Wait for inspection or refresh to finish");
        this.peers = this.peers.filter(
          (p) =>
            p.url !== body.url || (body.pubkey && p.pubkey !== body.pubkey),
        );
        await this.save("peers.json", this.peers);
        const publishers = new Set(this.peers.map((p) => p.pubkey));
        for (const [id, e] of this.entries)
          if (e.publisher && !publishers.has(e.publisher)) {
            this.readers.get(id)?.dispose();
            this.readers.delete(id);
            this.entries.delete(id);
          }
        return json(this.view());
      }
      if (action === "/refresh") {
        this.refresh();
        return json(this.view(), 202);
      }
      if (action === "/plan") return json(this.plan(body));
      if (action === "/inspect") return json(await this.inspect(body));
      if (action === "/mirror") {
        if (this.mirrorStarting) throw Error("A mirror is being queued");
        this.mirrorStarting = true;
        try {
          return await this.startMirror(body.id, body.allowStorageRisk);
        } finally {
          this.mirrorStarting = false;
        }
      }
      const m = this.mirrors.get(body.id);
      if (action === "/resume" && m) {
        if (this.mirrorStarting) throw Error("A mirror is being queued");
        if (m.state !== "queued-import") this.runMirror(m);
        return json(m, 202);
      }
      if (action === "/pause" && m) {
        if (this.download?.id === m.id) {
          this.download.abort.abort();
          await this.download.done;
        }
        return json(m);
      }
      if (action === "/delete-mirror" && m) {
        if (this.download?.id === m.id || m.state === "queued-import")
          throw Error(
            "Pause first. Queued imports are managed under Builds & checkpoints.",
          );
        const r = await this.upload(`/${m.id}`, "DELETE");
        if (!r.ok) return r;
        await Bun.file(join(this.directory, `mirror-${m.id}.json`)).delete();
        this.mirrors.delete(m.id);
        return json({ deleted: true });
      }
      return json({ error: "Unknown federation action" }, 404);
    } catch (e) {
      return json(
        e instanceof StorageWarning
          ? { error: e.message, storageWarning: e.storageWarning }
          : { error: e instanceof Error ? e.message : String(e) },
        e instanceof StorageWarning ? 409 : 400,
      );
    }
  }
  async close() {
    this.closing = true;
    this.lifetime.abort();
    this.download?.abort.abort();
    await this.acquisitions.close();
    for (const r of this.readers.values()) r.dispose();
    await Promise.all([this.work, this.download?.done]);
  }
}

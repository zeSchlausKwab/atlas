import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { relayUrl } from "../../packages/hashtree/src/discovery";
import type { FipsProvider } from "../../packages/hashtree/src/source";
import { startFipsServer } from "../../packages/fips/src/server";
import type {
  FipsRpcRequest,
  FipsRpcResponse,
} from "../../packages/fips/src/rpc";
import type { AdminAccess } from "./admin-access";
import type { MapDiscovery } from "./discovery";

export interface FipsHostingSettings {
  enabled: boolean;
  httpEnabled: boolean;
  seedUrls: string[];
  relayUrls: string[];
}
export function parseHostingSettings(value: unknown): FipsHostingSettings {
  const v = value as FipsHostingSettings;
  if (
    !v ||
    typeof v.enabled !== "boolean" ||
    typeof v.httpEnabled !== "boolean"
  )
    throw new Error("Choose whether FIPS and HTTP delivery are enabled");
  const urls = (values: unknown, label: string) => {
    if (
      !Array.isArray(values) ||
      values.length > 8 ||
      values.some((u) => typeof u !== "string")
    )
      throw new Error(`Choose at most eight ${label}`);
    return [...new Set(values.map((u) => relayUrl(u)))];
  };
  const seedUrls = urls(v.seedUrls, "FIPS seeds"),
    relayUrls = urls(v.relayUrls, "discovery relays");
  if (v.enabled && !seedUrls.length)
    throw new Error("FIPS needs at least one bootstrap seed");
  return {
    enabled: v.enabled,
    httpEnabled: v.httpEnabled,
    seedUrls,
    relayUrls,
  };
}

export interface RuntimeStatus {
  peerId: string;
  connectedPeers: string[];
  requests: number;
  bytesServed: number;
  rpcRequests?: number;
  websocket?: object;
}
interface Runtime {
  peerId: string;
  status(): RuntimeStatus;
  stop(): Promise<void>;
}
type StartRuntime = (options: {
  keyPath: string;
  seedUrls: string[];
  getBlob(hash: string): Promise<Uint8Array | null>;
  rpc(
    request: FipsRpcRequest,
    peerId: string,
    signal: AbortSignal,
  ): Promise<FipsRpcResponse>;
}) => Promise<Runtime>;

/** Delivery controls only the public data plane; administration remains local/LAN HTTP. */
export class FipsHosting {
  private runtime?: Runtime;
  private error?: string;
  private startedAt = new Date().toISOString();
  private writes: Promise<unknown> = Promise.resolve();
  private closed = false;
  private constructor(
    readonly directory: string,
    private origin: string,
    private keyPath: string,
    private discovery: MapDiscovery,
    private access: AdminAccess,
    private rpc: (
      request: FipsRpcRequest,
      peerId: string,
      signal: AbortSignal,
    ) => Promise<FipsRpcResponse>,
    private start: StartRuntime,
    public settings: FipsHostingSettings,
  ) {}
  static async open(options: {
    directory: string;
    origin: string;
    keyPath?: string;
    discovery: MapDiscovery;
    access: AdminAccess;
    rpc: (
      request: FipsRpcRequest,
      peerId: string,
      signal: AbortSignal,
    ) => Promise<FipsRpcResponse>;
    start?: StartRuntime;
    defaults?: FipsHostingSettings;
  }) {
    await mkdir(options.directory, { recursive: true });
    const fromEnv = (name: string, fallback: string[]) =>
      process.env[name] === undefined
        ? fallback
        : process.env[name]!.split(",")
            .map((s) => s.trim())
            .filter(Boolean);
    let settings =
      options.defaults ??
      parseHostingSettings({
        enabled: process.env.ATLAS_FIPS_ENABLED !== "0",
        httpEnabled: process.env.ATLAS_HTTP_DELIVERY === "1",
        seedUrls: fromEnv("ATLAS_FIPS_SEEDS", [
          "wss://fips1.iris.to/fips",
          "wss://fips2.iris.to/fips",
        ]),
        relayUrls: fromEnv("ATLAS_DISCOVERY_RELAYS", [
          "wss://relay.damus.io",
          "wss://nos.lol",
        ]),
      });
    try {
      settings = parseHostingSettings(
        JSON.parse(
          await readFile(join(options.directory, "settings.json"), "utf8"),
        ),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const hosting = new FipsHosting(
      options.directory,
      options.origin,
      options.keyPath ?? join(options.directory, "provider.key"),
      options.discovery,
      options.access,
      options.rpc,
      options.start ?? startFipsServer,
      settings,
    );
    await hosting.apply(settings);
    return hosting;
  }
  async updateOrigin(origin: string) {
    if (origin === this.origin) return;
    this.origin = origin;
    await this.apply(this.settings);
  }
  get httpEnabled() {
    return this.settings.httpEnabled;
  }
  private async apply(settings: FipsHostingSettings) {
    if (this.closed) throw new Error("FIPS hosting is closed");
    const restart =
      settings.enabled !== this.settings.enabled ||
      JSON.stringify(settings.seedUrls) !==
        JSON.stringify(this.settings.seedUrls);
    if (this.runtime && restart) {
      await this.runtime.stop();
      this.runtime = undefined;
    }
    this.settings = settings;
    this.error = undefined;
    if (settings.enabled && !this.runtime) {
      try {
        await mkdir(dirname(this.keyPath), { recursive: true });
        this.runtime = await this.start({
          keyPath: this.keyPath,
          seedUrls: settings.seedUrls,
          getBlob: (hash) => this.discovery.getBlob(hash),
          rpc: this.rpc,
        });
        this.startedAt = new Date().toISOString();
      } catch (error) {
        this.error = String(error);
      }
    }
    const provider: FipsProvider[] = this.runtime
      ? [
          {
            peerId: this.runtime.peerId,
            seedUrls: settings.seedUrls,
            servicePort: 39018,
            rpcPort: 39019,
          },
        ]
      : [];
    await this.discovery.setDelivery({
      origin: this.origin,
      httpEnabled: settings.httpEnabled,
      fips: provider,
      relays: settings.relayUrls,
    });
  }
  status() {
    const runtime = this.runtime?.status();
    return {
      version: 2,
      state: this.error
        ? "failed"
        : !this.runtime
          ? "stopped"
          : runtime?.connectedPeers.length
            ? "connected"
            : "connecting",
      updatedAt: new Date().toISOString(),
      startedAt: this.startedAt,
      error: this.error,
      settings: this.settings,
      peerId: runtime?.peerId,
      connectedPeers: runtime?.connectedPeers ?? [],
      counters: {
        blobLookups: runtime?.requests ?? 0,
        blobBytes: runtime?.bytesServed ?? 0,
        rpcRequests: runtime?.rpcRequests ?? 0,
        websocket: runtime?.websocket ?? {},
      },
      discovery: {
        pubkey: this.discovery.pubkey,
        relays: this.settings.relayUrls,
      },
      maps: this.discovery.publishedOffers().map((m) => ({
        id: m.id,
        name: m.manifest.name,
        root: m.hashtree!.root,
        bytes: m.bytes,
        fips: m.hashtree!.fips,
        publication: this.discovery.jobs.get(m.id)?.message,
        relayErrors: this.discovery.jobs.get(m.id)?.relayErrors ?? [],
      })),
    };
  }
  async handle(request: Request, peer?: string): Promise<Response | undefined> {
    const path = new URL(request.url).pathname;
    if (path === "/fips-status.json" && request.method === "GET")
      return Response.json(this.status(), {
        headers: { "Cache-Control": "no-store" },
      });
    if (path !== "/admin/fips") return;
    if (!this.access(request, peer))
      return Response.json({ error: "Administration denied" }, { status: 403 });
    if (request.method === "GET") return Response.json(this.status());
    if (
      request.method !== "POST" ||
      request.headers.get("Origin") !== new URL(request.url).origin ||
      request.headers.get("Content-Type") !== "application/json"
    )
      return Response.json(
        { error: "Same-origin JSON request required" },
        { status: 403 },
      );
    try {
      const settings = parseHostingSettings(await request.json());
      const change = this.writes.then(async () => {
        const path = join(this.directory, "settings.json");
        await writeFile(
          path + ".tmp",
          JSON.stringify(settings, null, 2) + "\n",
          { mode: 0o600 },
        );
        await rename(path + ".tmp", path);
        await this.apply(settings);
      });
      this.writes = change.catch(() => {});
      await change;
      return Response.json(this.status());
    } catch (error) {
      return Response.json({ error: String(error) }, { status: 400 });
    }
  }
  async close() {
    this.closed = true;
    await this.writes;
    await this.runtime?.stop();
  }
}

/** The RPC service never proxies arbitrary URLs or exposes admin/file endpoints. */
export function mapRpcHandler(
  discovery: MapDiscovery,
  route: (request: Request) => Promise<Response | undefined>,
) {
  return async (
    rpc: FipsRpcRequest,
    _peer: string,
    signal: AbortSignal,
  ): Promise<FipsRpcResponse> => {
    signal.throwIfAborted();
    const map = discovery.publishedMap(rpc.root);
    if (!map) return { status: 404, body: { error: "Map is not published" } };
    const path = rpc.path.replace(/^\//, "");
    if (
      !/^(?:members\/m[0-9]{1,3}\/)?[a-z][a-z0-9_.-]{0,100}$/.test(path) ||
      !["GET", "POST"].includes(rpc.method)
    )
      return { status: 400, body: { error: "Invalid map operation" } };
    const request = new Request(
      `http://atlas.internal/maps/${map.id}/api/${path}`,
      {
        method: rpc.method,
        signal,
        ...(rpc.method === "POST"
          ? {
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(rpc.body),
            }
          : {}),
      },
    );
    const response = await route(request);
    if (!response)
      return { status: 404, body: { error: "Unknown map operation" } };
    const headers = Object.fromEntries(response.headers);
    if (response.headers.get("content-type")?.includes("application/json"))
      return { status: response.status, body: await response.json(), headers };
    return {
      status: response.status,
      bytes: new Uint8Array(await response.arrayBuffer()),
      headers,
    };
  };
}

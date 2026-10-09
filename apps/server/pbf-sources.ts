import {
  allowedPbfUrl,
  coveringRegion,
  importBounds,
  parseRegions,
  validateSourceArea,
  type PbfPlan,
  type PbfRegion,
} from "../../packages/provisioning/src/global-source";
import type { SourceFetch } from "../../packages/provisioning/src/download";
export class PbfSources {
  constructor(private readonly fetcher: SourceFetch = fetch) {}
  private catalog?: { at: number; regions: PbfRegion[] };
  private loading?: Promise<PbfRegion[]>;
  private plans = new Map<string, PbfPlan>();
  private metadata = new Map<
    string,
    {
      at: number;
      url: string;
      bytes: number;
      lastModified: string;
      etag?: string;
    }
  >();
  private async request(url: string, init: RequestInit) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.fetcher(url, {
          ...init,
          keepalive: false,
          signal: AbortSignal.timeout(20000),
        });
      } catch (e) {
        if (attempt === 0) continue;
        throw new Error(
          `Geofabrik request failed for ${new URL(url).pathname}: ${e instanceof Error ? e.message : String(e)}. Check the source again.`,
        );
      }
    }
  }
  async regions() {
    if (this.catalog && Date.now() - this.catalog.at < 6 * 3600_000)
      return this.catalog.regions;
    if (!this.loading)
      this.loading = (async () => {
        const r = await this.request(
          "https://download.geofabrik.de/index-v1.json",
          {
            redirect: "error",
            headers: { Connection: "close" },
          },
        );
        if (!r.ok) throw new Error(`Geofabrik catalog: HTTP ${r.status}`);
        const bytes = await boundedBody(r, 16 * 1024 * 1024),
          regions = parseRegions(JSON.parse(new TextDecoder().decode(bytes)));
        this.catalog = { at: Date.now(), regions };
        return regions;
      })().finally(() => {
        this.loading = undefined;
      });
    return this.loading;
  }
  async plan(value: unknown): Promise<PbfPlan> {
    validateSourceArea(value);
    const input = structuredClone(value),
      bounds = importBounds(input),
      region = coveringRegion(await this.regions(), bounds);
    const {
      url: sourceUrl,
      bytes,
      lastModified,
      etag,
    } = await this.inspect(region);
    if (bytes > input.maxSourceBytes)
      throw new Error(
        `${region.name} is the smallest covering region by area, but its PBF is ${(bytes / 1048576).toFixed(0)} MiB, above your ${(input.maxSourceBytes / 1048576).toFixed(0)} MiB download limit. Choose another area or less routing padding. The full regional PBF must be downloaded before cropping.`,
      );
    const plan: PbfPlan = {
      id: crypto.randomUUID(),
      provider: "geofabrik",
      region: { id: region.id, name: region.name, url: sourceUrl },
      bytes,
      ...(etag && !etag.startsWith("W/") ? { etag } : {}),
      lastModified,
      expiresAt: Date.now() + 30 * 60_000,
      area: input,
      bounds,
    };
    for (const [id, p] of this.plans)
      if (p.expiresAt < Date.now()) this.plans.delete(id);
    if (this.plans.size >= 32)
      this.plans.delete(this.plans.keys().next().value!);
    this.plans.set(plan.id, plan);
    return plan;
  }
  private async inspect(region: PbfRegion) {
    const cached = this.metadata.get(region.url);
    if (cached && Date.now() - cached.at < 5 * 60_000) return cached;
    let sourceUrl = allowedPbfUrl(region.url),
      response: Response | undefined;
    for (let hop = 0; hop < 4; hop++) {
      response = await this.request(sourceUrl, {
        method: "HEAD",
        redirect: "manual",
        // Geofabrik's redirect proxy can stall Bun HEAD keep-alive connections.
        headers: { Connection: "close" },
      });
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      const location = response.headers.get("location");
      if (!location) throw new Error("Source redirect has no destination");
      sourceUrl = allowedPbfUrl(new URL(location, sourceUrl).href);
    }
    if (!response) throw new Error("Cannot inspect source");
    if (!response.ok)
      throw new Error(`Cannot inspect ${region.name}: HTTP ${response.status}`);
    const bytes = Number(response.headers.get("content-length")),
      lastModified = response.headers.get("last-modified"),
      etag = response.headers.get("etag");
    if (
      !Number.isSafeInteger(bytes) ||
      bytes <= 0 ||
      !lastModified ||
      !Number.isFinite(Date.parse(lastModified))
    )
      throw new Error(
        "Source does not publish a usable size and modification date.",
      );
    const value = {
      at: Date.now(),
      url: sourceUrl,
      bytes,
      lastModified,
      etag: etag && !etag.startsWith("W/") ? etag : undefined,
    };
    if (this.metadata.size >= 64)
      this.metadata.delete(this.metadata.keys().next().value!);
    this.metadata.set(region.url, value);
    return value;
  }
  get(id: string) {
    const p = this.plans.get(id);
    if (!p || p.expiresAt < Date.now())
      throw new Error("Source plan expired. Check the PBF source again.");
    return structuredClone(p);
  }
}
async function boundedBody(response: Response, limit: number) {
  if (!response.body) throw new Error("Empty source response");
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) throw new Error("Source catalog exceeds size limit");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    bytes.set(c, at);
    at += c.length;
  }
  return bytes;
}

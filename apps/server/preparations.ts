import { OSM_ROUTING_CONTRACT } from "../../packages/format/src/routing-contract";
import { recoverBuild, type BuildRecovery } from "./preparation-recovery";
import type { ArchiveImport } from "./archive-import";
import {
  planRasterAmendment,
  type RasterAmendment,
} from "../../packages/provisioning/src/raster-amend";
import { limitedBody } from "./request-body";
import {
  IMAGE_MAX_BYTES,
  planImage,
  type ImageImport,
} from "../../packages/raster/src/image-plan";
import {
  capabilityChoices,
  installedCapabilities,
  familySelection,
  pinnedPbfMatches,
  coversCapabilities,
} from "../../packages/provisioning/src/families";
import type { CapabilityChange } from "../../packages/provisioning/src/compose-capabilities";
import {
  validBudget,
  NO_SIZE_LIMIT,
  hostPreparationSpace,
  checkStorageEstimate,
  StorageWarning,
  DISK_RESERVE,
} from "../../packages/provisioning/src/capacity";
import { AtlasReader } from "../../packages/format/src/reader";
import { PackageSource } from "./package-source";
import {
  planRoutingAmendment,
  routingAmendmentSelection,
  type RoutingAmendment,
} from "../../packages/provisioning/src/amend";
import { configuredOcean } from "../../packages/provisioning/src/ocean-source";
import { verifiedSource, verifiedSources } from "./verified-sources";
import {
  planCachedBuild,
  type VerifiedBuildSource,
} from "../../packages/provisioning/src/cached-build";
import { adminAccess, ADMIN_DENIED, type AdminAccess } from "./admin-access";
import { readStorage } from "./storage";
import { mkdir, readdir, rename, rm, link, stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { Manifest } from "../../packages/format/src/index";
import {
  availability,
  validateSelection,
  validateSelectionScope,
  type PackageSelection,
  type PreparationProgress,
} from "../../packages/provisioning/src/selection";
import {
  WORLD_SOURCE,
  planMatches,
  type PbfPlan,
} from "../../packages/provisioning/src/global-source";
import { validateImportSize } from "../../packages/provisioning/src/import-pbf";
import { PbfSources } from "./pbf-sources";
export interface HostedAmendment extends RoutingAmendment {
  targetId: string;
  sourceId: string;
}
export interface PreparationJob {
  id: string;
  name: string;
  createdAt: string;
  state:
    | "queued"
    | "running"
    | "cancelling"
    | "cancelled"
    | "failed"
    | "ready"
    | "deleting";
  selection: PackageSelection;
  resumeCheckpoint?: boolean;
  recovery?: BuildRecovery;
  allowStorageRisk?: boolean;
  sourcePlan?: PbfPlan;
  cachedSource?: VerifiedBuildSource;
  imageImport?: ImageImport;
  archiveImport?: ArchiveImport;
  compositionExport?: CompositionExport;
  rasterAmendment?: RasterAmendment;
  sourceAtlasId?: string;
  amendment?: HostedAmendment;
  capabilityChange?: CapabilityChange;
  served?: boolean;
  supersededBy?: string;
  progress: PreparationProgress;
  error?: string;
  size?: number;
  manifest?: Manifest;
}
export interface CompositionExport {
  name: string;
  inputs: Array<{ id: string; snapshot: string }>;
  maxBytes?: number;
}
export class Preparations {
  readonly sources = new PbfSources();
  readonly jobs = new Map<string, PreparationJob>();
  beforeDelete?: (id: string) => Promise<void>;
  private worker?: Bun.Subprocess<"ignore", "ignore", "pipe">;
  private active?: string;
  private activeSource?: string;
  private writes = Promise.resolve();
  private settling?: Promise<void>;
  private dispatching?: Promise<void>;
  private closing = false;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private constructor(
    readonly directory: string,
    readonly sourcePath: string,
    readonly source: Manifest,
    private readonly access: AdminAccess,
  ) {}
  static async open(
    directory: string,
    sourcePath: string,
    source: Manifest,
    access: AdminAccess = adminAccess(),
  ) {
    const manager = new Preparations(directory, sourcePath, source, access);
    await mkdir(directory, { recursive: true });
    for (const name of await readdir(directory)) {
      if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue;
      const job = (await Bun.file(
        resolve(directory, name),
      ).json()) as PreparationJob;
      if (name !== `${job.id}.json`)
        throw new Error("Invalid preparation record");
      manager.jobs.set(job.id, job);
      if (job.state === "deleting") {
        await manager.delete(job.id);
        continue;
      }
      if (job.state === "running" || job.state === "cancelling") {
        const wasStopping = job.state === "cancelling";
        job.state = wasStopping ? "cancelled" : "failed";
        job.error = job.rasterAmendment
          ? "Server stopped. Requeue to copy the imagery revision again; original files are retained."
          : job.archiveImport
            ? "Server stopped. Resume to verify or import the saved upload again."
            : job.cachedSource || job.imageImport
              ? "Server stopped. Resume to reuse completed compiler stages."
              : "Server stopped during preparation. Create the excerpt again.";
        await manager.cleanup(
          job.id,
          !!job.cachedSource ||
            !!job.capabilityChange ||
            !!job.imageImport ||
            !!job.archiveImport,
        );
        if (!wasStopping)
          recoverBuild(
            job,
            "Server interrupted an active preparation. " + job.error,
          );
        await manager.persist(job);
      }
      if (
        job.state === "ready" &&
        !(await Bun.file(manager.path(job.id)).exists())
      ) {
        job.state = "failed";
        job.error = "Prepared file is missing from disk.";
        await manager.persist(job);
      }
    }
    // Dispatch after recovery and loading all persisted dependencies.
    setTimeout(() => void manager.startQueue(), 0);
    return manager;
  }
  path(id: string) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid map ID");
    return resolve(this.directory, `${id}.atlas`);
  }
  private persist(job: PreparationJob) {
    const body = JSON.stringify(job),
      path = resolve(this.directory, `${job.id}.json`);
    const work = this.writes.then(async () => {
      await Bun.write(path + ".tmp", body);
      await rename(path + ".tmp", path);
    });
    this.writes = work.catch(console.error);
    return work;
  }
  private async cleanup(id: string, keepWork = false) {
    if (!keepWork)
      await rm(resolve(this.directory, `${id}.work`), {
        recursive: true,
        force: true,
      });
    for (const suffix of [
      "",
      ".composition",
      ".composition.part",
      ".composition.payload.part",
      ".composition.directory.part",
      ".part",
      ".payload.part",
      ".directory.part",
      ".amend.lock",
      ".amend.part",
      ".amend.part.payload.part",
      ".amend.part.directory.part",
      ".lock",
      ".raster.part",
      ".raster.part.payload.part",
      ".raster.part.directory.part",
      ".addition.atlas",
      ".addition.atlas.payload.part",
      ".addition.atlas.directory.part",
    ])
      await rm(this.path(id) + suffix, { force: true });
  }
  get sourceDirectory() {
    return resolve(this.directory, "../sources");
  }
  private wakeRetries() {
    clearTimeout(this.retryTimer);
    if (this.closing) return;
    const times = [...this.jobs.values()]
      .filter((j) => j.state === "queued" && j.recovery?.nextAttemptAt)
      .map((j) => Date.parse(j.recovery!.nextAttemptAt!))
      .filter((t) => Number.isFinite(t) && t > Date.now());
    if (times.length) {
      this.retryTimer = setTimeout(
        () => void this.startQueue().catch(console.error),
        Math.max(1, Math.min(...times) - Date.now()),
      );
      this.retryTimer.unref();
    }
  }
  async startQueue() {
    if (this.closing || this.active) return;
    if (this.dispatching) return this.dispatching;
    this.dispatching = (async () => {
      for (const job of [...this.jobs.values()].sort((a, b) =>
        a.createdAt.localeCompare(b.createdAt),
      )) {
        if (this.closing || this.active) break;
        if (job.state !== "queued") continue;
        if (
          job.recovery?.nextAttemptAt &&
          Date.parse(job.recovery.nextAttemptAt) > Date.now()
        )
          continue;
        if (
          job.sourceAtlasId &&
          this.jobs.get(job.sourceAtlasId)?.state !== "ready"
        )
          continue;
        try {
          await this.create(job.selection, job, true);
        } catch (error) {
          job.state = "failed";
          job.error = String(error);
          await this.persist(job);
        }
      }
    })().finally(() => {
      this.dispatching = undefined;
      this.wakeRetries();
    });
    return this.dispatching;
  }
  async resume(id: string, allowStorageRisk = false) {
    const job = this.jobs.get(id);
    if (!job || !["failed", "cancelled"].includes(job.state))
      throw new Error("Only stopped preparations can be queued again.");
    if (job.recovery) {
      job.recovery.retries = 0;
      delete job.recovery.nextAttemptAt;
    }
    // Storage consent is execution policy, not part of the checkpoint recipe.
    return this.create(job.selection, { ...job, allowStorageRisk });
  }
  private sourcePlanForMap(id: string): PbfPlan | undefined {
    const seen = new Set<string>();
    while (!seen.has(id)) {
      seen.add(id);
      const j = this.jobs.get(id);
      if (!j) return;
      if (j.sourcePlan) return j.sourcePlan;
      id =
        j.rasterAmendment?.targetId ??
        j.capabilityChange?.targetId ??
        j.amendment?.targetId ??
        j.sourceAtlasId ??
        "";
    }
  }
  async assertSourceUnused(id: string) {
    const source = await verifiedSource(this.sourceDirectory, id).catch(
      () => undefined,
    );
    if (
      [...this.jobs.values()].some(
        (j) =>
          ["queued", "running", "cancelling"].includes(j.state) &&
          (j.cachedSource?.id === id ||
            (j.capabilityChange?.sourceKind === "pbf" &&
              j.capabilityChange.sourceId === id) ||
            (!!source && j.sourcePlan?.region.url === source.url)),
      )
    )
      throw new Error(
        "Source is used by an active or queued build. Stop or remove those builds first.",
      );
  }
  async planCapabilities(value: CapabilityChange) {
    const target = this.amendmentInput(value?.targetId),
      m = target.manifest;
    if (value.targetSnapshot !== m.snapshot)
      throw new Error("Map revision changed. Reload the library.");
    if (
      typeof value.name !== "string" ||
      !value.name.trim() ||
      value.name.length > 80 ||
      !validBudget(value.maxBytes)
    )
      throw new Error("Choose a revision name and valid output budget.");
    if (
      !Number.isInteger(value.paddingCells) ||
      value.paddingCells < 0 ||
      value.paddingCells > 4
    )
      throw new Error("Routing padding must be 0–4 cells");
    if (
      !Array.isArray(value.capabilities) ||
      !value.capabilities.length ||
      new Set(value.capabilities).size !== value.capabilities.length ||
      value.capabilities.some(
        (c) => !capabilityChoices(m).some((v) => v.id === c),
      )
    )
      throw new Error("Choose supported, distinct capabilities");
    if (
      m.routing ||
      (m.capabilities.includes("vector-rendering") && !m.tileLayers)
    )
      throw new Error("Migrate this legacy map before composing capabilities");
    const installed = installedCapabilities(m),
      additions = value.capabilities.filter((c) => !installed.includes(c)),
      removals = installed.filter((c) => !value.capabilities.includes(c));
    const rebuild = [...additions];
    if (additions.some((c) => c.startsWith("routing:")))
      for (const c of value.capabilities)
        if (c.startsWith("routing:") && !rebuild.includes(c)) rebuild.push(c);
    if (!additions.length && !removals.length)
      throw new Error("No capability changes selected");
    const change: CapabilityChange = {
      targetId: value.targetId,
      targetSnapshot: m.snapshot,
      name: value.name.trim(),
      capabilities: [...value.capabilities],
      paddingCells: value.paddingCells,
      maxBytes: value.maxBytes,
    };
    let source: VerifiedBuildSource | undefined,
      donor: ReturnType<Preparations["amendmentInput"]> | undefined,
      download: PbfPlan | undefined;
    if (rebuild.length) {
      const cached = await verifiedSources(this.sourceDirectory);
      const choice = cached.find(
        (s) =>
          (!value.sourceId || s.id === value.sourceId) &&
          pinnedPbfMatches(m, s.sha256),
      );
      if (choice && (!value.sourceKind || value.sourceKind === "pbf")) {
        source = await verifiedSource(this.sourceDirectory, choice.id);
        change.sourceKind = "pbf";
        change.sourceId = source.id;
        change.sourceSnapshot = source.sha256;
      } else {
        const candidates = [
          { id: "demo", manifest: this.source },
          ...[...this.jobs.values()]
            .filter((j) => j.state === "ready" && j.manifest)
            .map((j) => ({ id: j.id, manifest: j.manifest! })),
        ];
        const selected = candidates.find(
          (d) =>
            d.id !== value.targetId &&
            (!value.sourceId || d.id === value.sourceId) &&
            d.manifest.source.sha256 === m.source.sha256 &&
            rebuild.every((c) =>
              installedCapabilities(d.manifest).includes(c),
            ) &&
            m.bounds[0] >= d.manifest.bounds[0] &&
            m.bounds[1] >= d.manifest.bounds[1] &&
            m.bounds[2] <= d.manifest.bounds[2] &&
            m.bounds[3] <= d.manifest.bounds[3] &&
            coversCapabilities(d.manifest, m),
        );
        if (selected && (!value.sourceKind || value.sourceKind === "atlas")) {
          donor = this.amendmentInput(selected.id);
          change.sourceKind = "atlas";
          change.sourceId = selected.id;
          change.sourceSnapshot = donor.manifest.snapshot;
        } else {
          const plan = this.sourcePlanForMap(value.targetId),
            input = m.source.inputs?.find((s) => s.url === plan?.region.url);
          if (
            plan &&
            input &&
            (!value.sourceKind || value.sourceKind === "download")
          ) {
            download = plan;
            change.sourceKind = "download";
            change.sourceId = plan.id;
            change.sourceSnapshot = input.sha256;
          } else
            throw new Error(
              "No pinned PBF or compatible Atlas source is available. Restore this map's original source in the source library.",
            );
        }
      }
      if (
        value.sourceSnapshot &&
        value.sourceSnapshot !== change.sourceSnapshot
      )
        throw new Error(
          "Amendment source changed. Review the selection again.",
        );
      if (
        change.sourceKind !== "atlas" &&
        (!Bun.which("osmium") || !Bun.which("cargo"))
      )
        throw new Error(
          "PBF amendments require Osmium and Cargo on this server",
        );
    }
    const size = Bun.file(target.path).size;
    const estimatedOutput =
      value.maxBytes === NO_SIZE_LIMIT
        ? Math.max(size * (rebuild.length ? 3 : 1), 256 * 1024 ** 2)
        : value.maxBytes;
    return {
      change,
      additions,
      removals,
      rebuild,
      source,
      donor,
      download,
      reusableBytes: size,
      estimatedWorkspaceBytes:
        DISK_RESERVE +
        size +
        estimatedOutput * 2 +
        512 * 1024 ** 2 +
        (download?.bytes ?? 0),
      sourceName:
        source?.name ??
        donor?.manifest.name ??
        download?.region.name ??
        "Existing file only",
      warnings: [
        "A new self-contained revision replaces the served map only after success. The old file is retained locally and can be served again.",
        ...(rebuild.some((c) => installed.includes(c))
          ? [
              "Selected routing modes are rebuilt together to preserve one compiled graph identity.",
            ]
          : []),
        "Map copies already downloaded by consumers cannot be recalled. New Hashtree publication is explicit.",
      ],
    };
  }
  async createCapabilities(value: CapabilityChange) {
    this.assertNoAmendment(value?.targetId);
    const p = await this.planCapabilities(value),
      m = this.amendmentInput(value.targetId).manifest;
    return this.create({
      ...familySelection(
        m,
        p.change.capabilities,
        p.change.name,
        p.change.maxBytes,
        p.change.paddingCells,
      ),
      capabilityChange: p.change,
      allowStorageRisk: value.allowStorageRisk,
    });
  }
  async setServed(id: string, served: boolean) {
    const job = this.jobs.get(id);
    if (!job || job.state !== "ready" || typeof served !== "boolean")
      throw new Error("Choose a ready map");
    job.served = served;
    await this.persist(job);
    if (!served) await this.beforeDelete?.(id);
    return job;
  }
  private amendmentInput(id: string) {
    if (id === "demo") return { path: this.sourcePath, manifest: this.source };
    const job = this.jobs.get(id);
    if (!job?.manifest || job.state !== "ready")
      throw new Error("Amendment inputs must be ready Atlas maps.");
    return { path: this.path(id), manifest: job.manifest };
  }
  async planAmendment(value: HostedAmendment) {
    const a = this.amendmentInput(value?.targetId),
      b = this.amendmentInput(value?.sourceId);
    routingAmendmentSelection(a.manifest, b.manifest, value);
    const targetFile = await PackageSource.open(a.path);
    let sourceFile: PackageSource | undefined,
      target: AtlasReader | undefined,
      source: AtlasReader | undefined;
    try {
      sourceFile = await PackageSource.open(b.path);
      target = await new AtlasReader(targetFile).open();
      source = await new AtlasReader(sourceFile).open();
      return await planRoutingAmendment(target, source, value);
    } finally {
      target?.dispose();
      source?.dispose();
      await targetFile.close();
      await sourceFile?.close();
    }
  }
  async createAmendment(value: HostedAmendment) {
    this.assertNoAmendment(value?.targetId);
    const a = this.amendmentInput(value?.targetId),
      b = this.amendmentInput(value?.sourceId);
    const selection = routingAmendmentSelection(a.manifest, b.manifest, value);
    // Full plan verifies selected cells before accepting the queued job.
    await this.planAmendment(value);
    return this.create({
      ...selection,
      sourceAtlasId: value.sourceId === "demo" ? undefined : value.sourceId,
      amendment: value,
    });
  }
  private async rasterInputs(request: RasterAmendment) {
    if (!request || !Array.isArray(request.layers))
      throw new Error("Choose imagery layers");
    const target = this.amendmentInput(request.targetId);
    const sources = Object.fromEntries(
      [
        ...new Set(
          request.layers
            .map((r) => r?.sourceId)
            .filter((id): id is string => typeof id === "string"),
        ),
      ].map((id) => [id, this.amendmentInput(id).path]),
    );
    return { target: target.path, sources };
  }
  async planRasters(request: RasterAmendment) {
    const paths = await this.rasterInputs(request),
      files: PackageSource[] = [],
      readers: AtlasReader[] = [];
    const read = async (path: string) => {
      const f = await PackageSource.open(path);
      files.push(f);
      const r = await new AtlasReader(f).open();
      readers.push(r);
      return r;
    };
    try {
      const target = await read(paths.target),
        sources = new Map<string, AtlasReader>();
      for (const [id, path] of Object.entries(paths.sources))
        sources.set(id, await read(path));
      return await planRasterAmendment(target, sources, request);
    } finally {
      readers.forEach((r) => r.dispose());
      await Promise.all(files.map((f) => f.close()));
    }
  }
  async createRasters(request: RasterAmendment) {
    this.assertNoAmendment(request?.targetId);
    const m = this.amendmentInput(request.targetId).manifest;
    return this.create({
      ...familySelection(
        m,
        installedCapabilities(m),
        request.name,
        request.maxBytes,
        m.selection?.routingPaddingCells ?? 0,
      ),
      rasterAmendment: request,
      allowStorageRisk: request.allowStorageRisk,
    });
  }
  private assertNoAmendment(targetId: string) {
    if (
      [...this.jobs.values()].some(
        (j) =>
          (j.rasterAmendment?.targetId === targetId ||
            j.capabilityChange?.targetId === targetId ||
            j.amendment?.targetId === targetId) &&
          ["queued", "running", "cancelling"].includes(j.state),
      )
    )
      throw new Error("An amendment for this map is already queued or running");
  }
  async createArchive(
    id: string,
    input: string,
    archive: ArchiveImport,
    allowStorageRisk = false,
  ) {
    if (this.closing)
      throw new Error("Server is stopping; try again after restart.");
    this.path(id); // Validate generated identity before using a work directory.
    const existing = this.jobs.get(id);
    if (existing) return existing; // Retried finish request must not queue a duplicate.
    const metadata: ArchiveImport = {
      filename: archive.filename,
      size: archive.size,
      format: archive.format,
    };
    const work = resolve(this.directory, `${id}.work`),
      staged = resolve(work, `input.${archive.format}`);
    await mkdir(work, { recursive: true });
    try {
      try {
        await link(input, staged);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const a = await stat(input),
          b = await stat(staged);
        if (a.ino !== b.ino || a.dev !== b.dev)
          throw new Error("Import staging file already exists");
      }
      const job: PreparationJob = {
        id,
        name: archive.filename.replace(/\.(atlas|mbtiles)$/i, ""),
        createdAt: new Date().toISOString(),
        state: "queued",
        archiveImport: metadata,
        allowStorageRisk,
        selection: {
          snapshot: "0".repeat(64),
          name: archive.filename,
          polygon: [
            [-180, -85],
            [180, -85],
            [180, 85],
            [-180, 85],
          ],
          minZoom: 0,
          maxZoom: 0,
          layers: [],
          placeNames: false,
          streetNames: false,
          pois: false,
          profiles: [],
          search: false,
          reverse: false,
          peaks: false,
          featureKinds: [],
          paddingCells: 0,
          maxBytes: NO_SIZE_LIMIT,
        },
        progress: {
          phase: "planning",
          message: "File uploaded · queued for import",
          completed: 0,
          total: 0,
          readBytes: 0,
          writtenBytes: 0,
        },
      };
      await this.persist(job);
      this.jobs.set(id, job);
      void this.startQueue().catch(console.error);
      return job;
    } catch (error) {
      await rm(work, { recursive: true, force: true });
      throw error;
    }
  }
  async createImage(
    bytes: Uint8Array,
    placement: unknown,
    allowStorageRisk = false,
  ) {
    if (this.closing)
      throw new Error("Server is stopping; try again after restart.");
    const plan = await planImage(bytes, placement);
    checkStorageEstimate(
      DISK_RESERVE + plan.estimatedBytes,
      (await readStorage(this.directory)).availableBytes,
      allowStorageRisk,
    );
    const id = crypto.randomUUID(),
      [w, s, e, n] = plan.layer.bounds;
    const job: PreparationJob = {
      id,
      name: plan.layer.name,
      createdAt: new Date().toISOString(),
      state: "queued",
      imageImport: plan,
      allowStorageRisk,
      selection: {
        snapshot: plan.sha256,
        name: plan.layer.name,
        polygon: [
          [w, s],
          [e, s],
          [e, n],
          [w, n],
        ],
        minZoom: 0,
        maxZoom: plan.layer.maxZoom,
        layers: [],
        placeNames: false,
        streetNames: false,
        pois: false,
        profiles: [],
        search: false,
        reverse: false,
        peaks: false,
        featureKinds: [],
        paddingCells: 0,
        maxBytes: NO_SIZE_LIMIT,
      },
      progress: {
        phase: "planning",
        message: "Image uploaded · queued for tiling",
        completed: 0,
        total: plan.tiles,
        unit: "blocks",
        readBytes: 0,
        writtenBytes: 0,
      },
    };
    try {
      await Bun.write(resolve(this.directory, `${id}.work/input.png`), bytes);
      await this.persist(job);
    } catch (e) {
      await this.cleanup(id);
      throw e;
    }
    this.jobs.set(id, job);
    void this.startQueue().catch(console.error);
    return job;
  }
  private compositionInputs(request: CompositionExport) {
    if (
      !request ||
      typeof request.name !== "string" ||
      !request.name.trim() ||
      request.name.length > 80 ||
      !Array.isArray(request.inputs) ||
      !request.inputs.length ||
      request.inputs.length > 64 ||
      new Set(request.inputs.map((i) => i?.id)).size !== request.inputs.length
    )
      throw new Error("Choose 1–64 distinct maps and a name");
    if (!validBudget(request.maxBytes ?? NO_SIZE_LIMIT))
      throw new Error("Invalid output budget");
    return request.inputs.map((input) => {
      const source = this.amendmentInput(input.id);
      if (source.manifest.snapshot !== input.snapshot)
        throw new Error("Composition source snapshot changed");
      if (source.manifest.composition)
        throw new Error(
          "Choose original member maps; nested compositions are not supported",
        );
      return {
        path: source.path,
        manifest: source.manifest,
        bytes: Bun.file(source.path).size,
      };
    });
  }
  async createComposition(
    request: CompositionExport & { allowStorageRisk?: boolean },
  ) {
    const inputs = this.compositionInputs(request);
    const selection = familySelection(
      inputs[0]!.manifest,
      installedCapabilities(inputs[0]!.manifest),
      request.name,
      request.maxBytes ?? NO_SIZE_LIMIT,
      0,
    );
    return this.create({
      ...selection,
      compositionExport: request,
      allowStorageRisk: request.allowStorageRisk,
    });
  }
  async create(value: unknown, previous?: PreparationJob, start = false) {
    if (this.closing)
      throw new Error("Server is stopping; try again after restart.");
    const extra = value as {
      sourcePlanId?: string;
      cachedSourceId?: string;
      maxSourceBytes?: number;
      sourceAtlasId?: string;
      amendment?: HostedAmendment;
      capabilityChange?: CapabilityChange;
      rasterAmendment?: RasterAmendment;
      compositionExport?: CompositionExport;
      allowStorageRisk?: boolean;
    } | null;
    if (
      extra?.allowStorageRisk !== undefined &&
      typeof extra.allowStorageRisk !== "boolean"
    )
      throw new Error("Invalid storage override");
    const allowStorageRisk =
      previous?.allowStorageRisk ?? extra?.allowStorageRisk ?? false;
    const imageImport = previous?.imageImport;
    const archiveImport = previous?.archiveImport;
    const compositionExport =
      previous?.compositionExport ?? extra?.compositionExport;
    const compositionInputs = compositionExport
      ? this.compositionInputs(compositionExport)
      : undefined;
    if (
      compositionExport &&
      (extra?.cachedSourceId ||
        extra?.sourcePlanId ||
        extra?.sourceAtlasId ||
        extra?.amendment ||
        extra?.capabilityChange ||
        extra?.rasterAmendment)
    )
      throw new Error("Choose one preparation type");
    const rasterAmendment = previous?.rasterAmendment ?? extra?.rasterAmendment;
    const rasterPlan = rasterAmendment
      ? await this.planRasters(rasterAmendment)
      : undefined;
    if (
      rasterAmendment &&
      (extra?.cachedSourceId ||
        extra?.sourcePlanId ||
        extra?.sourceAtlasId ||
        extra?.capabilityChange ||
        extra?.amendment)
    )
      throw new Error("Choose one amendment type");
    if (rasterAmendment) {
      const m = this.amendmentInput(rasterAmendment.targetId).manifest;
      value = familySelection(
        m,
        installedCapabilities(m),
        rasterAmendment.name,
        rasterAmendment.maxBytes,
        m.selection?.routingPaddingCells ?? 0,
      );
    }
    const capabilityChange =
      previous?.capabilityChange ?? extra?.capabilityChange;
    const capabilityPlan = capabilityChange
      ? await this.planCapabilities(capabilityChange)
      : undefined;
    const amendment = previous?.amendment ?? extra?.amendment;
    if (
      amendment &&
      (extra?.cachedSourceId ||
        extra?.sourcePlanId ||
        previous?.cachedSource ||
        previous?.sourcePlan)
    )
      throw new Error("An amendment uses existing Atlas inputs only.");
    const plan =
      previous?.sourcePlan ??
      (extra?.sourcePlanId ? this.sources.get(extra.sourcePlanId) : undefined);
    const cachedId = extra?.cachedSourceId ?? previous?.cachedSource?.id;
    const cached = cachedId
      ? await verifiedSource(this.sourceDirectory, cachedId)
      : undefined;
    if (
      [extra?.cachedSourceId, extra?.sourcePlanId, extra?.sourceAtlasId].filter(
        Boolean,
      ).length > 1
    )
      throw new Error("Choose exactly one source.");
    if (extra?.sourcePlanId && !plan)
      throw new Error("Source plan expired. Check Geofabrik again.");
    const atlasId = previous?.sourceAtlasId ?? extra?.sourceAtlasId;
    const atlas = atlasId ? this.jobs.get(atlasId) : undefined;
    if (
      atlasId &&
      (!atlas || ["deleting", "failed", "cancelled"].includes(atlas.state))
    )
      throw new Error("The selected Atlas dataset is no longer available.");
    if (
      atlas?.manifest &&
      (start || (value as PackageSelection)?.snapshot === `pending:${atlas.id}`)
    )
      value = {
        ...(value as PackageSelection),
        snapshot: atlas.manifest.snapshot,
      };
    if (capabilityPlan)
      value = familySelection(
        this.amendmentInput(capabilityPlan.change.targetId).manifest,
        capabilityPlan.change.capabilities,
        capabilityPlan.change.name,
        capabilityPlan.change.maxBytes,
        capabilityPlan.change.paddingCells,
      );
    if (amendment) {
      const a = this.amendmentInput(amendment.targetId),
        b = this.amendmentInput(amendment.sourceId);
      if ((atlas?.id ?? "demo") !== amendment.sourceId)
        throw new Error("Amendment source changed.");
      value = routingAmendmentSelection(a.manifest, b.manifest, amendment);
    }
    const inputPath = atlas ? this.path(atlas.id) : this.sourcePath;
    const selectedOcean = (value as PackageSelection)?.ocean;
    if (selectedOcean) {
      const ocean = await configuredOcean();
      if (
        !cached ||
        !ocean ||
        ocean.sha256 !== selectedOcean.sha256 ||
        !Bun.which("ogr2ogr")
      )
        throw new Error(
          "Choose the configured ocean source with a cached PBF; GDAL must be installed",
        );
    }
    if (compositionExport) {
      // Each independent member is pinned above; the parent is only a container.
    } else if (rasterPlan) {
      // Raster inputs are pinned and validated independently of PBF capability selections.
    } else if (archiveImport) {
      if (
        Bun.file(
          resolve(
            this.directory,
            `${previous!.id}.work/input.${archiveImport.format}`,
          ),
        ).size !== archiveImport.size
      )
        throw new Error(
          "Uploaded archive is missing or changed. Upload it again.",
        );
    } else if (imageImport) {
      if (
        !(await Bun.file(
          resolve(this.directory, `${previous!.id}.work/input.png`),
        ).exists())
      )
        throw new Error("Uploaded image is missing. Upload it again.");
    } else if (capabilityPlan) {
      validateSelectionScope(value, {
        ...WORLD_SOURCE,
        snapshot: capabilityChange!.targetSnapshot,
      });
    } else if (cached) {
      validateSelectionScope(value, WORLD_SOURCE);
      planCachedBuild(value);
      if (
        previous?.cachedSource &&
        (previous.cachedSource.sha256 !== cached.sha256 ||
          previous.cachedSource.mtimeMs !== cached.mtimeMs)
      )
        throw new Error("Cached PBF changed since this build started.");
      if (!Bun.which("osmium") || !Bun.which("cargo"))
        throw new Error(
          "PBF preparation requires Osmium and Cargo on the server.",
        );
    } else if (plan) {
      validateSelectionScope(value, WORLD_SOURCE);
      if (!previous && !planMatches(plan, value, extra!.maxSourceBytes!))
        throw new Error(
          "Area, routing padding or source budget changed. Check the PBF source again.",
        );
      if (!Bun.which("osmium") || !Bun.which("cargo"))
        throw new Error(
          "PBF preparation requires Osmium and Cargo on the server.",
        );
      validateImportSize(plan, value);
    } else if (atlas && atlas.state !== "ready") {
      validateSelectionScope(value, {
        ...WORLD_SOURCE,
        snapshot: (value as PackageSelection).snapshot,
      });
      if (start) throw new Error("Waiting for the parent dataset to finish.");
    } else validateSelection(value, atlas?.manifest ?? this.source);
    const selection =
      imageImport || archiveImport
        ? previous!.selection
        : (value as PackageSelection);
    // Check the same estimate at submission and dispatch. Acceptance is scoped to the saved job.
    const partitioned = !!cached && !!planCachedBuild(selection).partitioned;
    const extractedBytes =
      previous?.resumeCheckpoint && cached
        ? Bun.file(
            resolve(
              this.directory,
              `${previous.id}.work/extraction/area.osm.pbf`,
            ),
          ).size
        : 0;
    const needed = compositionInputs
      ? DISK_RESERVE + compositionInputs.reduce((n, i) => n + i.bytes, 0) * 2.1
      : rasterPlan
        ? rasterPlan.estimatedWorkspaceBytes
        : archiveImport
          ? DISK_RESERVE +
            (archiveImport.format === "mbtiles" ? archiveImport.size * 2.2 : 0)
          : imageImport
            ? DISK_RESERVE + imageImport.estimatedBytes
            : capabilityPlan
              ? capabilityPlan.estimatedWorkspaceBytes
              : amendment
                ? (await this.planAmendment(amendment)).estimatedWorkspaceBytes
                : hostPreparationSpace(selection.maxBytes, {
                    cached: !!cached,
                    partitioned,
                    resume: !!previous?.resumeCheckpoint,
                    extractedBytes,
                    sourceBytes: plan?.bytes,
                    atlasBytes: Bun.file(inputPath).size,
                  });
    const disk = await readStorage(this.directory);
    checkStorageEstimate(needed, disk.availableBytes, allowStorageRisk);
    if (!start) {
      const job: PreparationJob = {
        id: previous?.id ?? crypto.randomUUID(),
        name: selection.name.trim(),
        createdAt: previous?.createdAt ?? new Date().toISOString(),
        state: "queued",
        selection: structuredClone(selection),
        sourcePlan: plan,
        cachedSource: cached,
        imageImport,
        archiveImport,
        compositionExport,
        rasterAmendment,
        sourceAtlasId: atlas?.id,
        amendment,
        capabilityChange: capabilityPlan?.change,
        resumeCheckpoint: !!previous?.cachedSource,
        recovery: previous?.recovery,
        allowStorageRisk,
        progress: {
          phase: "planning",
          message:
            atlas && atlas.state !== "ready"
              ? `Queued; waiting for ${atlas.name}`
              : "Queued; starts when the compiler is available",
          completed: 0,
          total: 0,
          readBytes: 0,
          writtenBytes: previous?.progress.writtenBytes ?? 0,
        },
      };
      this.jobs.set(job.id, job);
      await this.persist(job);
      void this.startQueue().catch(console.error);
      return job;
    }
    if (this.active)
      throw new Error(
        "Another preparation is running. Wait for it or cancel it first.",
      );
    const id = previous?.id ?? crypto.randomUUID();
    this.active = id;
    this.activeSource = atlas?.id;
    try {
      if (previous && previous.state !== "queued") {
        this.active = undefined;
        this.activeSource = undefined;
        return previous;
      }
      const job: PreparationJob = Object.assign(previous ?? {}, {
        id,
        name: selection.name.trim(),
        createdAt: previous?.createdAt ?? new Date().toISOString(),
        state: "running",
        allowStorageRisk,
        selection: structuredClone(selection),
        sourcePlan: plan,
        cachedSource: cached,
        imageImport,
        archiveImport,
        compositionExport,
        rasterAmendment,
        sourceAtlasId: atlas?.id,
        amendment,
        capabilityChange: capabilityPlan?.change,
        progress: {
          phase: "planning",
          message: archiveImport
            ? "Opening uploaded archive…"
            : imageImport
              ? "Opening uploaded image and saved tiles…"
              : cached
                ? "Opening verified cached PBF and saved compiler stages…"
                : plan
                  ? `Preparing ${plan.region.name} from OSM PBF…`
                  : "Opening the source snapshot…",
          completed: 0,
          total: 0,
          readBytes: 0,
          writtenBytes: 0,
        },
      } as PreparationJob);
      if (job.recovery) delete job.recovery.nextAttemptAt;
      job.error = undefined;
      this.jobs.set(id, job);
      await this.persist(job);
      let worker: Bun.Subprocess<"ignore", "ignore", "pipe">;
      let finished = false;
      const finish = (data: {
        type: string;
        error?: string;
        size?: number;
        manifest?: Manifest;
      }) => {
        if (finished) return;
        finished = true;
        this.settling = (async () => {
          const cancelled =
            job.state === "cancelling" || data.type === "cancelled";
          const finalState = cancelled
            ? "cancelled"
            : data.type === "ready"
              ? "ready"
              : "failed";
          job.error = cancelled ? "Preparation cancelled." : data.error;
          if (finalState === "ready") {
            job.size = data.size;
            job.manifest = data.manifest;
            if (archiveImport && data.manifest) {
              job.name = data.manifest.name;
              job.selection = familySelection(
                data.manifest,
                installedCapabilities(data.manifest),
                data.manifest.name,
                NO_SIZE_LIMIT,
                data.manifest.selection?.routingPaddingCells ?? 0,
              );
            }
            job.progress.message = "Ready to serve and download.";
            job.progress.writtenBytes = data.size!;
            // Make the new revision durable before exposing it. Switch the in-memory
            // catalog without an await, so "ready" never exposes both revisions.
            await this.persist({ ...job, state: "ready" });
            const parentId =
              job.rasterAmendment?.targetId ?? job.capabilityChange?.targetId;
            const parent = parentId ? this.jobs.get(parentId) : undefined;
            if (parent) {
              parent.supersededBy = job.id;
              parent.served = false;
            }
            job.state = "ready";
            if (archiveImport)
              await rm(resolve(this.directory, `${id}.work`), {
                recursive: true,
                force: true,
              });
            if (parent) {
              await this.persist(parent);
              await this.beforeDelete?.(parent.id);
            }
          } else {
            job.state = finalState;
            await this.cleanup(
              id,
              !!job.cachedSource ||
                !!job.capabilityChange ||
                !!job.imageImport ||
                !!job.archiveImport,
            );
          }
          if (finalState === "failed")
            recoverBuild(job, job.error ?? "Unknown preparation failure");
          await this.persist(job);
        })()
          .catch((error) => {
            job.state = "failed";
            job.error = String(error);
            console.error(error);
          })
          .finally(() => {
            this.active = undefined;
            this.activeSource = undefined;
            this.worker = undefined;
            worker.kill();
            void this.startQueue().catch(console.error);
          });
      };
      worker = this.worker = Bun.spawn(
        [
          process.execPath,
          new URL("./preparation-worker.ts", import.meta.url).pathname,
        ],
        {
          stdin: "ignore",
          stdout: "ignore",
          stderr: "pipe",
          ipc(data: any) {
            if (data.type === "progress") {
              if (job.state !== "cancelling") {
                job.progress = data.progress;
                void manager.persist(job);
              }
            } else finish(data);
          },
        },
      );
      const manager = this;
      const stderr = new Response(worker.stderr).text();
      void worker.exited.then(async (code) => {
        if (!finished)
          finish({
            type: "failed",
            error: `Preparation process exited (${code}): ${(await stderr).slice(-2000)}`,
          });
      });
      worker.send({
        type: "start",
        source: inputPath,
        output: this.path(id),
        selection: job.selection,
        sourcePlan: plan,
        cachedSource: cached,
        imageImport,
        archiveImport,
        compositionExport: compositionExport
          ? {
              request: compositionExport,
              paths: compositionInputs!.map((i) => i.path),
            }
          : undefined,
        rasterAmendment: rasterAmendment
          ? {
              request: rasterAmendment,
              ...(await this.rasterInputs(rasterAmendment)),
            }
          : undefined,
        capabilityChange: capabilityPlan
          ? {
              request: capabilityPlan.change,
              target: this.amendmentInput(capabilityPlan.change.targetId).path,
              source: capabilityPlan.source,
              donor: capabilityPlan.donor?.path,
              download: capabilityPlan.download,
              cache: this.sourceDirectory,
              rebuild: capabilityPlan.rebuild,
            }
          : undefined,
        amendment: amendment
          ? {
              request: amendment,
              target: this.amendmentInput(amendment.targetId).path,
            }
          : undefined,
      });
      return job;
    } catch (e) {
      this.worker?.kill();
      this.worker = undefined;
      const job = this.jobs.get(id);
      if (job) {
        job.state = "failed";
        job.error = String(e);
        await this.persist(job).catch(console.error);
      }
      this.active = undefined;
      this.activeSource = undefined;
      throw e;
    }
  }
  async cancel(id: string) {
    const job = this.jobs.get(id);
    if (!job) throw new Error("Unknown preparation");
    if (job.state === "queued") {
      job.state = "cancelled";
      if (job.recovery) delete job.recovery.nextAttemptAt;
      job.progress.message = "Removed from queue; preparation has not started.";
      await this.persist(job);
      return job;
    }
    if (job.state !== "running") return job;
    job.state = "cancelling";
    job.progress.message =
      job.cachedSource || job.imageImport
        ? "Stopping; completed stages will be kept for resume…"
        : "Cancelling and removing partial files…";
    this.worker?.send({ type: "cancel" });
    await this.persist(job);
    return job;
  }
  /** Persist a tombstone before unlinking so a restart completes partial deletion. */
  async delete(id: string) {
    const file = this.path(id);
    const job = this.jobs.get(id);
    if (!job) throw new Error("Unknown dataset");
    if (this.active === id || ["running", "cancelling"].includes(job.state))
      throw new Error("Stop this preparation before deleting it.");
    if (resolve(file) === resolve(this.sourcePath))
      throw new Error(
        "This dataset is the server's base map and cannot be deleted here.",
      );
    if (
      this.activeSource === id ||
      [...this.jobs.values()].some(
        (j) =>
          (j.compositionExport?.inputs.some((i) => i.id === id) ||
            j.sourceAtlasId === id ||
            j.rasterAmendment?.targetId === id ||
            j.rasterAmendment?.layers.some((r) => r.sourceId === id) ||
            j.amendment?.targetId === id ||
            j.amendment?.sourceId === id ||
            j.capabilityChange?.targetId === id ||
            (j.capabilityChange?.sourceKind === "atlas" &&
              j.capabilityChange.sourceId === id)) &&
          ["queued", "running", "cancelling"].includes(j.state),
      )
    )
      throw new Error(
        "This dataset is used by an active or queued preparation. Stop or remove those builds first.",
      );
    job.state = "deleting";
    await this.persist(job);
    await this.beforeDelete?.(id);
    await this.cleanup(id);
    await rm(resolve(this.directory, `${id}.json`), { force: true });
    this.jobs.delete(id);
    return { deleted: id };
  }
  catalog() {
    return [...this.jobs.values()]
      .filter((j) => j.state === "ready" && j.served !== false && j.manifest)
      .map((j) => ({
        id: j.id,
        name: j.name,
        bytes: j.size,
        url: `/maps/${j.id}.atlas`,
        api: `/maps/${j.id}/api`,
        manifest: j.manifest,
      }));
  }
  async handle(request: Request, remoteAddress?: string) {
    const url = new URL(request.url),
      json = (value: unknown, status = 200) =>
        Response.json(value, {
          status,
          headers: { "Cache-Control": "no-store" },
        });
    if (!this.access(request, remoteAddress))
      return json({ error: ADMIN_DENIED }, 403);
    if (request.method === "GET" && url.pathname === "/admin/preparations")
      return json({
        storage: await readStorage(this.directory).catch(() => ({
          error: "Server disk information is unavailable.",
        })),
        source: this.source,
        sourceBytes: Bun.file(this.sourcePath).size,
        available: availability(this.source),
        atlasSources: this.catalog().map((map) => ({
          id: map.id,
          manifest: map.manifest,
          available: availability(map.manifest!),
          bytes: map.bytes,
        })),
        globalSource: {
          ...WORLD_SOURCE,
          ready: !!Bun.which("osmium") && !!Bun.which("cargo"),
        },
        oceanSource: await configuredOcean()
          .then((v) =>
            v && Bun.which("ogr2ogr") ? { url: v.url, sha256: v.sha256 } : null,
          )
          .catch(() => null),
        routingCompiler: {
          authority: "osm-pbf-sha256",
          contract: OSM_ROUTING_CONTRACT,
          codec: "rcl3",
        },
        cachedSources: await verifiedSources(this.sourceDirectory),
        jobs: [...this.jobs.values()].sort((a, b) =>
          b.createdAt.localeCompare(a.createdAt),
        ),
      });
    if (request.method !== "POST") return json({ error: "Use POST" }, 405);
    if (url.pathname === "/admin/preparations/image") {
      if (
        request.headers.get("Origin") !== url.origin ||
        !request.headers.get("Content-Type")?.startsWith("multipart/form-data;")
      )
        return json({ error: "Same-origin image upload required" }, 403);
      try {
        const bytes = await limitedBody(request, IMAGE_MAX_BYTES + 16384);
        const form = await new Response(bytes, {
          headers: { "Content-Type": request.headers.get("Content-Type")! },
        }).formData();
        const file = form.get("image"),
          recipe = form.get("placement");
        if (
          !(file instanceof File) ||
          typeof recipe !== "string" ||
          recipe.length > 8192
        )
          throw new Error("Provide image and placement fields");
        const placement = JSON.parse(recipe);
        return json(
          await this.createImage(
            new Uint8Array(await file.arrayBuffer()),
            placement,
            placement.allowStorageRisk ?? false,
          ),
          202,
        );
      } catch (e) {
        if (e instanceof StorageWarning)
          return json(
            { error: e.message, storageWarning: e.storageWarning },
            409,
          );
        return json({ error: e instanceof Error ? e.message : String(e) }, 400);
      }
    }

    if (
      request.headers.get("Origin") !== url.origin ||
      request.headers.get("Content-Type") !== "application/json"
    )
      return json({ error: "Same-origin JSON request required" }, 403);
    try {
      const raw = await request.text();
      if (new TextEncoder().encode(raw).length > 16384)
        return json({ error: "Request too large" }, 413);
      const match = url.pathname.match(
        /^\/admin\/preparations\/([a-f0-9-]{36})\/(cancel|resume|delete)$/,
      );
      if (match)
        return json(
          await (match[2] === "resume"
            ? this.resume(match[1]!, JSON.parse(raw).allowStorageRisk ?? false)
            : match[2] === "delete"
              ? this.delete(match[1]!)
              : this.cancel(match[1]!)),
        );
      if (url.pathname === "/admin/preparations/composition")
        return json(await this.createComposition(JSON.parse(raw)), 202);
      if (url.pathname === "/admin/preparations/raster-plan")
        return json(await this.planRasters(JSON.parse(raw)));
      if (url.pathname === "/admin/preparations/raster")
        return json(await this.createRasters(JSON.parse(raw)), 202);
      if (url.pathname === "/admin/preparations/capabilities-plan") {
        const { source, donor, download, ...plan } =
          await this.planCapabilities(JSON.parse(raw));
        return json(plan);
      }
      if (url.pathname === "/admin/preparations/capabilities")
        return json(await this.createCapabilities(JSON.parse(raw)), 202);
      if (url.pathname === "/admin/preparations/serve") {
        const b = JSON.parse(raw);
        return json(await this.setServed(b.id, b.served));
      }
      if (url.pathname === "/admin/preparations/amend-plan")
        return json(await this.planAmendment(JSON.parse(raw)));
      if (url.pathname === "/admin/preparations/amend")
        return json(await this.createAmendment(JSON.parse(raw)), 202);
      if (url.pathname === "/admin/preparations/source-plan")
        return json(await this.sources.plan(JSON.parse(raw)));
      if (url.pathname !== "/admin/preparations")
        return json({ error: "Not found" }, 404);
      return json(await this.create(JSON.parse(raw)), 202);
    } catch (e) {
      if (e instanceof StorageWarning)
        return json(
          { error: e.message, storageWarning: e.storageWarning },
          409,
        );
      return json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  }
  async close() {
    this.closing = true;
    clearTimeout(this.retryTimer);
    await this.dispatching;
    if (this.active) await this.cancel(this.active);
    await this.worker?.exited;
    if (this.settling) await this.settling;
    await this.writes;
  }
}

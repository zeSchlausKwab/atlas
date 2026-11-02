import { Database } from "bun:sqlite";
import { join } from "node:path";
import { stat } from "node:fs/promises";
import type { PreparationJob } from "./preparations";
import { ProgressRate } from "../../packages/provisioning/src/compiler-progress";
import type { CompilerObservation } from "../../packages/provisioning/src/compiler-observation";
/** Read-only observer for a compiler already running without structured stage events. */
export class CompilerObserver {
  private rate = new ProgressRate();
  private objectTotal = 0;
  private observedStage = "";
  private observedSince = Date.now();
  private sourceIdentity = "";
  private featureTotal = 0;
  private cursor = -1;
  private scanned = 0;
  private query<T>(
    path: string,
    sql: string,
    args: (string | number)[] = [],
  ): T | undefined {
    let db: Database | undefined;
    try {
      // Never create a missing DB, recover journals, or hold a connection between samples.
      db = new Database(path, { readonly: true });
      db.run(
        "PRAGMA query_only=ON; PRAGMA busy_timeout=50; PRAGMA cache_size=-4096; PRAGMA mmap_size=0;",
      );
      return db.query(sql).get(...args) as T;
    } catch {
      return undefined;
    } finally {
      db?.close();
    }
  }
  async sample(
    job: PreparationJob,
    directory: string,
  ): Promise<CompilerObservation | undefined> {
    if (!job.cachedSource || !["running", "cancelling"].includes(job.state))
      return;
    const work = job.workspace?.work ?? join(directory, `${job.id}.work`),
      compiler = join(work, "compiler");
    const checkpoint = await Bun.file(join(compiler, "partitioned.json"))
      .json()
      .catch(() => undefined);
    if (!checkpoint) return;
    const completed = checkpoint.completed as Record<
      string,
      { size: number; sha256: string }
    >;
    const sourceKey =
      completed["source-v4.sqlite"] ||
      (await Bun.file(join(compiler, "source-v4.sqlite")).exists())
        ? "source-v4.sqlite"
        : completed["source-v3.sqlite"] ||
            (await Bun.file(join(compiler, "source-v3.sqlite")).exists())
          ? "source-v3.sqlite"
          : "source.sqlite";
    const hasSem =
      job.selection.featureKinds.length ||
      job.selection.search ||
      job.selection.reverse ||
      job.selection.placeNames ||
      job.selection.streetNames ||
      job.selection.pois ||
      job.selection.peaks;
    const artifacts = [
      ...(job.selection.profiles.length
        ? [{ key: "transport.atlas", label: "Routing graphs" }]
        : []),
      ...(hasSem || job.selection.layers.length
        ? [{ key: sourceKey, label: "Source geometry" }]
        : []),
      ...(hasSem
        ? [
            {
              key: "semantics.atlas",
              label: "Search, labels & selectable features",
            },
          ]
        : []),
      ...(job.selection.layers.length
        ? [{ key: "display.atlas", label: "Display tiles" }]
        : []),
      { key: "final", label: "Assembly & verification" },
    ];
    const derivedComplete =
      (!hasSem || !!completed["semantics.atlas"]) &&
      (!job.selection.layers.length || !!completed["display.atlas"]);
    let activeSeen = false;
    const stages: CompilerObservation["stages"] = [
      { label: "PBF extraction", state: "done" },
      ...artifacts.map((a) => {
        const done =
          !!completed[a.key] || (a.key === sourceKey && derivedComplete);
        const state = done ? "done" : activeSeen ? "pending" : "active";
        if (!done) activeSeen = true;
        return {
          label: a.label,
          state,
        } as CompilerObservation["stages"][number];
      }),
    ];
    const progress = { ...job.progress };
    progress.writtenBytes =
      job.progress.writtenBytes +
      Object.values(completed).reduce((n, c) => n + c.size, 0);
    const dbPath = join(compiler, sourceKey);
    const identity = completed[sourceKey]?.sha256;
    if (
      identity &&
      identity !== this.sourceIdentity &&
      /^(Semantic source objects:|Display batch)/.test(progress.message)
    ) {
      const total = this.query<{ n: number }>(
        dbPath,
        "SELECT count(*) AS n FROM features",
      );
      if (total) {
        this.sourceIdentity = identity;
        this.featureTotal = total.n;
      }
    }
    // New compilers report more precise sub-stages themselves.
    if (!progress.stage) {
      const features = progress.message.match(
        /^Semantic source objects: (\d+)$/,
      );
      const display = progress.message.match(
        /^Display batch \d+ saved \(source cursor (\d+)\)$/,
      );
      const packing = progress.message.match(
        /^Packing source objects · (\d+) objects$/,
      );
      let done: number | undefined,
        total = this.featureTotal,
        stage = "";
      if (packing && !completed["semantics.atlas"]) {
        if (!this.objectTotal) {
          const count = this.query<{ n: number }>(
            join(compiler, sourceKey + ".objects-index.sqlite"),
            "SELECT count(*) AS n FROM records",
          );
          if (count) this.objectTotal = count.n;
        }
        done = Number(packing[1]);
        total = this.objectTotal;
        stage = "semantic-object-packing";
        progress.message = "Packing source objects";
      } else if (features && !completed["semantics.atlas"]) {
        done = Number(features[1]);
        stage = "semantic-features";
        const cursor = this.query<{ value: string }>(
          join(compiler, "objects.sqlite"),
          "SELECT value FROM state WHERE key='cursor'",
        );
        if (cursor && Number(cursor.value) >= total && total > 0) {
          done = undefined;
          stage = "semantic-finalization";
          progress.message =
            "Finalizing search indexes and packing semantic data";
        } else
          progress.message = "Building search, labels and selectable features";
      } else if (display && !completed["display.atlas"]) {
        const cursor = Number(display[1]);
        if (cursor !== this.cursor) {
          const cell = Math.floor(cursor / 2 ** 32),
            rowid = cursor % 2 ** 32;
          const incremental = this.cursor >= 0 && cursor > this.cursor;
          const previousCell = Math.floor(this.cursor / 2 ** 32),
            previousRow = this.cursor % 2 ** 32;
          const count = this.query<{ n: number }>(
            dbPath,
            "SELECT count(*) AS n FROM features WHERE (cell<? OR (cell=? AND rowid<=?))" +
              (incremental ? " AND (cell>? OR (cell=? AND rowid>?))" : ""),
            [
              cell,
              cell,
              rowid,
              ...(incremental ? [previousCell, previousCell, previousRow] : []),
            ],
          );
          if (count) {
            this.scanned = (incremental ? this.scanned : 0) + count.n;
            this.cursor = cursor;
          }
        }
        if (cursor === this.cursor) done = this.scanned;
        stage = "display-geometry";
        progress.message =
          "Generating display tiles (completed source batches)";
      } else {
        stage = derivedComplete
          ? "assembly"
          : !completed[sourceKey]
            ? "source-geometry"
            : completed["semantics.atlas"]
              ? "display-packing"
              : "semantic-finalization";
        // Legacy stages with no measurable denominator remain explicitly indeterminate.
      }
      progress.stage = stage;
      progress.completed = done ?? 0;
      progress.total = done !== undefined && done <= total ? total : 0;
      progress.unit = "objects";
      progress.stagePercent = progress.total
        ? (100 * progress.completed) / progress.total
        : undefined;
      progress.etaSeconds = progress.total
        ? this.rate.estimate(stage, progress.completed, progress.total)
        : undefined;
    }
    if (!progress.checkpointAt) {
      const checkpointStat = await stat(
        join(compiler, "partitioned.json"),
      ).catch(() => undefined);
      if (checkpointStat)
        progress.checkpointAt = checkpointStat.mtime.toISOString();
    }
    if (this.observedStage !== progress.stage) {
      this.observedStage = progress.stage ?? "";
      this.observedSince = Date.now();
    }
    return {
      observedElapsedSeconds: (Date.now() - this.observedSince) / 1000,
      id: job.id,
      createdAt: job.createdAt,
      observedAt: new Date().toISOString(),
      progress,
      stages,
    };
  }
}

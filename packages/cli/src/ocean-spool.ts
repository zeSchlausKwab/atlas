import type { Manifest } from "../../format/src/index";
import type { PreparedOcean } from "../../provisioning/src/ocean-source";
import { oceanTiles } from "./ocean-tiles";
import { BlockSpool } from "./block-spool";
/** Append sea fragments in durable batches. Restart replays deterministic traversal, skipping committed tiles. */
export async function appendOcean(
  spool: BlockSpool,
  ocean: PreparedOcean,
  manifest: Pick<Manifest, "bounds" | "minZoom" | "maxZoom" | "selection">,
  signal: AbortSignal,
  progress: (s: string) => void,
  batchSize = 10000,
) {
  const get = (key: string) =>
    spool.db
      .query<{ value: string }, [string]>("SELECT value FROM state WHERE key=?")
      .get(key)?.value;
  const hash = get("ocean-hash");
  if (hash && hash !== ocean.clipHash)
    throw new Error("Ocean tile checkpoint belongs to another input");
  if (get("ocean-complete")) {
    progress("Reusing completed ocean tiles");
    return;
  }
  const skip = Number(get("ocean-count") ?? 0),
    cursor = spool.cursor;
  let count = 0;
  const save = (complete = false) => {
    const put = spool.db.query("INSERT OR REPLACE INTO state VALUES(?,?)");
    put.run("ocean-hash", ocean.clipHash);
    put.run("ocean-count", String(count));
    if (complete) put.run("ocean-complete", "1");
    spool.checkpoint(cursor);
  };
  spool.begin();
  try {
    if (ocean.data.features.length)
      await oceanTiles(ocean.data, manifest, signal, async (tile) => {
        if (++count > skip) spool.add(tile.key, tile.bytes);
        if (count % batchSize === 0) {
          if (count > skip) {
            save();
            spool.begin();
          }
          progress(
            `Ocean display: ${count.toLocaleString("en-US")} tiles${count <= skip ? " replayed from checkpoint" : " prepared"}`,
          );
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
      });
    signal.throwIfAborted();
    save(true);
  } catch (e) {
    spool.db.run("ROLLBACK");
    throw e;
  }
}

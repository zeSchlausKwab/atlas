import { serveWorker } from "../../compiler/src/process-pool";
import { renderTileBatch } from "./tile-batch";
import { BlockSpool } from "./block-spool";
import type { Feature } from "geojson";
import type { PackageSelection } from "../../provisioning/src/selection";
export interface TileTask {
  input: string;
  output: string;
  selection: PackageSelection;
  cursor: number;
  scanned: number;
}
serveWorker<TileTask, null>(async (task) => {
  const features: Feature[] = await Bun.file(task.input).json();
  const spool = new BlockSpool(task.output, "parallel-tile-batch-v1");
  let bytes = 0,
    fragments = 0;
  try {
    spool.begin();
    renderTileBatch(
      features,
      task.selection,
      new AbortController().signal,
      (key, data) => {
        bytes += data.length;
        if (bytes > 256 * 1024 ** 2 || ++fragments > 200000)
          throw new Error(
            "Tile batch exceeds parallel scratch budget; reduce area complexity",
          );
        spool.add(key, data);
      },
    );
    spool.checkpoint(task.cursor);
  } finally {
    spool.close();
  }
  return null;
});

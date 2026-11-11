import { AtlasReader } from "../../../packages/format/src/reader";
import { HashtreeSource } from "../../../packages/hashtree/src/source";
import { AtlasMap } from "../../../packages/renderer/src/map";
import init from "../../../packages/renderer/pkg/atlas_renderer";
import wasm from "atlas-renderer-wasm";

declare const AtlasResources: {
  blob(json: string): boolean;
  report(json: string): void;
};
const host = window as any;
let sequence = 0,
  generation = 0,
  map: AtlasMap | undefined,
  reader: AtlasReader | undefined;
const waiting = new Map<
  number,
  {
    resolve: (data: Uint8Array) => void;
    reject: (e: Error) => void;
    clean: () => void;
  }
>();
const status = document.getElementById("status")!;
function error(message: string) {
  status.textContent = message;
  AtlasResources.report(JSON.stringify({ error: message.slice(0, 2000) }));
}
function close() {
  generation++;
  map?.destroy();
  reader?.dispose();
  map = undefined;
  reader = undefined;
  for (const p of waiting.values()) {
    p.clean();
    p.reject(new Error("Native session closed"));
  }
  waiting.clear();
}
host.atlasResponse = (event: any) => {
  const p = waiting.get(event.id);
  if (!p) return;
  waiting.delete(event.id);
  p.clean();
  if (event.error) p.reject(new Error(event.error));
  else p.resolve(Uint8Array.from(atob(event.data), (c) => c.charCodeAt(0)));
};
function blob(
  root: string,
  hash: string,
  signal: AbortSignal,
): Promise<Uint8Array> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    const abort = () => {
      waiting.delete(id);
      reject(new DOMException("Read cancelled", "AbortError"));
    };
    waiting.set(id, {
      resolve,
      reject,
      clean: () => signal.removeEventListener("abort", abort),
    });
    signal.addEventListener("abort", abort, { once: true });
    if (!AtlasResources.blob(JSON.stringify({ id, root, hash }))) {
      waiting.delete(id);
      signal.removeEventListener("abort", abort);
      reject(
        new Error("Native resource queue unavailable. Reconnect in Android."),
      );
    }
  });
}
host.openAtlas = async (offer: any) => {
  close();
  const run = generation;
  status.textContent = "Opening verified Atlas directory…";
  try {
    await init({
      module_or_path: Uint8Array.from(atob(wasm), (c) => c.charCodeAt(0)),
    });
    if (run !== generation) return;
    const source = new HashtreeSource(
      `htree://${offer.hashtree.root}`,
      offer.hashtree,
      undefined,
      {
        allowHttpFallback: false,
        requestTimeoutMs: 120000,
        memoryBytes: 8 * 1024 ** 2,
        fetchBlob: (hash, signal) => blob(offer.hashtree.root, hash, signal),
      },
    );
    const current = new AtlasReader(source, undefined, {
      purposes: ["map"],
      directoryBudget: 4 * 1024 ** 2,
    });
    reader = current;
    await current.open();
    if (run !== generation) {
      current.dispose();
      return;
    }
    if (current.index.manifest.snapshot !== offer.manifest.snapshot)
      throw new Error(
        "Signed map snapshot does not match the verified Atlas manifest",
      );
    const created = await AtlasMap.create(
      document.getElementById("map") as HTMLCanvasElement,
      current,
      (s) => {
        if (run !== generation) return;
        status.textContent = `${offer.manifest.name} · z${s.zoom.toFixed(1)} · ${s.tiles}/${s.wanted} tiles${s.loading ? " · loading…" : " · ready"}`;
        AtlasResources.report(
          JSON.stringify({
            zoom: s.zoom,
            tiles: s.tiles,
            wanted: s.wanted,
            triangles: s.triangles,
            loading: s.loading,
            center: map?.camera.center,
          }),
        );
      },
      (message) => {
        if (run === generation) error(message);
      },
      {
        placeNames: false,
        streetNames: false,
        pois: false,
        cacheBudgets: { meshes: 48 * 1024 ** 2, labels: 1024 ** 2 },
      },
    );
    if (run !== generation) {
      created.destroy();
      return;
    }
    map = created;
  } catch (e) {
    if (run === generation) error(String(e));
  }
};
host.closeAtlas = () => {
  close();
  status.textContent = "Disconnected · reconnect in Android to load map data";
};
document.getElementById("plus")!.onclick = () => map?.zoomBy(1);
document.getElementById("minus")!.onclick = () => map?.zoomBy(-1);
document.getElementById("fit")!.onclick = () => map?.fit();
window.addEventListener("pagehide", close, { once: true });

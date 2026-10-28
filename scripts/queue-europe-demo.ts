#!/usr/bin/env bun
/** Run on the host (or from an authorized admin client). Defaults to a reviewable dry run. */
import { dirname } from "node:path";
import { mkdir, rename } from "node:fs/promises";
import { MAP_LAYERS, TRANSPORT_MODES } from "../packages/format/src/index";
import { FEATURE_KINDS } from "../packages/features/src/index";
import recipe from "../recipes/europe-three-map-demo.json";
const args = process.argv.slice(2),
  queue = args.includes("--queue");
const option = (name: string, fallback: string) =>
  args.find((a) => a.startsWith(name + "="))?.slice(name.length + 1) ??
  fallback;
const base = new URL(option("--server", "http://127.0.0.1:3100"));
const receiptPath = option("--receipt", "data/europe-three-map-receipt.json");
const east = Number(option("--east", "27"));
if (!Number.isFinite(east) || east < 20 || east > 35)
  throw new Error(
    "Eastern edge must be 20–35°E and include the two child regions",
  );
const request = async (path: string, body?: unknown) => {
  const response = await fetch(new URL(path, base), {
    method: body ? "POST" : "GET",
    headers: body
      ? { Origin: base.origin, "Content-Type": "application/json" }
      : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json();
  if (!response.ok) throw new Error(JSON.stringify(data));
  return data;
};
const config = await request("/admin/preparations");
const source = config.cachedSources.find((s: any) => s.kind === "planet");
if (!source) throw new Error("Register a verified cached planet first");
if (!config.oceanSource)
  throw new Error(
    "Configure the verified assembled ocean source and GDAL first",
  );
const receipt: {
  version: number;
  source: string;
  easternEdge: number;
  jobs: Record<string, string>;
} = (await Bun.file(receiptPath).exists())
  ? await Bun.file(receiptPath).json()
  : { version: 1, source: source.id, easternEdge: east, jobs: {} };
if (receipt.source !== source.id || receipt.easternEdge !== east)
  throw new Error(
    "Receipt belongs to another source or area; choose a new receipt path",
  );
const save = async () => {
  await mkdir(dirname(receiptPath), { recursive: true });
  await Bun.write(receiptPath + ".tmp", JSON.stringify(receipt, null, 2));
  await rename(receiptPath + ".tmp", receiptPath);
};
for (const map of recipe.maps) {
  if (receipt.jobs[map.key]) {
    console.log(`${map.key}: already submitted (${receipt.jobs[map.key]})`);
    continue;
  }
  const [w, s, e, n] = map.key === "western" ? [-15, 34, east, 65] : map.bounds;
  const parentId = map.parent ? receipt.jobs[map.parent] : undefined;
  const selection = {
    name: map.name,
    snapshot: map.parent
      ? `pending:${parentId ?? map.parent}`
      : config.globalSource.snapshot,
    polygon: [
      [w, s],
      [e, s],
      [e, n],
      [w, n],
    ],
    minZoom: 0,
    maxZoom: 16,
    layers: [...MAP_LAYERS],
    profiles: [...TRANSPORT_MODES],
    featureKinds: [...FEATURE_KINDS],
    placeNames: true,
    streetNames: true,
    pois: true,
    search: true,
    reverse: true,
    peaks: true,
    paddingCells: 2,
    maxBytes: map.maxBytes,
    ...(map.parent
      ? { sourceAtlasId: parentId ?? map.parent }
      : {
          cachedSourceId: source.id,
          ocean: { sha256: config.oceanSource.sha256 },
        }),
  };
  if (!queue) {
    console.log(JSON.stringify({ ...map, selection }, null, 2));
    continue;
  }
  if (map.parent && !parentId) throw new Error("Parent was not queued");
  const job = await request("/admin/preparations", selection);
  receipt.jobs[map.key] = job.id;
  await save();
  console.log(
    JSON.stringify({
      key: map.key,
      id: job.id,
      state: job.state,
      message: job.progress.message,
    }),
  );
}
console.log(
  queue
    ? `Queue receipt saved to ${receiptPath}. Inspect /host for progress; only one compiler runs at a time.`
    : "Dry run only. Add --queue to submit the three persistent builds.",
);

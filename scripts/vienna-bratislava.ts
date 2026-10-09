/** Prepare adjacent full-capability excerpts without recompiling their shared graph.
 * Reuses matching completed jobs; writes a browser-consumable recipe on success.
 * Removal of older hosted maps is deliberately a separate library operation. */
import type { PackageSelection } from "../packages/provisioning/src/selection";
import type { PreparationJob } from "../apps/server/preparations";
const host = process.env.ATLAS_HOST ?? "http://127.0.0.1:3100";
const catalog = await fetch(host + "/admin/preparations").then((r) => r.json());
const source = catalog.source;
const recipes = [
  { name: "Vienna · full capabilities", bounds: [16.14, 47.94, 16.86, 48.39] },
  {
    name: "Bratislava · full capabilities",
    bounds: [16.8, 47.94, 17.35, 48.39],
  },
];
const prepared: PreparationJob[] = [];
for (const recipe of recipes) {
  const [w, s, e, n] = recipe.bounds as [number, number, number, number];
  const selection: PackageSelection = {
    snapshot: source.snapshot,
    name: recipe.name,
    polygon: [
      [w, s],
      [e, s],
      [e, n],
      [w, n],
    ],
    minZoom: 0,
    maxZoom: 16,
    layers: catalog.available.layers,
    placeNames: true,
    streetNames: true,
    pois: true,
    profiles: ["walking", "cycling", "driving"],
    search: true,
    reverse: true,
    peaks: true,
    featureKinds: catalog.available.featureKinds,
    paddingCells: 2,
    maxBytes: 1024 * 1024 * 1024,
  };
  let job = catalog.jobs.find(
    (j: PreparationJob) =>
      j.state === "ready" &&
      j.manifest?.transport?.graphSnapshot === source.snapshot &&
      JSON.stringify(j.selection) === JSON.stringify(selection),
  ) as PreparationJob | undefined;
  if (!job) {
    const r = await fetch(host + "/admin/preparations", {
      method: "POST",
      headers: { Origin: host, "Content-Type": "application/json" },
      body: JSON.stringify(selection),
    });
    if (!r.ok) throw new Error(await r.text());
    job = await r.json();
  }
  let progress = "";
  while (job!.state !== "ready") {
    if (["failed", "cancelled"].includes(job!.state))
      throw new Error(job!.error ?? "Preparation failed");
    const summary = `${job!.name}: ${job!.progress.phase} ${job!.progress.completed}/${job!.progress.total} · ${(job!.progress.writtenBytes / 1048576).toFixed(1)} MiB`;
    if (summary !== progress) {
      console.log(summary);
      progress = summary;
    }
    await Bun.sleep(1500);
    const state = await fetch(host + "/admin/preparations").then((r) =>
      r.json(),
    );
    job = state.jobs.find((j: PreparationJob) => j.id === job!.id);
  }
  prepared.push(job!);
  console.log(`${job!.name}: ready (${(job!.size! / 1048576).toFixed(2)} MiB)`);
}
const recipe = {
  version: 1,
  catalogs: [host + "/catalog"],
  sources: prepared.map((j) => ({
    url: `${host}/maps/${j.id}.atlas`,
    enabled: true,
    layers: j.manifest!.tileLayers,
    labels: true,
  })),
  style: "paper",
  coverage: true,
};
await Bun.write(
  new URL("../data/vienna-bratislava.json", import.meta.url),
  JSON.stringify(
    {
      sourceSnapshot: source.snapshot,
      jobs: prepared.map((j) => ({ id: j.id, name: j.name, bytes: j.size })),
      composition: recipe,
    },
    null,
    2,
  ),
);
console.log(
  `${host}/compose#view=${encodeURIComponent(JSON.stringify(recipe))}`,
);

# Three-map demo

## Current recipe: North Sea and Lower Rhine (2 November 2026)

`recipes/north-sea-demo.json` replaces the oversized Western Europe / Rhine–Alps /
Alps–Danube experiment for this machine. The goal is three working, independently
compiled packages, not a 200 GB output target. Geographic extent is reduced;
capabilities are retained.

| Build order | Map              | Bounds W/S/E/N        | Demo                                                     |
| ----------- | ---------------- | --------------------- | -------------------------------------------------------- |
| 1           | Lower Rhine West | 3 / 50.5 / 5.7 / 53.8 | Rotterdam, Antwerp, Eindhoven, coast                     |
| 2           | Lower Rhine East | 5.3 / 50.5 / 8 / 53.8 | Lower Rhine, Ruhr, Düsseldorf, northern coast            |
| 3           | North Sea        | −5.5 / 50 / 10.5 / 55 | Southern Britain, Benelux, northern Germany and open sea |

The smaller pair overlaps between 5.3–5.7°E. Both lie inside the large map.
Disable the large map when demonstrating cross-source operations. Every file is
built independently from the same verified planet PBF with OSM-authoritative
routing IDs; no build depends on another Atlas file finishing.

All retain z0–16 geometry, building heights, labels, walking/cycling/driving,
isochrones, address/location search, nearest-street lookup, peak queries, selectable
features, administrative/national boundaries, generic tags and relation members.
Assembled sea polygons are explicitly enabled, using a separately pinned coastline
snapshot. These are the implemented capabilities, not a claim that OSM contains
complete addresses, all relations, bathymetry or a global shipping network.

## Storage and build placement

The failed Rhine–Alps run had an 11 GiB regional PBF and a 131 GiB source database.
Final archive size is a poor predictor of peak scratch space. Never admit several
large SQLite builds just because their final files might fit.

Run the three preparations sequentially. Use the tested NAS working folder for
extracts and intermediate archives; writable SQLite/native coordinate stores and
finished files remain on the SSD. A job pins its workspace when it is queued:
changing the Storage policy later does not move existing work. For these demos,
select **Always use this working folder** while queuing, then restore the previous
policy if desired. Runtime checks retain 10 GiB plus a 2 GiB stopping margin.
There is no fixed output-size cap in the reduced recipe.

The superseded three build workspaces, including Western Europe's parked NAS
checkpoint, were deleted with user approval on 2 November. Small diagnostic job
records remain in `/home/nixuser/atlas/shared/retired-builds-20261102/`.
The planet, assembled coastline input and three finished satellite packages remain.
Cleanup left approximately 345 GiB available on the SSD.

## Preflight, queue and recovery

Run inside a configured server release. Preflight uses the real assembled coastline
source and production tile encoding at z8,10,12,14,16. It checks open sea and land
in all three regions and the previously missing sea around Madeira. It only visits
sample tiles, so it does not generate the entire z16 ocean pyramid.

```sh
ATLAS_OCEAN_SOURCE=/path/to/water-polygons.zip bun scripts/preflight-demo-water.ts /path/to/preflight
bun scripts/queue-europe-demo.ts --recipe=north-sea --server=http://127.0.0.1:3100
bun scripts/queue-europe-demo.ts --recipe=north-sea --server=http://127.0.0.1:3100 --queue --receipt=/path/to/north-sea-receipt.json
```

The first queue command is a dry run. Receipts prevent duplicate submissions and
pin the source hash and exact recipe. `--only=lower-rhine-west,lower-rhine-east`
selects just the pair. Jobs survive page closure and server restarts. Completed
checkpoints are reused after recoverable failures; low disk, checksum errors and
corrupt databases require attention. Stopped jobs never restart themselves.
Transient worker failures use the existing bounded automatic retry policy.

The old `--recipe=europe` plan remains available for larger machines, but is not
the current demo or the recommended queue for this server.

## Acceptance after compilation

A preflight pass is not evidence that the finished maps or long routes passed.
Before calling the full demo complete:

- Verify each ready manifest, source authority, all selected capabilities, z0–16
  sample tiles and sea/land probes in the **finished** archive.
- Search named locations and addresses; query administrative polygons, coastlines,
  tagged features and relations away from the viewport.
- With only the smaller pair enabled, route from Eindhoven to Duisburg in walking,
  cycling and driving modes. Verify both source archives were used and overlap
  IDs agree under the OSM routing contract.
- Repeat cached analysis and inspect actual package reads, time and memory.
- Open the large map at the North Sea coast; confirm sea is blue and land/islands
  remain unfilled. Record actual output sizes and peak scratch space.

Madeira's old direct-Geofabrik package contained inland water but no sea polygons.
A water checkbox alone does not synthesize sea from open coastline ways. The host
now distinguishes lakes/rivers from sea fill and explains missing sea input.

## Live rollout — 2 November 2026

Deployed code `f5a63e3` as release
`20261102T075127413Z-f5a63e34f814-20511141` after 397 passing Bun tests and
TypeScript validation. Real-provider preflight passed 50 sea/land checks; report:
`/home/nixuser/atlas/shared/preflight-north-sea-20261102/water-preflight.json`.

Queue receipt: `/home/nixuser/atlas/shared/recipes/north-sea-20261102.json`.

| Order | Key              | Job                                    |
| ----- | ---------------- | -------------------------------------- |
| 1     | lower-rhine-west | `6cd1a246-74a1-4acf-9d9a-312140973039` |
| 2     | lower-rhine-east | `99b22a09-1f7d-41c1-afce-4276e9a2b1d2` |
| 3     | north-sea        | `a4a4a7c9-4b2c-4256-a97d-c935f0fb8c16` |

All three pin NAS-assisted workspaces. The future-job policy was restored to
`when-needed` after queueing. At handoff West was extracting and the others were
queued; compilation and finished-archive/cross-map acceptance are still pending.
No finished-map claim follows from the preflight results.

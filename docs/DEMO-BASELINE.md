# First LAN deployment baseline — 2026-10-10

This is a functional smoke measurement, not a controlled performance benchmark.
The Codex in-app browser on the Mac consumed the HM90S over an SSH localhost tunnel
at `http://127.0.0.1:13100/`. The server used Ethernet only. A candidate native build
ran during part of verification; timings include browser, worker, cache and network
overhead. Client hardware/browser versions and repeated-run distributions were not
recorded, so use these numbers to choose the next investigation, not as a target.

Application revision: `1f66b300a009`. Four selected z0–16 maps: Vienna & Lower
Austria, Bratislava & western Slovakia, Graz & southern Austria, and Győr, Budapest
& western Hungary. Shared graph identity:
`8524975bef1503ef4ebcfdd02db8a9c4eed4158dfabc69436d83aba05128708b`.
The additional Vienna Plus base file is served but not part of this composition.

## Browser observations

The first overview reached 31/31 visible tiles at z7.1, with 5.99 MB of package
reads shown (4.51 MB directory, 1.35 MB geometry, 131.5 KB place names). No routing,
search or query data was read until an operation was requested.

The built-in driving example used Vienna `[16.3696, 48.2027]` and Bratislava
`[17.1128, 48.1452]`. Both runs returned 112.26 km and about 1 h 22 min, with
endpoint snapping offsets of 9 m and 18 m. This confirms execution and replay;
it does not independently validate route optimality or travel-time realism.

| Browser-reported measure | First route | Immediate replay |
| --- | ---: | ---: |
| End-to-end operation time | 27,019 ms | 5,909 ms |
| Reported engine computation | 973 ms | 878 ms |
| Routing bytes read/downloaded | 17.15 MB | 0 MB |
| Routing cells used | 1,366 | 1,366 |
| Cells reused | 0 | 1,366 |
| Nodes explored | 470,897 | 470,897 |
| Estimated engine memory | 183.3 MiB | 183.3 MiB |
| Server operation API responses | 0 | 0 |

Source cell counts were Vienna 436, Graz 404, Hungary 370 and Bratislava 156.
All four sources came from the mini PC; this is not yet a two-physical-host test.
The map showed 36/36 tiles and 208,266 triangles after routing. CPU draw timing in
the UI was below 0.2 ms, which is not a measurement of total frame or GPU time.

## What to investigate next

Separate download scheduling, directory reads, decompression, verification, worker
messages, graph ingestion and search timing. The cold/warm gap points to fetch/cache
work; even the warm path has several seconds outside reported computation. Test
bounded concurrency and adjacent-range coalescing before changing the route's
correctness contract. Inspect why this trip needs 1,366 cells across all four maps.
Retain exact-result/coverage tests while exploring stronger graph preprocessing.

Then capture repeatable cold/warm runs with explicit cache reset, client/device
versions, server resource peaks and fixed viewports. Compare a single-source server
route with the client on the same package and inputs. The existing UI comparison
is not a cross-composition server-routing contract.

## Deployment/generation checks

- Initial upload: five files totaling about 5.57 GiB, plus application code.
- Code-only update: 1,806,700 bytes of files; map inodes, sizes and mtimes unchanged.
- Rollback and restoration both healthy; deliberately invalid candidate rejected
  before activation while the live release stayed healthy.
- Linux fixture compiler produced a 7,108-byte, 11-block Atlas with all three
  transport profiles, selectable source geometry and street indexes.
- Idle Atlas cgroup around 84 MiB; approximately 393.4 GiB server disk available.
- A real `/api/peak` request reported server execution, reading 69,207 source bytes
  in about 48 ms. This validates the deployed operation adapter, not server-routing parity.
- Atlas did not modify the model service or port 8080. A concurrent NixOS change
  replaced llama-cpp with an active `lemond.service` at 09:13:37 CEST.

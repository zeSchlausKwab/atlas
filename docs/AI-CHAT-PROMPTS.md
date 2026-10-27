# Maps as an analysis canvas

Use a neighborhood-sized pinned analysis area initially. These prompts use the
existing local workspace, routing, code and drawing tools. Results depend on the
features retained by the selected Atlas files; missing tags are unknown, not zero.

## Try now

1. **Read the skyline.** “Color buildings by height: under 10 m, 10–20 m, 20–30 m,
   and 30 m or more. Use gray for unknowns. Add a legend with counts and metres.
   Label the five tallest with heights and indicate estimates. Use one colored layer.”
2. **Map what we don't know.** “Using the same cached buildings, divide this area
   into approximately 200 m cells. Color each cell by the share of buildings with
   unknown height. Use building centroids for assignment, label the three highest
   shares, and report empty cells separately. Explain the approximation.”
3. **Compare urban texture.** “Divide the analysis area into east and west halves.
   Compare median known building height and total building footprint area per km².
   Use centroid assignment and explain boundary effects and overlapping footprints.
   Draw both halves, label the results, and preserve unknown-height counts.”
4. **Make the numbers visible.** “Create a 250 m grid and show building counts as
   circles whose area is proportional to count. Label the five busiest cells,
   include a size explanation, and distinguish empty cells from missing coverage.”
5. **Walk versus cycle.** “Find this named address [insert address]. Compare
   10-minute walking and cycling areas in different colors. Add a legend and label
   the origin. Count retained buildings intersecting each area; explain that the
   areas are approximate and the counts overlap.”
6. **A short architecture walk.** “Pick five tall buildings in this area at least
   150 m apart. Draw walking routes between them and numbered stops with a legend
   listing heights and estimate status. Explain the ordering heuristic and any
   guessed centroid-to-street access, rather than claiming an optimal tour.”
7. **Find the compact and the sprawling.** “Rank ten building footprints by area.
   Color them by height source: tagged, levels-estimated or unknown. Label them
   with footprint area in m². Report parts/overlapping footprints as a limitation.”
8. **Inspect the data seam.** “Analyze buildings in a narrow area crossing the two
   map boundaries. Report source coverage and deduplication evidence, draw the
   area and highlight unknown heights. Don't equate a dataset edge with a change
   in the real city.”
9. **Follow up without fetching.** “Keep the geometry. Make the fill 30% opaque,
   enlarge labels to 15 px, and remove labels from all but the highlights. Reuse
   the existing data and report any additional source reads.”

For every demo, export the JSON afterwards. Useful evaluation signals are
correctness of counts, explicit unknowns/coverage, source bytes on cold vs cached
turns, number and duration of tool/model calls, understandable legends, correct
units and whether the claimed drawing matches the exported geometry and style.

## Next tools worth adding

- **Reusable spatial operations:** typed nearest-neighbor, buffer, intersection,
  spatial join and grid aggregation. Cache derived results and their provenance.
  This reduces repeated model-written geometry code and makes distance/area
  semantics consistent, especially at large extents and across map chunks.
- **Linked charts and feature inspection:** histograms, scatterplots and tables
  backed by local result references; brush a chart to highlight matching map
  features. Clicking a feature should reveal its evidence, units and unknowns.
- **Multi-stop routing and entrances:** route matrices, heuristic/optimized stop
  order, entrance-aware access points and explicit duplicate building-part handling.
  These would improve the tallest-buildings tour beyond repeated point-to-point calls.
- **Saved analyses and replay:** import an exported session, restore pinned results
  against verified snapshot IDs, and replay deterministic tool/code steps. Compare
  expected counts, bytes and drawings across compiler, tool and model versions.

These are proposals, not current tools. Population, flood exposure, opening hours
and precise shade analysis need additional data/semantics; a convincing drawing
alone does not establish those facts.

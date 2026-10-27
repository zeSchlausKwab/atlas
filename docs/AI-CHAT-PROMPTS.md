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

## Spatial tools: more than buildings

These prompts now use reusable local spatial tools. Pin a neighborhood first;
select the relevant feature families and retain geometry. Labels/colors can use
cached `run_code` output, while the spatial calculations use the typed tools.

10. **Read the street fabric.** “Clip roads and railways to the analysis area and
    measure their lengths. Show separate linked histograms in metres. Highlight
    the ten longest road segments and label their lengths. Explain OSM segment
    and parallel-track counting.”
11. **Water's neighbors.** “Buffer retained water geometry by 100 m and dissolve
    the buffers. Highlight buildings intersecting that corridor. Draw water in
    blue and nearby buildings in amber, with a legend and counts. This is a
    proximity study, not a flood-risk assessment.”
12. **Railway corridors.** “From the cached railway lines, make 50 m and 200 m
    buffers. Show the inner corridor and outer ring in different colors. Count
    retained buildings intersecting each, distinguishing those touching both.
    This is distance from tracks, not access to a station.”
13. **Café clusters.** “Prepare locations with POI tags and select cafés. Aggregate
    them into approximately 250 m cells and color cells by café count. Include
    empty cells, show a linked bar chart, and label the three busiest cells.
    Do not count address records as POIs.”
14. **A useful nearest-neighbor map.** “For each retained café, find the nearest
    water geometry within 500 m. Show connectors for matches, color cafés by
    distance, and show unmatched cafés in gray. Add a distance histogram. Explain
    that this is straight-line proximity, not a walking route.”
15. **What kinds of green space?** “Inspect the retained land tags, then select
    parks and grass. Clip them to the area, measure and color by category, and
    compare areas in a linked chart. Report missing categories. Distinguish sums
    of overlapping feature areas from a dissolved area.”
16. **Counting inside places.** “Select retained park polygons and café POIs.
    Spatially join them to count cafés inside or touching each park. Label parks
    with counts and show a linked table. Explain overlaps and source coverage.”
17. **Compare length and proximity.** “For the ten longest cached road segments,
    measure representative-point distance to the nearest railway within 500 m.
    Show a linked scatterplot of length versus distance, both in metres. Keep
    unmatched observations separate. Reuse the existing results.”
18. **Footbridges to investigate.** “Inspect road tags for explicitly tagged
    bridges and pedestrian/cycle access near the retained water geometry. Draw
    and label candidates and show their tags in a table. Don't infer that every
    road-water intersection is a bridge or claim access from a missing tag.”
19. **The shape of a cluster.** “Create representative points for retained cafés,
    then draw their convex hull. Compare it with a union of 100 m buffers. Show
    the two areas and explain why neither polygon proves service coverage.”
20. **Explore interactively.** “Show building footprint area versus known height
    in a linked scatterplot. Report unknown heights separately and let me select
    a cluster to highlight it on the map. Keep tagged and estimated heights
    distinguishable.”

Click histogram/category bars, scatterplot points (or drag a rectangle), or table
rows to highlight their cached map features. Under **Drawings → Inspect drawings**,
click a colored geometry to inspect attributes and source evidence. Export JSON
includes the current charts, memberships, selection, inspection and drawings.

See [spatial operation semantics](SPATIAL-ANALYSIS.md) for units and limitations.

## Still proposed

- **Multi-stop routing and entrances:** route matrices, heuristic/optimized stop
  order, entrance-aware access points and explicit duplicate building-part handling.
  These would improve the tallest-buildings tour beyond repeated point-to-point calls.
- **Saved analyses and replay:** import an exported session, restore pinned results
  against verified snapshot IDs, and replay deterministic tool/code steps. Compare
  expected counts, bytes and drawings across compiler, tool and model versions.

The two items above remain proposals. Population, flood exposure, opening hours
and precise shade analysis need additional data/semantics; a convincing drawing
alone does not establish those facts.

## A complete delivery-day exercise

[Vienna delivery day](../examples/delivery/README.md) includes 12 fictional orders,
a depot, time windows, service durations, load limits and a lunch break. Paste
[the ready-made prompt](../examples/delivery/PROMPT.md) to test address geocoding,
stitched routing, scheduling and labeled map visualization. The separate developer
verification file records a feasible tour without giving coordinates to the AI.

## Constructed polygons and continuous fields

Reload the client to receive the new tool catalog. Existing Vienna archives work;
no map redownload is needed. Pin an area within coverage and request padded source
data when comparing proximity near its edges.

- **Danube bank bands:** “Within this analysis area, draw land within 100, 250 and
  500 metres of the mapped Danube banks as three non-overlapping blue bands. Use
  river polygons and exclude water interiors. Clip after buffering and explain
  source coverage. These are proximity zones, not flood risk.”
- **Reusable contours:** “Make a 25 m distance field from these river polygons and
  draw contour lines at 75, 200 and 400 metres. Then reuse the same field for 150,
  350 and 700 metres. Tell me whether the second operation read any map bytes.”
- **Café concentrations:** “Find retained cafés in this neighborhood and its 1 km
  surroundings. Build a density field with 250 m bandwidth and 40 m spacing, then
  show labeled contour bands within the neighborhood. Choose levels from the
  reported range and state the units. This is café density, not popularity.”
- **Railway proximity:** “Draw dissolved 50, 150 and 300 metre bands around retained
  railway lines. Highlight buildings whose footprints intersect the nearest
  band; report unknown heights separately. Do not call this noise exposure.”
- **A corridor through the city:** “Find a walking route between these two resolved
  addresses. Draw a 100 m corridor on either side of its line and highlight parks
  intersecting that corridor. Treat this as straight-line proximity to the route,
  not proof of an entrance or reachable park.”
- **Service-gap exploration:** “Use the retained drinking-water locations to make
  a distance field. Highlight land more than 300 metres from a retained point,
  and compare with a 500 metre threshold using the same field. Distinguish data
  gaps from claims that no drinking water exists.”

## Adjustable analyses on cached data

- “Make an adjustable recipe: highlight buildings within 400 m of mapped park polygons,
  outside a 100 m railway corridor, and within 800 m of retained tram stops. Give me
  sliders for all three distances. Use one combined workspace, buffer individual
  targets, and state the rail classes and boundary coverage used.”
- “Draw Danube bank-distance bands at 100, 250 and 500 m, excluding ALL retained water
  polygons, not only the selected river. Check disjointness, exclusions and clip
  bounds before drawing. Make the outer distance adjustable; label and color the bands.”
- “Color the selected buildings by known/estimated height: below 15 m, 15–30 m and
  at least 30 m. Gray means unknown. Use native thematic styling and show counts.”
- “Create a reusable distance field around retained tram stops. Show bands for
  0–200, 200–400 and 400–800 m and make the outer contour adjustable. Reuse the
  field samples when I change it. Explain why this is not walking accessibility.”

Recipes remain local to the current chat; exported JSON records definitions and run
history. See [Analysis recipes](ANALYSIS-RECIPES.md) for contracts and verification.

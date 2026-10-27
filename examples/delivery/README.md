# Vienna delivery-day exercise

A fictional parcel service, **12 deliveries + one depot**, 28 parcels / 40 kg,
09:00–17:00, a 30-minute lunch break and delivery windows. Orders are deliberately
shuffled. Recipient labels and orders are invented; the street addresses are real
OSM records retained in the rehearsal maps. They do not represent actual customers
or business delivery requests.

## Run it in chat

1. Select **Vienna west · rehearsal** and **Vienna east · rehearsal**. Both already
   advertise `address-search` and `transport-routing`; no rebuilding or full-file
   redownload is necessary. Earlier Vienna/Britain packages may lack addresses.
2. Paste the contents of [PROMPT.md](PROMPT.md) into Atlas chat. It includes the
   complete manifest and instructions for geocoding, routing, scheduling, colors
   and labels. No coordinates or expected ordering are given to the model.
3. Export the conversation JSON for evaluation. A cached rerun should reuse map
   data. Model inference still needs its online connection.

Files:

- [vienna-day.json](vienna-day.json): complete machine-readable exercise.
- [vienna-day.csv](vienna-day.csv): delivery rows; depot/vehicle/break rules are in
  the JSON and prompt, so CSV alone is not the complete problem.
- [verification.json](verification.json): developer answer key containing matched
  OSM records, map snapshots and one feasible reference tour. **Do not paste this
  into the initial model request.**

The reference tour was checked with the real client-side geocoder and WASM cycling
router: **23.75 km**, 86 travel minutes (each leg rounded up), 138 service minutes,
36 waiting minutes and a 30-minute break, returning **13:50**. All 13 route legs
succeeded and graph cells from both maps were used. This proves a feasible plan,
not an optimal one. Different valid plans are welcome.

Cycling is a proxy for a cargo bicycle. Traffic, live road closures, opening hours,
parking and cargo-bike size/access are not modeled. Address anchors are not proof
of a delivery entrance. The AI should report these distinctions.

## Reproduce the check

```sh
bun scripts/verify-delivery-demo.ts
# Or provide your two matching local files:
bun scripts/verify-delivery-demo.ts /path/west.atlas /path/east.atlas
```

Defaults use `data/pair-rehearsal/{west,east}-paged.atlas`. The check uses no model,
API key, online geocoder or remote routing server. It asserts exact street / house
number / postcode matches, capacity, every reference leg, service windows, lunch,
return deadline and use of both routing providers.

## Follow-up prompts

- “D06 now closes at 12:00. Repair the schedule and explain what changed. Reuse
  the geocodes and cached graph; show the before/after totals.”
- “Split the orders between two bicycles, both starting and ending at the depot.
  Keep the time windows and break for each rider. Balance duty time, and report
  how much extra total distance the split costs.”
- “Compare this cycling plan with driving using the driving graph. Keep service
  durations unchanged. Do not infer loading access or live traffic.”
- “Color every stop by schedule slack: time remaining between service completion
  and its deadline. Label the three most fragile stops.”
- “Add 5 minutes to every stop's service duration. Which windows fail, and can a
  revised order recover a feasible day?”

## Routing regression candidates discovered while creating this fixture

The current rehearsal graph returns `no-route` for the cycling legs below even
though both addresses geocode. These are excluded from the main exercise and
retained here for investigation. Do not disguise failures with straight lines.
Root cause is not yet established; inspect snapping, directionality, retained
access and connectivity before attributing them to a map boundary.

| Start | Destination | Observed snapped start way |
| --- | --- | --- |
| Taborstraße 15, 1020 | Schottenring 1, 1010 | `way/1433775032` |
| Währinger Straße 10, 1090 | Josefstädter Straße 26, 1080 | not recorded |

The fixture instead uses **Taborstraße 18** and **Währinger Straße 12**, with
verified incoming and outgoing reference legs. Route-order changes should still
check every new leg. A dedicated route matrix / vehicle-routing solver would be
a useful next tool; the current tools support individual legs and code-based
scheduling/ordering heuristics.

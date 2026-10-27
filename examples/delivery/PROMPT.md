Plan a delivery day using only the selected Vienna west and east rehearsal maps and client-side tools.

Geocode every address in the manifest below, including the depot. Match the street, full house number and postcode; prefer explicit address anchors over POIs sharing the address. Never guess coordinates. If a match is ambiguous, investigate it and report what remains uncertain.

Choose a feasible stop order for one vehicle. Respect capacity, the full service duration inside each delivery window, a 30-minute break between 12:00 and 14:00, and return to the depot by 17:00. Use real cycling routes from the map graph to evaluate each leg, not straight-line distances. You may use run_code for scheduling and an ordering heuristic. Be clear that this is a feasible heuristic plan unless you actually prove optimality.

Draw the routed legs and numbered stops on the map. Color stops by delivery window and label them with their order ID and planned arrival time. Show a table with arrival, waiting, service start/end, travel minutes and distance for every stop, including the break and depot return. Report total route distance, travel time, service time, waiting and any unresolved constraints. Distinguish network travel estimates from live traffic or cargo-bike access checks, which this dataset does not provide. Reuse cached data for revisions.

The orders and recipients are fictional. The addresses are map fixtures, not actual delivery requests. The manifest deliberately contains no coordinates and is not in route order.

```json
{
  "schema": "atlas-delivery-demo-v1",
  "fictional": true,
  "name": "Danube Parcel · Vienna one-day exercise",
  "description": "Fictional orders and recipients at OSM-mapped addresses. Not real delivery requests. No coordinates are supplied.",
  "timezone": "Europe/Vienna",
  "day": "Synthetic weekday; no calendar/opening-hours assumptions",
  "shift": {
    "start": "09:00",
    "end": "17:00"
  },
  "vehicle": {
    "id": "CARGO-01",
    "routingMode": "cycling",
    "capacityKg": 80,
    "capacityPackages": 40,
    "note": "Use the cycling profile as a proxy; cargo dimensions and loading access are not modeled."
  },
  "depot": {
    "id": "DEPOT",
    "address": {
      "street": "Lerchenfelder Straße",
      "houseNumber": "25",
      "postcode": "1070",
      "city": "Wien",
      "country": "AT"
    },
    "returnRequired": true
  },
  "break": {
    "durationMinutes": 30,
    "startNotBefore": "12:00",
    "finishNotAfter": "14:00"
  },
  "rules": {
    "timeWindowMeaning": "Service must start at or after start and finish at or before end.",
    "allPackagesLoadedAtStart": true,
    "allowWaiting": true,
    "geocoding": "Exact street, house number and postcode; prefer an explicit address anchor over a business POI. Report ambiguity and missing addresses.",
    "objective": "Deliver every order within its window and return before shift end; then reduce travel time. Do not claim a proven optimal order."
  },
  "deliveries": [
    {
      "id": "D06",
      "recipient": "Fictional customer D06",
      "address": {
        "street": "Handelskai",
        "houseNumber": "300",
        "postcode": "1020",
        "city": "Wien",
        "country": "AT"
      },
      "timeWindow": {
        "start": "11:00",
        "end": "15:00"
      },
      "serviceMinutes": 20,
      "packages": 5,
      "weightKg": 8.0,
      "notes": "Eastern stop; route across the chunk boundary"
    },
    {
      "id": "D02",
      "recipient": "Fictional customer D02",
      "address": {
        "street": "Lindengasse",
        "houseNumber": "15",
        "postcode": "1070",
        "city": "Wien",
        "country": "AT"
      },
      "timeWindow": {
        "start": "09:00",
        "end": "11:30"
      },
      "serviceMinutes": 8,
      "packages": 1,
      "weightKg": 1.2,
      "notes": "Standard"
    },
    {
      "id": "D11",
      "recipient": "Fictional customer D11",
      "address": {
        "street": "Währinger Straße",
        "houseNumber": "12",
        "postcode": "1090",
        "city": "Wien",
        "country": "AT"
      },
      "timeWindow": {
        "start": "13:00",
        "end": "16:30"
      },
      "serviceMinutes": 15,
      "packages": 3,
      "weightKg": 4.5,
      "notes": "Match the full street and house number"
    },
    {
      "id": "D04",
      "recipient": "Fictional customer D04",
      "address": {
        "street": "Wiedner Hauptstraße",
        "houseNumber": "8-10",
        "postcode": "1040",
        "city": "Wien",
        "country": "AT"
      },
      "timeWindow": {
        "start": "09:00",
        "end": "12:30"
      },
      "serviceMinutes": 15,
      "packages": 4,
      "weightKg": 6.0,
      "notes": "One address range; do not silently change to number 8"
    },
    {
      "id": "D09",
      "recipient": "Fictional customer D09",
      "address": {
        "street": "Taborstraße",
        "houseNumber": "18",
        "postcode": "1020",
        "city": "Wien",
        "country": "AT"
      },
      "timeWindow": {
        "start": "12:00",
        "end": "16:00"
      },
      "serviceMinutes": 10,
      "packages": 2,
      "weightKg": 1.8,
      "notes": "Standard"
    },
    {
      "id": "D01",
      "recipient": "Fictional customer D01",
      "address": {
        "street": "Neubaugasse",
        "houseNumber": "42",
        "postcode": "1070",
        "city": "Wien",
        "country": "AT"
      },
      "timeWindow": {
        "start": "09:00",
        "end": "11:30"
      },
      "serviceMinutes": 12,
      "packages": 3,
      "weightKg": 5.5,
      "notes": "Standard"
    },
    {
      "id": "D12",
      "recipient": "Fictional customer D12",
      "address": {
        "street": "Josefstädter Straße",
        "houseNumber": "26",
        "postcode": "1080",
        "city": "Wien",
        "country": "AT"
      },
      "timeWindow": {
        "start": "13:00",
        "end": "16:30"
      },
      "serviceMinutes": 10,
      "packages": 2,
      "weightKg": 2.1,
      "notes": "Return all undelivered packages to the depot"
    },
    {
      "id": "D07",
      "recipient": "Fictional customer D07",
      "address": {
        "street": "Lassallestraße",
        "houseNumber": "7",
        "postcode": "1020",
        "city": "Wien",
        "country": "AT"
      },
      "timeWindow": {
        "start": "11:00",
        "end": "15:00"
      },
      "serviceMinutes": 8,
      "packages": 1,
      "weightKg": 1.5,
      "notes": "Standard"
    },
    {
      "id": "D03",
      "recipient": "Fictional customer D03",
      "address": {
        "street": "Mariahilfer Straße",
        "houseNumber": "2",
        "postcode": "1070",
        "city": "Wien",
        "country": "AT"
      },
      "timeWindow": {
        "start": "09:00",
        "end": "12:00"
      },
      "serviceMinutes": 10,
      "packages": 2,
      "weightKg": 3.0,
      "notes": "Fragile; allow the full service time"
    },
    {
      "id": "D10",
      "recipient": "Fictional customer D10",
      "address": {
        "street": "Schottenring",
        "houseNumber": "1",
        "postcode": "1010",
        "city": "Wien",
        "country": "AT"
      },
      "timeWindow": {
        "start": "13:00",
        "end": "16:30"
      },
      "serviceMinutes": 8,
      "packages": 1,
      "weightKg": 0.8,
      "notes": "Standard"
    },
    {
      "id": "D05",
      "recipient": "Fictional customer D05",
      "address": {
        "street": "Landstraßer Hauptstraße",
        "houseNumber": "1",
        "postcode": "1030",
        "city": "Wien",
        "country": "AT"
      },
      "timeWindow": {
        "start": "10:00",
        "end": "14:00"
      },
      "serviceMinutes": 10,
      "packages": 2,
      "weightKg": 3.2,
      "notes": "Several POIs share this address; use the address anchor"
    },
    {
      "id": "D08",
      "recipient": "Fictional customer D08",
      "address": {
        "street": "Praterstraße",
        "houseNumber": "20",
        "postcode": "1020",
        "city": "Wien",
        "country": "AT"
      },
      "timeWindow": {
        "start": "12:00",
        "end": "16:00"
      },
      "serviceMinutes": 12,
      "packages": 2,
      "weightKg": 2.4,
      "notes": "Standard"
    }
  ]
}
```

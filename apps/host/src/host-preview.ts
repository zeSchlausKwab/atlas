import {
  Map as LibreMap,
  NavigationControl,
  setWorkerUrl,
  type GeoJSONSource,
  type ImageSource,
} from "maplibre-gl";
import { AtlasMap } from "../../../packages/renderer/src/map";
import { AtlasReader, HttpSource } from "../../../packages/format/src/reader";
import type { Bounds } from "../../../packages/features/src/index";
import type { Position } from "../../../packages/geocoding/src/model";
import type { FeatureCollection } from "geojson";
export interface HostPreview {
  image?(url: string, bounds: Bounds): void;
  selection(points: Position[], closed: boolean): void;
  picking(enabled: boolean): void;
  fit(): void;
  fitArea(bounds: Bounds): void;
  focus(position: Position): void;
  view(): Bounds;
  destroy(): void;
}
const rectangle = (b: Bounds): Position[] => [
  [b[0], b[1]],
  [b[2], b[1]],
  [b[2], b[3]],
  [b[0], b[3]],
];
export async function createPreview(
  container: HTMLElement,
  provider: string,
  bounds: Bounds,
  pick: (p: Position) => void,
  finish: () => void,
  cancel: () => void,
  status: (s: string) => void,
  world = false,
  atlasUrl = "/maps/demo.atlas",
): Promise<HostPreview> {
  container.replaceChildren();
  if (provider === "local") {
    const canvas = document.createElement("canvas");
    canvas.tabIndex = 0;
    canvas.setAttribute("aria-label", "Local Atlas area picker");
    container.append(canvas);
    const reader = await new AtlasReader(new HttpSource(atlasUrl), undefined, {
      purposes: ["map", "labels"],
    }).open();
    const map = await AtlasMap.create(canvas, reader, () => {}, status, {
      pois: false,
      streetNames: false,
    });
    status("Local Atlas preview · uses this host’s map data.");
    return {
      selection: (p, c) => map.setSelection(p, c),
      picking: (on) =>
        on
          ? map.beginPicking(
              "host",
              pick,
              cancel,
              "Click to add a corner",
              finish,
            )
          : map.endPicking("host"),
      fit: () => map.fit(),
      fitArea: () => map.fit(),
      focus: (p) => map.focusLocation(p, "Selected position", 15),
      view: () => map.viewBounds(),
      destroy: () => {
        map.destroy();
        reader.dispose();
      },
    };
  }
  setWorkerUrl("/maplibre/maplibre-gl-worker.mjs");
  const map = new LibreMap({
    container,
    style:
      provider === "blank"
        ? {
            version: 8,
            sources: {},
            layers: [
              {
                id: "background",
                type: "background",
                paint: { "background-color": "#e7e8da" },
              },
            ],
          }
        : "https://tiles.openfreemap.org/styles/liberty",
    center: [(bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2],
    zoom: 9,
    attributionControl: { compact: true },
  });
  map.addControl(new NavigationControl({ showCompass: false }), "top-right");
  map.doubleClickZoom.disable();
  map.getCanvas().setAttribute("aria-label", "OpenFreeMap area picker");
  let overlay: { url: string; bounds: Bounds } | undefined;
  const paintImage = () => {
    if (!overlay || !map.getSource("selection")) return;
    map.setPaintProperty("selection-fill", "fill-opacity", 0);
    const [w, s, e, n] = overlay.bounds;
    const options = {
      url: overlay.url,
      coordinates: [
        [w, n],
        [e, n],
        [e, s],
        [w, s],
      ] as [
        [number, number],
        [number, number],
        [number, number],
        [number, number],
      ],
    };
    const existing = map.getSource("uploaded-image") as ImageSource | undefined;
    if (existing) existing.updateImage(options);
    else {
      map.addSource("uploaded-image", { type: "image", ...options });
      map.addLayer(
        {
          id: "uploaded-image",
          type: "raster",
          source: "uploaded-image",
          paint: { "raster-opacity": 0.7, "raster-fade-duration": 0 },
        },
        "selection-fill",
      );
    }
  };
  let picking = false,
    points: Position[] = [],
    closed = false;
  const collection = (): FeatureCollection => ({
    type: "FeatureCollection",
    features: [
      ...(points.length >= (closed ? 3 : 2)
        ? [
            {
              type: "Feature" as const,
              properties: {},
              geometry: closed
                ? {
                    type: "Polygon" as const,
                    coordinates: [[...points, points[0]!]],
                  }
                : { type: "LineString" as const, coordinates: points },
            },
          ]
        : []),
      ...points.map((p) => ({
        type: "Feature" as const,
        properties: {},
        geometry: { type: "Point" as const, coordinates: p },
      })),
    ],
  });
  const fit = () =>
    world
      ? map.fitBounds(
          [
            [-170, -55],
            [170, 75],
          ],
          { padding: 20, duration: 0 },
        )
      : map.fitBounds(
          [
            [bounds[0], bounds[1]],
            [bounds[2], bounds[3]],
          ],
          { padding: 45, duration: 0 },
        );
  map.on("load", () => {
    if (!world) {
      map.addSource("coverage", {
        type: "geojson",
        data: {
          type: "Feature",
          properties: {},
          geometry: {
            type: "Polygon",
            coordinates: [[...rectangle(bounds), rectangle(bounds)[0]!]],
          },
        },
      });
      map.addLayer({
        id: "coverage-line",
        type: "line",
        source: "coverage",
        paint: {
          "line-color": "#397eaa",
          "line-width": 2,
          "line-dasharray": [3, 2],
        },
      });
    }
    map.addSource("selection", { type: "geojson", data: collection() });
    map.addLayer({
      id: "selection-fill",
      type: "fill",
      source: "selection",
      filter: ["==", ["geometry-type"], "Polygon"],
      paint: { "fill-color": "#cc673d", "fill-opacity": 0.18 },
    });
    map.addLayer({
      id: "selection-line",
      type: "line",
      source: "selection",
      filter: ["!=", ["geometry-type"], "Point"],
      paint: { "line-color": "#b94e29", "line-width": 3 },
    });
    map.addLayer({
      id: "selection-corners",
      type: "circle",
      source: "selection",
      filter: ["==", ["geometry-type"], "Point"],
      paint: {
        "circle-radius": 5,
        "circle-color": "#fff9ed",
        "circle-stroke-color": "#b94e29",
        "circle-stroke-width": 2,
      },
    });
    paintImage();
    status(
      world
        ? "OpenFreeMap preview only · draw your extraction area."
        : "OpenFreeMap preview · blue dashed outline = source coverage.",
    );
  });
  map.on("error", () =>
    status(
      world
        ? "World preview could not load. Retry the preview or use the Britain rectangle."
        : "Preview data could not load. Select the Atlas preview to use this dataset.",
    ),
  );
  map.on("click", (e) => {
    if (picking) pick([e.lngLat.wrap().lng, e.lngLat.lat]);
  });
  const key = (e: KeyboardEvent) => {
    if (!picking) return;
    if (e.key === "Escape") {
      e.preventDefault();
      cancel();
    } else if (e.key === "Enter") {
      e.preventDefault();
      finish();
    } else if (e.key === " ") {
      e.preventDefault();
      const c = map.getCenter();
      pick([c.wrap().lng, c.lat]);
    }
  };
  container.addEventListener("keydown", key);
  fit();
  return {
    image: (url, bounds) => {
      overlay = { url, bounds };
      paintImage();
    },
    selection: (p, c) => {
      points = p;
      closed = c;
      (map.getSource("selection") as GeoJSONSource | undefined)?.setData(
        collection(),
      );
    },
    picking: (on) => {
      picking = on;
      map.getCanvas().style.cursor = on ? "crosshair" : "";
    },
    fit,
    fitArea: (b) => {
      map.fitBounds(
        [
          [b[0], b[1]],
          [b[2], b[3]],
        ],
        { padding: 25, duration: 0 },
      );
    },
    focus: (p) => map.jumpTo({ center: p, zoom: 15 }),
    view: () => {
      const b = map.getBounds();
      return [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
    },
    destroy: () => {
      container.removeEventListener("keydown", key);
      map.remove();
    },
  };
}

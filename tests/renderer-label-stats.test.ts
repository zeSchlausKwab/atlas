import { expect, test } from "bun:test";
import type { AtlasReader } from "../packages/format/src/reader";
import type { Block } from "../packages/format/src/index";
import { MapLabels } from "../packages/renderer/src/labels";
import { PAPER } from "../packages/renderer/src/style";
import type { Camera } from "../packages/renderer/src/camera";
import { PlacesView } from "../packages/labels/src/place-pages";
import { encodePlaces, PLACE_LABEL_KEY } from "../packages/labels/src/places";

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
const camera: Camera = {
  center: [0.5, 0.5], zoom: 13, width: 100, height: 100, pitch: 0, bearing: 0,
};

test("label directory loading and failure stay visible until a successful retry", async () => {
  let pending = Promise.withResolvers<Block[]>();
  let requests = 0;
  const errors: string[] = [];
  const reader = {
    index: { manifest: { labelZoom: 13 }, blocks: [], pages: [{ prefix: "labels/roads/13" }] },
    spatial: () => { requests++; return pending.promise; },
  } as unknown as AtlasReader;
  const labels = new MapLabels(reader, () => {}, (message) => errors.push(message));
  labels.roads = true;
  labels.pois = false;
  const context = { save() {}, restore() {} } as unknown as CanvasRenderingContext2D;
  const draw = () => labels.draw(context, camera, PAPER.labels, []);
  try {
    expect(draw()).toMatchObject({ loading: 1, missing: 0 });
    pending.reject(new Error("TCP/FIPS read timed out"));
    await settle();
    expect(draw()).toMatchObject({ loading: 0, missing: 1 });
    expect(draw()).toMatchObject({ loading: 0, missing: 1 });
    expect(requests).toBe(1);
    expect(errors).toHaveLength(1);

    pending = Promise.withResolvers<Block[]>();
    labels.retry();
    expect(draw().loading).toBe(1);
    pending.resolve([]);
    await settle();
    expect(draw()).toMatchObject({ loading: 0, missing: 0 });
    expect(requests).toBe(2);
  } finally { labels.destroy(); }
});

test("settlement failure reports missing data until a successful retry", async () => {
  let pending = Promise.withResolvers<Uint8Array>();
  let requests = 0;
  const errors: string[] = [];
  const reader = {
    index: { blocks: [{ key: PLACE_LABEL_KEY }], manifest: { places: [] } },
    block: () => { requests++; return pending.promise; },
  } as unknown as AtlasReader;
  const places = new PlacesView(reader, () => {}, (message) => errors.push(message));
  const update = () => places.update([0.49, 0.49, 0.51, 0.51], 7);
  try {
    expect(update()).toEqual([]);
    expect(places.loading).toBe(true);
    pending.reject(new Error("TCP/FIPS read timed out"));
    await settle();
    expect(places.loading).toBe(false);
    expect(places.missing).toBe(true);
    expect(update()).toEqual([]);
    expect(places.missing).toBe(true);
    expect(requests).toBe(1);
    expect(errors).toHaveLength(1);

    pending = Promise.withResolvers<Uint8Array>();
    places.retry();
    update();
    expect(places.loading).toBe(true);
    const values = [{ name: "Recovered", coordinates: [1, 2] as [number, number] }];
    pending.resolve(encodePlaces(values));
    await settle();
    expect(update()).toEqual(values);
    expect(places.loading).toBe(false);
    expect(places.missing).toBe(false);
    expect(requests).toBe(2);
  } finally { places.destroy(); }
});

test("manifest settlement labels are complete without a page request", () => {
  const values = [{ name: "Local", coordinates: [1, 2] as [number, number] }];
  const reader = { index: { blocks: [], manifest: { places: values } } } as unknown as AtlasReader;
  const places = new PlacesView(reader, () => {}, () => {});
  try {
    expect(places.update([0.49, 0.49, 0.51, 0.51], 7)).toEqual(values);
    expect(places.loading).toBe(false);
    expect(places.missing).toBe(false);
  } finally { places.destroy(); }
});

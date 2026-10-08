import { project, unproject } from "../../format/src/index";
export type Point = [number, number];
export interface Camera {
  center: Point;
  zoom: number;
  width: number;
  height: number;
  pitch: number;
  bearing: number;
}
/** Orthographic camera, matching the WASM vertex shader. Bearing is clockwise from north. */
export function groundDelta(
  x: number,
  y: number,
  pitch: number,
  bearing: number,
): Point {
  const r = (bearing * Math.PI) / 180,
    c = Math.cos(r),
    s = Math.sin(r);
  y /= Math.cos((pitch * Math.PI) / 180);
  return [c * x - s * y, s * x + c * y];
}
export function metersPerPixel(camera: Camera) {
  const lat = unproject(...camera.center)[1];
  return (
    (Math.cos((lat * Math.PI) / 180) * 40075016.686) / (256 * 2 ** camera.zoom)
  );
}
export function worldToScreen(
  p: Point,
  camera: Camera,
  heightMeters = 0,
): Point {
  const world = 256 * 2 ** camera.zoom,
    r = (camera.bearing * Math.PI) / 180,
    pitch = (camera.pitch * Math.PI) / 180,
    dx = (p[0] - camera.center[0]) * world,
    dy = (p[1] - camera.center[1]) * world;
  return [
    Math.cos(r) * dx + Math.sin(r) * dy + camera.width / 2,
    (-Math.sin(r) * dx + Math.cos(r) * dy) * Math.cos(pitch) -
      (heightMeters / metersPerPixel(camera)) * Math.sin(pitch) +
      camera.height / 2,
  ];
}
export function screenToWorld(p: Point, camera: Camera): Point {
  const d = groundDelta(
      p[0] - camera.width / 2,
      p[1] - camera.height / 2,
      camera.pitch,
      camera.bearing,
    ),
    world = 256 * 2 ** camera.zoom;
  return [camera.center[0] + d[0] / world, camera.center[1] + d[1] / world];
}
export function projectScreen(p: Point, camera: Camera): Point {
  return worldToScreen(project(...p), camera);
}
export function cameraBounds(
  camera: Camera,
  padding = 0,
): [number, number, number, number] {
  const corners = [
    [-padding, -padding],
    [camera.width + padding, -padding],
    [camera.width + padding, camera.height + padding],
    [-padding, camera.height + padding],
  ].map((p) => screenToWorld(p as Point, camera));
  return [
    Math.min(...corners.map((p) => p[0])),
    Math.min(...corners.map((p) => p[1])),
    Math.max(...corners.map((p) => p[0])),
    Math.max(...corners.map((p) => p[1])),
  ];
}

/** Fit all four ground corners after rotation and tilt, not just the north-up diagonal. */
export function fitZoom(
  bounds: [number, number, number, number],
  width: number,
  height: number,
  pitch: number,
  bearing: number,
): number {
  const [w, n, e, s] = bounds;
  const camera: Camera = {
    center: [(w + e) / 2, (n + s) / 2],
    zoom: 0,
    width: 0,
    height: 0,
    pitch,
    bearing,
  };
  const points = [
    [w, n],
    [e, n],
    [e, s],
    [w, s],
  ].map((p) => worldToScreen(p as Point, camera));
  const dx =
    Math.max(...points.map((p) => p[0])) - Math.min(...points.map((p) => p[0]));
  const dy =
    Math.max(...points.map((p) => p[1])) - Math.min(...points.map((p) => p[1]));
  return Math.log2(
    Math.min(
      Math.max(100, width) / Math.max(dx, 0.00001),
      Math.max(100, height) / Math.max(dy, 0.00001),
    ),
  );
}

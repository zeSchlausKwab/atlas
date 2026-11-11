import { expect, test } from "bun:test";
import { MapInput } from "../packages/renderer/src/input";

function fixture() {
  const canvas = Object.assign(new EventTarget(), {
    focus() {},
    setPointerCapture(_id: number) {},
    getBoundingClientRect: () => ({
      left: 10,
      top: 20,
      width: 400,
      height: 400,
    }),
    clientHeight: 400,
  });
  const pans: number[][] = [],
    zooms: number[][] = [],
    clicks: number[][] = [];
  const input = new MapInput(canvas as unknown as HTMLCanvasElement, {
    pan: (...p) => pans.push(p),
    zoom: (...p) => zooms.push(p),
    click: (...p) => clicks.push(p),
    orbit() {},
    command() {},
  });
  const send = (
    type: string,
    id: number,
    x = 100,
    y = 100,
    pointerType = "touch",
  ) => {
    canvas.dispatchEvent(
      Object.assign(new Event(type, { cancelable: true }), {
        pointerId: id,
        clientX: x,
        clientY: y,
        button: 0,
        pointerType,
      }),
    );
  };
  return { input, send, pans, zooms, clicks };
}

test("pinch zooms around the moving midpoint and resumes pan without a false click", () => {
  const f = fixture();
  f.send("pointerdown", 1, 100, 100);
  f.send("pointerdown", 2, 200, 100);
  f.send("pointermove", 1, 50, 100);
  f.send("pointermove", 2, 250, 100);
  expect(f.zooms.reduce((n, z) => n + z[0]!, 0)).toBeCloseTo(1);
  expect(f.zooms.at(-1)?.slice(1)).toEqual([-60, -120]);
  expect(f.pans).toEqual([
    [-25, 0],
    [25, 0],
  ]);
  f.send("pointerup", 2, 250, 100);
  f.send("lostpointercapture", 2);
  f.send("pointermove", 1, 70, 110);
  f.send("pointerup", 1, 70, 110);
  expect(f.pans.at(-1)).toEqual([20, 10]);
  expect(f.clicks).toHaveLength(0);
  f.input.destroy();
});

test("touch cancellation releases only its pointer; single taps and mouse dragging still work", () => {
  const f = fixture();
  f.send("pointerdown", 1);
  f.send("pointerup", 1);
  expect(f.clicks).toEqual([[90, 80]]);
  f.send("pointerdown", 1);
  f.send("pointerdown", 2, 200, 100);
  f.send("pointercancel", 2);
  f.send("pointermove", 1, 120, 100);
  f.send("pointerup", 1, 120, 100);
  expect(f.clicks).toHaveLength(1);
  expect(f.pans.at(-1)).toEqual([20, 0]);
  f.send("pointerdown", 3, 100, 100, "mouse");
  f.send("pointermove", 3, 115, 130, "mouse");
  f.send("pointerup", 3, 115, 130, "mouse");
  expect(f.pans.at(-1)).toEqual([15, 30]);
  f.input.destroy();
  f.send("pointerdown", 1);
  f.send("pointermove", 1, 300, 300);
  expect(f.pans.at(-1)).toEqual([15, 30]);
});

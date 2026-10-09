export interface InputActions {
  pan(dx: number, dy: number): void;
  orbit(dx: number, dy: number): void;
  zoom(delta: number, x: number, y: number): void;
  click(x: number, y: number): void;
  command(command: "finish" | "choose" | "cancel" | "reset"): void;
}
/** Normalizes pointer, trackpad and keyboard gestures into camera/picking actions. */
export class MapInput {
  private abort = new AbortController();
  private drag?: {
    mode: "pan" | "orbit";
    id: number;
    x: number;
    y: number;
    startX: number;
    startY: number;
    moved: boolean;
  };
  constructor(
    private canvas: HTMLCanvasElement,
    private actions: InputActions,
  ) {
    const options = { signal: this.abort.signal };
    canvas.addEventListener(
      "pointerdown",
      (event) => {
        if (this.drag || ![0, 2].includes(event.button)) return;
        event.preventDefault();
        canvas.focus({ preventScroll: true });
        this.drag = {
          mode:
            event.button === 2 || event.metaKey || event.ctrlKey
              ? "orbit"
              : "pan",
          id: event.pointerId,
          x: event.clientX,
          y: event.clientY,
          startX: event.clientX,
          startY: event.clientY,
          moved: false,
        };
        canvas.setPointerCapture(event.pointerId);
      },
      options,
    );
    canvas.addEventListener(
      "pointermove",
      (event) => {
        const d = this.drag;
        if (!d || d.id !== event.pointerId) return;
        if (Math.hypot(event.clientX - d.startX, event.clientY - d.startY) > 5)
          d.moved = true;
        if (!d.moved) return;
        actions[d.mode](event.clientX - d.x, event.clientY - d.y);
        d.x = event.clientX;
        d.y = event.clientY;
      },
      options,
    );
    canvas.addEventListener(
      "pointerup",
      (event) => {
        const d = this.drag;
        if (!d || d.id !== event.pointerId) return;
        this.drag = undefined;
        if (d.mode === "pan" && !d.moved) {
          const box = canvas.getBoundingClientRect();
          actions.click(event.clientX - box.left, event.clientY - box.top);
        }
      },
      options,
    );
    for (const name of ["pointercancel", "lostpointercapture"])
      canvas.addEventListener(
        name,
        () => {
          this.drag = undefined;
        },
        options,
      );
    canvas.addEventListener("contextmenu", (e) => e.preventDefault(), options);
    canvas.addEventListener(
      "wheel",
      (event) => {
        event.preventDefault();
        const unit =
          event.deltaMode === 1
            ? 16
            : event.deltaMode === 2
              ? canvas.clientHeight
              : 1;
        if (event.metaKey) {
          actions.orbit(event.deltaX * unit, event.deltaY * unit);
          return;
        }
        const box = canvas.getBoundingClientRect();
        actions.zoom(
          -event.deltaY * unit * 0.002,
          event.clientX - box.left - box.width / 2,
          event.clientY - box.top - box.height / 2,
        );
      },
      { ...options, passive: false },
    );
    canvas.addEventListener(
      "keydown",
      (event) => {
        const shifts: Record<string, [number, number]> = {
          ArrowLeft: [-80, 0],
          ArrowRight: [80, 0],
          ArrowUp: [0, -80],
          ArrowDown: [0, 80],
        };
        const commands: Record<
          string,
          "finish" | "choose" | "cancel" | "reset"
        > = {
          Enter: "finish",
          " ": "choose",
          Escape: "cancel",
          r: "reset",
          R: "reset",
        };
        const shift = shifts[event.key],
          command = commands[event.key];
        if (command) {
          event.preventDefault();
          actions.command(command);
        } else if (shift) {
          event.preventDefault();
          if (event.metaKey || event.ctrlKey || event.shiftKey)
            actions.orbit(shift[0] / 4, shift[1] / 4);
          else actions.pan(-shift[0], -shift[1]);
        } else if (["+", "=", "-"].includes(event.key)) {
          event.preventDefault();
          actions.zoom(event.key === "-" ? -1 : 1, 0, 0);
        }
      },
      options,
    );
  }
  destroy() {
    this.abort.abort();
    this.drag = undefined;
  }
}

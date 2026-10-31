import type { WorkspaceMap } from "../../../packages/renderer/src/workspace-map";
import {
  PAPER,
  FLAT_SCENE,
  STYLE_PRESETS,
  parseStyle,
  parseScene,
  type MapStyle,
  type MapScene,
  type PaintClass,
} from "../../../packages/renderer/src/style";
const STORAGE = "atlas-appearance-v1";
const el = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T;
/** One controller survives package changes; appearance never changes data permissions. */
export class StyleControls {
  style: MapStyle = parseStyle(PAPER);
  scene: MapScene = { ...FLAT_SCENE };
  constructor(private readonly map: () => WorkspaceMap | undefined) {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE) ?? "null");
      if (saved) {
        this.style = parseStyle(saved.style);
        // Adopt the slimmer baseline once without losing the saved palette or camera.
        if (saved.roadBaseline !== 2) this.style.widths.roads = 1;
        this.scene = parseScene(saved.scene);
      }
    } catch {
      /* Ignore stale or invalid preferences. */
    }
    for (const button of document.querySelectorAll<HTMLButtonElement>(
      "[data-preset]",
    ))
      button.onclick = () => {
        this.style = parseStyle(STYLE_PRESETS[button.dataset.preset!]!);
        this.apply();
      };
    for (const input of document.querySelectorAll<HTMLInputElement>(
      "[data-color]",
    ))
      input.oninput = () => {
        const key = input.dataset.color!;
        if (key === "background") this.style.background = input.value;
        else if (key === "labelColor") this.style.labels.color = input.value;
        else if (key === "labelHalo") this.style.labels.halo = input.value;
        else this.style.colors[key as PaintClass] = input.value;
        this.style.name = "Custom";
        this.apply();
      };
    for (const input of document.querySelectorAll<HTMLInputElement>(
      "[data-paint]",
    ))
      input.oninput = () => {
        const key = input.dataset.paint!;
        if (key === "labels") this.style.labels.scale = Number(input.value);
        else
          this.style.widths[key as keyof MapStyle["widths"]] = Number(
            input.value,
          );
        this.style.name = "Custom";
        this.apply();
      };
    for (const input of document.querySelectorAll<HTMLInputElement>(
      "[data-scene]",
    ))
      input.oninput = () => {
        this.scene[
          input.dataset.scene as "fallbackHeight" | "heightScale" | "shading"
        ] = Number(input.value);
        this.applyScene();
      };
    el("scene-demo").onclick = () => {
      this.scene = {
        pitch: 52,
        bearing: -25,
        extrude: true,
        fallbackHeight: 12,
        heightScale: 1,
        shading: 0.8,
      };
      const map = this.map();
      if (map) map.zoom = Math.max(map.zoom, 17);
      this.applyScene();
    };
    el("scene-flat").onclick = () => this.reset();
    el("reset-view").onclick = () => this.reset();
    el<HTMLInputElement>("scene-extrude").onchange = (e) => {
      this.scene.extrude = (e.target as HTMLInputElement).checked;
      this.applyScene();
    };
    el("style-export").onclick = () => {
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(this.style, null, 2) + "\n"], {
          type: "application/json",
        }),
      );
      const a = document.createElement("a");
      a.href = url;
      a.download = `atlas-${this.style.name.toLowerCase().replace(/[^a-z0-9-]/g, "-")}.style.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      el("style-status").textContent =
        "Style exported. Data choices and camera stay separate.";
    };
    el("style-import").onclick = () =>
      el<HTMLInputElement>("style-file").click();
    el<HTMLInputElement>("style-file").onchange = async (e) => {
      const input = e.target as HTMLInputElement,
        file = input.files?.[0];
      if (!file) return;
      try {
        if (file.size > 16384)
          throw new Error("Style files must be 16 KB or smaller");
        this.style = parseStyle(JSON.parse(await file.text()));
        this.apply();
        el("style-status").textContent = `Imported ${this.style.name}.`;
      } catch (e) {
        el("style-status").textContent =
          `Could not import: ${e instanceof Error ? e.message : String(e)}`;
      }
      input.value = "";
    };
    this.sync();
  }
  load(style: MapStyle, scene: MapScene) {
    this.style = parseStyle(style);
    this.scene = parseScene(scene);
    this.map()?.setStyle(this.style);
    this.map()?.setScene(this.scene);
    this.save();
    this.sync();
  }
  receiveScene(scene: MapScene) {
    this.scene = parseScene(scene);
    this.save();
    this.sync();
  }
  private reset() {
    this.scene = { ...this.scene, pitch: 0, bearing: 0, extrude: false };
    this.applyScene();
  }
  private save() {
    try {
      localStorage.setItem(
        STORAGE,
        JSON.stringify({
          style: this.style,
          scene: this.scene,
          roadBaseline: 2,
        }),
      );
    } catch {}
  }
  private apply() {
    this.map()?.setStyle(this.style);
    this.save();
    this.sync();
    el("style-status").textContent =
      "Appearance updated · no additional map data requested.";
    document.dispatchEvent(new Event("atlas-view-change"));
  }
  private applyScene() {
    this.map()?.setScene(this.scene);
    this.save();
    this.sync();
    document.dispatchEvent(new Event("atlas-view-change"));
  }
  private sync() {
    for (const b of document.querySelectorAll<HTMLButtonElement>(
      "[data-preset]",
    ))
      b.setAttribute(
        "aria-pressed",
        String(this.style.name === STYLE_PRESETS[b.dataset.preset!]!.name),
      );
    for (const input of document.querySelectorAll<HTMLInputElement>(
      "[data-color]",
    )) {
      const k = input.dataset.color!;
      input.value =
        k === "background"
          ? this.style.background
          : k === "labelColor"
            ? this.style.labels.color
            : k === "labelHalo"
              ? this.style.labels.halo
              : this.style.colors[k as PaintClass];
    }
    for (const input of document.querySelectorAll<HTMLInputElement>(
      "[data-paint]",
    )) {
      const k = input.dataset.paint!,
        value =
          k === "labels"
            ? this.style.labels.scale
            : this.style.widths[k as keyof MapStyle["widths"]];
      input.value = String(value);
      el(`${input.id}-value`).textContent =
        k === "buildingEdges"
          ? `${value.toFixed(1)} px`
          : `${value.toFixed(2)}×`;
    }
    for (const input of document.querySelectorAll<HTMLInputElement>(
      "[data-scene]",
    )) {
      const k = input.dataset.scene as
          | "fallbackHeight"
          | "heightScale"
          | "shading",
        value = this.scene[k];
      input.value = String(value);
      el(`${input.id}-value`).textContent =
        k === "fallbackHeight"
          ? `${value} m`
          : k === "shading"
            ? `${Math.round(value * 100)}%`
            : `${value.toFixed(2)}×`;
    }
    const compass = document.querySelector<HTMLElement>(".compass")!;
    compass.style.transform = `rotate(${-this.scene.bearing}deg)`;
    el<HTMLInputElement>("scene-extrude").checked = this.scene.extrude;
    el("scene-orientation").textContent =
      `${Math.round(this.scene.pitch)}° tilt · ${Math.round(this.scene.bearing)}° bearing`;
    el("scene-badge").hidden = !this.scene.extrude;
    el("reset-view").setAttribute("aria-label", "Reset to top-down, north up");
  }
}

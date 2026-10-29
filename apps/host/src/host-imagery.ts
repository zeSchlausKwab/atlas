import { createPreview, type HostPreview } from "./host-preview";
import {
  IMAGE_MAX_BYTES,
  IMAGE_MAX_PIXELS,
  imageLayout,
  type ImagePlacement,
} from "../../../packages/raster/src/image-plan";
import { confirmStorage } from "./host-storage";
import { storageSize } from "./host-budget";
const el = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(`imagery-${id}`) as T;
const input = (id: string) => el<HTMLInputElement>(id);
export async function startImagery() {
  const section = document.getElementById("imagery") as HTMLDetailsElement;
  let preview: HostPreview | undefined,
    blob: Blob | undefined,
    url: string | undefined,
    width = 0,
    height = 0,
    busy = false,
    loading = false,
    sequence = 0;
  let corner: [number, number] | undefined;
  const bounds = (): ImagePlacement["bounds"] => [
    input("west").valueAsNumber,
    input("south").valueAsNumber,
    input("east").valueAsNumber,
    input("north").valueAsNumber,
  ];
  const setBounds = (b: ImagePlacement["bounds"]) => {
    for (const [i, key] of ["west", "south", "east", "north"].entries())
      input(key).value = String(b[i]);
    update();
  };
  function update() {
    el<HTMLButtonElement>("submit").disabled = true;
    try {
      const b = bounds(),
        layout = imageLayout(width || 1, height || 1, b);
      preview?.selection(
        [
          [b[0], b[1]],
          [b[2], b[1]],
          [b[2], b[3]],
          [b[0], b[3]],
        ],
        true,
      );
      if (url) preview?.image?.(url, b);
      if (blob) {
        el("plan").textContent =
          `${width.toLocaleString()} × ${height.toLocaleString()} pixels · ${storageSize(blob.size)} upload · z0–${layout.maxZoom} · ${layout.tiles.toLocaleString()} tiles. Transparent areas stay transparent.`;
        el<HTMLButtonElement>("submit").disabled = busy || loading;
      }
    } catch (e) {
      el("plan").textContent = String(e);
    }
  }
  const stopPicking = () => {
    corner = undefined;
    preview?.picking(false);
    el("rect").setAttribute("aria-pressed", "false");
  };
  async function showPreview() {
    preview?.destroy();
    preview = undefined;
    const b = bounds();
    try {
      imageLayout(1, 1, b);
      preview = await createPreview(
        el("map"),
        input("provider").value,
        b,
        (p) => {
          if (!corner) {
            corner = p;
            el("pick-status").textContent = "Now click the opposite corner.";
            return;
          }
          setBounds([
            Math.min(corner[0], p[0]),
            Math.min(corner[1], p[1]),
            Math.max(corner[0], p[0]),
            Math.max(corner[1], p[1]),
          ]);
          stopPicking();
          el("pick-status").textContent =
            "Image rectangle set. Refine the coordinates or draw again.";
        },
        stopPicking,
        stopPicking,
        (status) => {
          el("preview-status").textContent =
            input("provider").value === "blank"
              ? "Plain background · no external map requests."
              : status.includes("could not load")
                ? "Preview unavailable. Switch to Plain background to position the image without external map tiles."
                : "OpenFreeMap background is a placement guide; it is not included in your archive.";
        },
      );
      update();
    } catch (e) {
      el("preview-status").textContent = String(e);
    }
  }
  // Use the installed map as an initial placement guide, without changing its source or selection.
  try {
    const response = await fetch("/admin/preparations");
    if (!response.ok) throw new Error("Could not read installed map");
    setBounds((await response.json()).source.bounds);
  } catch {
    setBounds([16.3, 48.16, 16.44, 48.26]);
  }
  section.ontoggle = () => {
    if (section.open && !preview) void showPreview();
  };
  for (const link of document.querySelectorAll<HTMLAnchorElement>(
    'a[href="#imagery"]',
  ))
    link.onclick = () => {
      section.open = true;
    };
  if (location.hash === "#imagery") section.open = true;
  input("provider").onchange = () => void showPreview();
  el("rect").onclick = () => {
    corner = undefined;
    preview?.picking(true);
    el("rect").setAttribute("aria-pressed", "true");
    el("pick-status").textContent =
      "Click the first corner. Escape cancels drawing.";
  };
  el("view").onclick = () => {
    if (preview) {
      stopPicking();
      setBounds(preview.view());
    }
  };
  el("fit").onclick = () => {
    try {
      imageLayout(1, 1, bounds());
      preview?.fitArea(bounds());
    } catch (e) {
      el("message").textContent = String(e);
    }
  };
  el("form").addEventListener("input", update);
  input("file").onchange = async () => {
    const current = ++sequence;
    loading = true;
    blob = undefined;
    update();
    const file = input("file").files?.[0];
    if (!file) {
      loading = false;
      return;
    }
    let bitmap: ImageBitmap | undefined;
    try {
      if (
        !["image/png", "image/jpeg"].includes(file.type) ||
        file.size > IMAGE_MAX_BYTES
      )
        throw new Error("Choose a PNG or JPEG of at most 64 MiB.");
      el("message").textContent = "Reading and orienting image…";
      bitmap = await createImageBitmap(file, {
        imageOrientation: "from-image",
      });
      if (bitmap.width * bitmap.height > IMAGE_MAX_PIXELS)
        throw new Error("Crop or resize this image to at most 32 megapixels.");
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      canvas.getContext("2d")!.drawImage(bitmap, 0, 0);
      const normalized = await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob(
          (b) =>
            b ? resolve(b) : reject(new Error("Image conversion failed")),
          "image/png",
        ),
      );
      if (normalized.size > IMAGE_MAX_BYTES)
        throw new Error(
          "The converted image exceeds 64 MiB. Crop or resize it first.",
        );
      if (current !== sequence) return;
      width = bitmap.width;
      height = bitmap.height;
      blob = normalized;
      if (url) URL.revokeObjectURL(url);
      url = URL.createObjectURL(blob);
      if (!input("name").value)
        input("name").value = file.name.replace(/\.[^.]+$/, "").slice(0, 80);
      el("message").textContent =
        "Image ready. Check its placement, attribution and licence before uploading.";
    } catch (e) {
      if (current === sequence) el("message").textContent = String(e);
    } finally {
      bitmap?.close();
      if (current === sequence) {
        loading = false;
        update();
      }
    }
  };
  el<HTMLFormElement>("form").onsubmit = async (event) => {
    event.preventDefault();
    if (!blob || busy) return;
    const captured = blob,
      placement: ImagePlacement = {
        name: input("name").value,
        bounds: bounds(),
        attribution: input("attribution").value,
        license: input("license").value,
      };
    const controls = [
      ...el("form").querySelectorAll<HTMLInputElement | HTMLButtonElement>(
        "input,button",
      ),
    ];
    busy = true;
    controls.forEach((c) => (c.disabled = true));
    async function send(
      allowStorageRisk = false,
    ): Promise<{ status: number; data: any }> {
      const body = new FormData();
      body.append(
        "placement",
        JSON.stringify({ ...placement, allowStorageRisk }),
      );
      body.append("image", captured, "image.png");
      el<HTMLProgressElement>("upload").hidden = false;
      return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("POST", "/admin/preparations/image");
        xhr.responseType = "json";
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) {
            el<HTMLProgressElement>("upload").value =
              (e.loaded / e.total) * 100;
            el("message").textContent =
              `Uploading image · ${Math.round((e.loaded / e.total) * 100)}%`;
          }
        };
        xhr.onload = () => resolve({ status: xhr.status, data: xhr.response });
        xhr.onerror = () =>
          reject(
            new Error("Image upload failed. Check the server connection."),
          );
        xhr.send(body);
      });
    }
    try {
      let result = await send();
      if (result.status === 409 && result.data?.storageWarning) {
        if (!(await confirmStorage(result.data.storageWarning)))
          throw new Error("Image was not queued.");
        result = await send(true);
      }
      if (result.status !== 202)
        throw new Error(
          result.data?.error ?? `Upload failed (${result.status})`,
        );
      el("message").textContent =
        `${result.data.name} queued. Follow its progress in Builds & checkpoints.`;
      document.dispatchEvent(new Event("atlas-jobs-changed"));
      location.hash = "builds";
    } catch (e) {
      el("message").textContent = String(e);
    } finally {
      busy = false;
      controls.forEach((c) => (c.disabled = false));
      el<HTMLProgressElement>("upload").hidden = true;
      update();
    }
  };
}

import { hostActivity } from "./host-workbench";
import type { ArchiveUpload } from "../../server/archive-uploads";
import { storageRequest } from "./host-storage";
import { storageSize } from "./host-budget";
type Upload = ArchiveUpload & { chunkBytes: number };
type Row = {
  file?: File;
  upload?: Upload;
  message: string;
  error?: boolean;
  progress?: number;
  done?: boolean;
};
export async function startImports() {
  const picker = document.getElementById("imports-files") as HTMLInputElement,
    start = document.getElementById("imports-start") as HTMLButtonElement,
    list = document.getElementById("imports-list")!,
    status = document.getElementById("imports-status")!;
  const rows: Row[] = [];
  let active: Row | undefined,
    batch = false,
    abort: AbortController | undefined;
  const element = <K extends keyof HTMLElementTagNameMap>(
    tag: K,
    text?: string,
  ) => {
    const el = document.createElement(tag);
    if (text) el.textContent = text;
    return el;
  };
  const render = () => {
    hostActivity(
      "Upload",
      "imports",
      rows.map((row, i) => ({
        id: row.upload?.id ?? String(i),
        name: row.file?.name ?? row.upload!.filename,
        state: row.done
          ? "ready"
          : row.error
            ? "failed"
            : active === row
              ? "uploading"
              : "waiting",
        message: row.message,
        completed: row.progress ?? row.upload?.offset,
        total: row.file?.size ?? row.upload?.size,
      })),
    );
    picker.disabled = batch || !!active;
    start.disabled = batch || !!active || !rows.some((r) => r.file && !r.done);
    list.replaceChildren();
    for (const row of rows) {
      const filename = row.file?.name ?? row.upload!.filename,
        size = row.file?.size ?? row.upload!.size,
        card = element("article"),
        title = element("h3", filename),
        info = element(
          "p",
          `${storageSize(size)} · ${filename.toLowerCase().endsWith(".atlas") ? "Atlas · preserve all capabilities" : "MBTiles · raster tile archive"}`,
        ),
        message = element("p", row.message),
        meter = element("progress"),
        actions = element("div");
      card.className = "host-import-row";
      info.className = "quiet";
      message.className = row.error ? "host-import-error" : "quiet";
      meter.max = size;
      meter.value = row.done ? size : (row.progress ?? row.upload?.offset ?? 0);
      meter.setAttribute("aria-label", `Upload ${filename}`);
      actions.className = "host-import-actions";
      if (row.done) {
        const builds = element("a", "Follow preparation ↗"),
          library = element("a", "Compose in map library ↗");
        builds.href = "#builds";
        library.href = "#library";
        actions.append(builds, library);
      } else {
        const resume = element(
            "button",
            active === row
              ? "Pause upload"
              : row.upload
                ? "Resume upload"
                : "Upload file",
          ),
          discard = element("button", "Discard upload");
        resume.type = discard.type = "button";
        resume.disabled = active !== row && (batch || !!active || !row.file);
        resume.onclick = () =>
          active === row ? abort?.abort() : void run(row);
        discard.disabled = !!active || batch;
        discard.onclick = async () => {
          discard.disabled = true;
          try {
            if (row.upload)
              await api(`/admin/imports/${row.upload.id}`, {
                method: "DELETE",
              });
            rows.splice(rows.indexOf(row), 1);
            render();
          } catch (error) {
            row.message = String(error);
            row.error = true;
            render();
          }
        };
        actions.append(resume, discard);
        if (!row.file)
          actions.prepend(
            element("span", "Select this same file above to resume."),
          );
      }
      card.append(title, info, meter, message, actions);
      list.append(card);
    }
  };
  async function api(path: string, init?: RequestInit): Promise<any> {
    const response = await fetch(path, init),
      data = await response.json();
    if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
    return data;
  }
  function chunk(row: Row, signal: AbortSignal): Promise<Upload> {
    const upload = row.upload!,
      file = row.file!,
      end = Math.min(file.size, upload.offset + upload.chunkBytes);
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("PUT", `/admin/imports/${upload.id}?offset=${upload.offset}`);
      xhr.setRequestHeader("Content-Type", "application/octet-stream");
      const stop = () => xhr.abort();
      signal.addEventListener("abort", stop, { once: true });
      xhr.upload.onprogress = (event) => {
        row.progress = upload.offset + event.loaded;
        row.message = `Uploading · ${storageSize(row.progress)} / ${storageSize(file.size)} · ${((row.progress / file.size) * 100).toFixed(1)}%`;
        render();
      };
      xhr.onloadend = () => signal.removeEventListener("abort", stop);
      xhr.onload = () => {
        try {
          const data = JSON.parse(xhr.responseText);
          if (xhr.status < 200 || xhr.status >= 300)
            throw new Error(data.error ?? `HTTP ${xhr.status}`);
          resolve(data);
        } catch (error) {
          reject(error);
        }
      };
      xhr.onerror = () =>
        reject(
          new Error(
            "Connection interrupted. Resume to continue from the server’s last saved chunk.",
          ),
        );
      xhr.onabort = () =>
        reject(new DOMException("Upload paused", "AbortError"));
      if (signal.aborted) {
        reject(new DOMException("Upload paused", "AbortError"));
        return;
      }
      xhr.send(file.slice(upload.offset, end));
    });
  }
  async function run(row: Row): Promise<boolean> {
    if (active || !row.file || row.done) return false;
    active = row;
    abort = new AbortController();
    row.error = false;
    row.message = "Checking server storage…";
    render();
    try {
      if (!row.upload)
        row.upload = await storageRequest("/admin/imports", {
          filename: row.file.name,
          size: row.file.size,
          modified: row.file.lastModified,
        });
      else row.upload = await api(`/admin/imports/${row.upload.id}`);
      abort.signal.throwIfAborted();
      if (!row.upload!.jobId) {
        while (row.upload!.offset < row.file.size) {
          abort.signal.throwIfAborted();
          row.upload = await chunk(row, abort.signal);
        }
        abort.signal.throwIfAborted();
        row.message = "Upload saved · adding to preparation queue…";
        render();
        const result = await api(`/admin/imports/${row.upload!.id}/finish`, {
          method: "POST",
        });
        row.upload!.jobId = result.jobId;
      }
      row.done = true;
      row.message =
        "Queued on server. You can close this page; preparation continues in Builds & checkpoints.";
      document.dispatchEvent(new Event("atlas-jobs-changed"));
      return true;
    } catch (error) {
      row.error = !abort.signal.aborted;
      row.message = abort.signal.aborted
        ? "Paused. Resume from the server’s last saved chunk."
        : String(error);
      row.progress = row.upload?.offset ?? 0;
      return false;
    } finally {
      active = undefined;
      abort = undefined;
      render();
    }
  }
  picker.onchange = () => {
    for (const file of picker.files ?? []) {
      if (!/\.(atlas|mbtiles)$/i.test(file.name)) {
        status.textContent = `Unsupported file: ${file.name}. Use Atlas or raster MBTiles; images have their own upload form below.`;
        continue;
      }
      const existing = rows.find(
        (r) =>
          !r.done &&
          (r.file?.name ?? r.upload?.filename) === file.name &&
          (r.file?.size ?? r.upload?.size) === file.size &&
          (r.file?.lastModified ?? r.upload?.modified) === file.lastModified,
      );
      if (existing) {
        existing.file = file;
        existing.message = "File reselected · ready to resume";
        existing.error = false;
      } else rows.push({ file, message: "Ready to upload" });
    }
    picker.value = "";
    render();
  };
  start.onclick = async () => {
    if (active || batch) return;
    batch = true;
    render();
    try {
      for (const row of rows.filter((r) => r.file && !r.done))
        if (!(await run(row))) break;
    } finally {
      batch = false;
      render();
    }
  };
  window.addEventListener("beforeunload", (event) => {
    if (active) {
      event.preventDefault();
      event.returnValue = "";
    }
  });
  try {
    const { uploads } = (await api("/admin/imports")) as { uploads: Upload[] };
    rows.push(
      ...uploads.map((upload) => ({
        upload,
        message: `Saved on server · ${storageSize(upload.offset)} / ${storageSize(upload.size)}`,
      })),
    );
    status.textContent =
      "Select several files to upload in order. Preparation runs on the server, one job at a time.";
  } catch (error) {
    status.textContent = `Could not load saved uploads: ${String(error)}`;
  }
  render();
}

import { storageSize } from "./host-budget";
const el = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById("work-" + id) as T;
const policy = () =>
  document.querySelector<HTMLInputElement>('input[name="work-policy"]:checked')!
    .value;
async function request(path: string, body?: unknown) {
  const r = await fetch(
    "/admin/preparations/work-storage" + path,
    body === undefined
      ? undefined
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
  );
  const data = await r.json();
  if (!r.ok) throw Error(data.error ?? "Storage request failed");
  return data;
}
export async function startWorkStorage() {
  const form = el<HTMLFormElement>("storage-form"),
    path = el<HTMLInputElement>("path"),
    label = el<HTMLInputElement>("label");
  const setMode = () => {
    el("extra-options").hidden = policy() === "map-disk";
  };
  form
    .querySelectorAll<HTMLInputElement>('input[name="work-policy"]')
    .forEach((r) => (r.onchange = setMode));
  const result = (d: any) => {
    el("test-result").textContent =
      `Folder is writable · ${storageSize(d.availableBytes)} free · ${d.kind === "network" ? "NAS assistance: databases remain on the map disk" : "Full workspace supported"}.${d.sameDisk ? " This folder is on the map disk, so it adds no disk capacity." : ""}`;
    el("extra-free").textContent = storageSize(d.availableBytes) + " available";
    el("extra-path").textContent = d.root;
    const meter = el<HTMLMeterElement>("extra-meter");
    meter.hidden = false;
    meter.max = d.totalBytes;
    meter.value = d.availableBytes;
  };
  const load = async () => {
    try {
      const d = await request("");
      el("primary-free").textContent =
        storageSize(d.primary.availableBytes) + " available";
      el("primary-path").textContent = d.primary.path;
      const meter = el<HTMLMeterElement>("primary-meter");
      meter.max = d.primary.totalBytes;
      meter.value = d.primary.availableBytes;
      document.querySelector<HTMLInputElement>(
        `input[name="work-policy"][value="${d.settings.policy}"]`,
      )!.checked = true;
      path.value = d.settings.location?.root ?? "";
      label.value = d.settings.location?.label ?? "";
      el("test-result").textContent = "";
      if (d.location?.online) result(d.location);
      else if (d.location) {
        el("extra-free").textContent = "Working disk unavailable";
        el("extra-path").textContent = d.location.root;
        el("test-result").textContent = d.location.error;
        el("extra-meter").hidden = true;
      }
      el("layout-note").textContent =
        d.settings.policy === "map-disk"
          ? "Working files stay on the map disk."
          : d.location?.kind === "network"
            ? "NAS holds extracted PBFs and intermediate archives. Databases stay on the map disk."
            : "The extra disk holds working files. Finished maps return to the map disk.";
      const choices = el("locations");
      choices.replaceChildren();
      for (const c of d.candidates) {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "storage-location";
        const title = document.createElement("strong"),
          note = document.createElement("small");
        title.textContent = c.label;
        note.textContent = `${c.kind === "network" ? "Network share" : "Mounted disk"} · ${storageSize(c.availableBytes)} free`;
        b.append(title, note);
        b.onclick = () => {
          path.value = c.path;
          label.value = c.kind === "network" ? "NAS workspace" : c.label;
          el("test-result").textContent =
            "Selected. Test the folder, then save.";
        };
        choices.append(b);
      }
      if (!d.candidates.length)
        choices.textContent =
          "No extra mounted disks detected. You can still enter an existing folder below.";
      setMode();
    } catch (e) {
      el("status").textContent = String(e);
    }
  };
  const run = async (action: () => Promise<void>) => {
    const buttons = [...form.querySelectorAll<HTMLButtonElement>("button")];
    buttons.forEach((b) => (b.disabled = true));
    try {
      await action();
    } catch (e) {
      el("status").textContent = String(e);
    } finally {
      buttons.forEach((b) => (b.disabled = false));
    }
  };
  path.oninput = () =>
    (el("test-result").textContent =
      "Folder changed. Test or save to validate it.");
  el("test").onclick = () =>
    void run(async () => {
      el("status").textContent = "Testing read, write, sync and rename…";
      result(await request("/test", { path: path.value, label: label.value }));
      el("status").textContent =
        "Folder test passed. Save to use this location.";
    });
  el("refresh").onclick = () => void run(load);
  form.onsubmit = (e) => {
    e.preventDefault();
    void run(async () => {
      await request("", {
        policy: policy(),
        path: policy() === "map-disk" ? undefined : path.value,
        label: label.value,
      });
      await load();
      el("status").textContent =
        "Saved. New PBF builds will use this policy. Running and saved builds keep their existing locations.";
    });
  };
  await load();
}

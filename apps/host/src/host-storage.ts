import { storageSize } from "./host-budget";
import type { StorageWarningInfo } from "../../../packages/provisioning/src/capacity";
export function confirmStorage(warning: StorageWarningInfo): Promise<boolean> {
  return new Promise((resolve) => {
    const dialog = document.createElement("dialog");
    dialog.className = "amend-dialog";
    const title = document.createElement("h3"),
      note = document.createElement("p"),
      detail = document.createElement("p"),
      cancel = document.createElement("button"),
      start = document.createElement("button");
    title.id = "storage-warning-title";
    title.textContent = "This job might be too big";
    dialog.setAttribute("aria-labelledby", title.id);
    note.textContent = `${storageSize(warning.estimatedBytes)} planning allowance · ${storageSize(warning.availableBytes)} available.`;
    detail.textContent =
      "This is an estimate, not the final file size. Start anyway to bypass this estimate; the job can still pause if the server actually runs low on disk space.";
    cancel.textContent = "Go back";
    start.textContent = "Start anyway";
    cancel.type = start.type = "button";
    cancel.onclick = () => dialog.close("cancel");
    start.onclick = () => dialog.close("start");
    dialog.onclose = () => {
      const yes = dialog.returnValue === "start";
      dialog.remove();
      resolve(yes);
    };
    dialog.append(title, note, detail, cancel, start);
    document.body.append(dialog);
    dialog.showModal();
    cancel.focus();
  });
}
/** The retry carries consent for this exact request through the persistent queue. */
export async function storageRequest(
  path: string,
  body: unknown,
): Promise<any> {
  const payload = structuredClone(body) as Record<string, unknown>;
  async function send(value: unknown) {
    const r = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(value),
    });
    return { r, data: await r.json() };
  }
  let { r, data } = await send(payload);
  if (r.status === 409 && data.storageWarning) {
    if (!(await confirmStorage(data.storageWarning)))
      throw new Error(
        "Not started. Change the selection or free disk space, then try again.",
      );
    ({ r, data } = await send({ ...payload, allowStorageRisk: true }));
  }
  if (!r.ok) throw new Error(data.error ?? "Request failed");
  return data;
}

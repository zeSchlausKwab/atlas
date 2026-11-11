import { storageRequest } from "./host-storage";
export function startWorldOverview() {
  const form = document.getElementById(
    "world-overview-form",
  ) as HTMLFormElement;
  const button = document.getElementById(
    "world-overview-start",
  ) as HTMLButtonElement;
  const status = document.getElementById("world-overview-status")!;
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (button.disabled) return;
    button.disabled = true;
    status.textContent = "Adding world overview to the preparation queue…";
    try {
      const name = (
        document.getElementById("world-overview-name") as HTMLInputElement
      ).value.trim();
      const job = await storageRequest("/admin/preparations", {
        naturalEarth: true,
        name,
      });
      if (!job) {
        status.textContent = "Preparation was not queued.";
        return;
      }
      status.textContent =
        "Queued. Follow progress in Activity; the finished map will appear in your library.";
      document.dispatchEvent(new Event("atlas-jobs-changed"));
    } catch (error) {
      status.textContent = `Could not queue the map: ${String(error)}`;
    } finally {
      button.disabled = false;
    }
  });
}

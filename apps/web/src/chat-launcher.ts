import type { BrowserAcquisition } from "./acquisition-client";
import type { WorkspaceMap } from "../../../packages/renderer/src/workspace-map";
import type {
  AtlasReader,
  ReadEvent,
} from "../../../packages/format/src/reader";
export class ChatLauncher {
  private panel?: ReturnType<typeof import("./chat/panel").mountChat>;
  private alive = true;
  private loading = false;
  private abort = new AbortController();
  constructor(
    readonly map: WorkspaceMap,
    readonly readers: AtlasReader[],
    readonly enabled: () => Set<string>,
    readonly offline: () => boolean,
    readonly onTransfer?: (event: ReadEvent) => void,
    readonly acquisition?: BrowserAcquisition,
  ) {
    document.addEventListener("atlas-tab", () => void this.open(), {
      signal: this.abort.signal,
    });
    document
      .getElementById("offline")
      ?.addEventListener("change", () => this.panel?.cancel(), {
        signal: this.abort.signal,
      });
    void this.open();
  }
  private async open() {
    if (
      !this.alive ||
      this.loading ||
      this.panel ||
      document.body.dataset.tab !== "chat"
    )
      return;
    this.loading = true;
    const element = document.getElementById("chat-root")!;
    element.textContent = "Opening Atlas chat…";
    try {
      const url = "/chat-panel.js";
      const module = (await import(
        /* @vite-ignore */ url
      )) as typeof import("./chat/panel");
      if (this.alive)
        this.panel = module.mountChat(
          element,
          this.map,
          this.readers,
          this.enabled,
          this.offline,
          this.onTransfer,
          this.acquisition,
        );
    } catch (e) {
      if (this.alive) element.textContent = "Could not open chat: " + String(e);
    } finally {
      this.loading = false;
    }
  }
  destroy() {
    this.alive = false;
    this.abort.abort();
    this.panel?.destroy();
    document.getElementById("chat-root")?.replaceChildren();
  }
}

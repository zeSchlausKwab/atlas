import {
  PagedRouter,
  type CellRead,
} from "../../../packages/routing/src/paged";
import type { Position } from "../../../packages/routing/src/index";
let router: PagedRouter | undefined;
let job = 0,
  sequence = 0;
const reads = new Map<
  number,
  { resolve: (v: CellRead) => void; reject: (e: Error) => void }
>();
self.onmessage = (event: MessageEvent) => {
  const m = event.data;
  if (m.type === "cell") {
    const p = reads.get(m.id);
    if (!p) return;
    reads.delete(m.id);
    if (m.error) p.reject(new Error(m.error));
    else p.resolve(m.value);
    return;
  }
  if (m.type === "route" || m.type === "isochrone") {
    job = m.id;
    router ??= new PagedRouter(
      m.snapshot,
      (key) =>
        new Promise((resolve, reject) => {
          const id = ++sequence;
          reads.set(id, { resolve, reject });
          self.postMessage({ type: "read", id, key });
        }),
      (progress) => self.postMessage({ type: "progress", id: job, progress }),
    );
    (m.type === "route"
      ? router.route(
          m.start as Position,
          m.end as Position,
          m.profile,
          m.prefix,
        )
      : router.isochrone(m.start, m.bands, m.profile, m.prefix)
    ).then(
      (result) => self.postMessage({ type: "result", id: m.id, result }),
      (e) => self.postMessage({ type: "error", id: m.id, error: String(e) }),
    );
  }
};

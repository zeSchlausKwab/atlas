import { purposeOf, type ReadEvent, type TransferPurpose } from "./reader";
import { tileLayer } from "./index";
/** Session accounting for independent analysis readers; no counting of cached reuse. */
export class TransferLedger {
  bytes = 0;
  requests = 0;
  purposes = new Map<TransferPurpose, number>();
  layers = new Map<string, number>();
  record(e: ReadEvent) {
    if (e.cached) return;
    this.bytes += e.bytes;
    this.requests++;
    const p = purposeOf(e.key);
    this.purposes.set(p, this.forPurpose(p) + e.bytes);
    if (e.key.startsWith("tile/")) {
      const l = tileLayer(e.key) ?? "combined";
      this.layers.set(l, (this.layers.get(l) ?? 0) + e.bytes);
    }
  }
  forPurpose(p: TransferPurpose) {
    return this.purposes.get(p) ?? 0;
  }
  clear() {
    this.bytes = this.requests = 0;
    this.purposes.clear();
    this.layers.clear();
  }
}

/** Weighted LRU. A caller may pin its active working set; any overage is explicit.
 * Weights are bytes for buffers, conservative estimates for JS objects. */
export class BudgetCache<K, V> {
  private items = new Map<K, { value: V; bytes: number }>();
  private protectedKeys = new Set<K>();
  bytes = 0;
  evictions = 0;
  constructor(
    readonly budget: number,
    private weight: (value: V, key: K) => number,
    private dispose?: (value: V, key: K) => void,
  ) {
    if (!Number.isSafeInteger(budget) || budget < 0)
      throw new Error("Invalid cache budget");
  }
  get size() {
    return this.items.size;
  }
  get stats() {
    return {
      bytes: this.bytes,
      budget: this.budget,
      entries: this.size,
      evictions: this.evictions,
      overage: Math.max(0, this.bytes - this.budget),
    };
  }
  has(key: K) {
    return this.items.has(key);
  }
  get(key: K): V | undefined {
    const entry = this.items.get(key);
    if (!entry) return;
    this.items.delete(key);
    this.items.set(key, entry);
    return entry.value;
  }
  set(key: K, value: V) {
    const bytes = this.weight(value, key);
    if (!Number.isSafeInteger(bytes) || bytes < 0)
      throw new Error("Invalid cache weight");
    this.delete(key);
    if (bytes > this.budget && !this.protectedKeys.has(key)) {
      this.dispose?.(value, key);
      this.evictions++;
      return this;
    }
    this.items.set(key, { value, bytes });
    this.bytes += bytes;
    this.trim();
    return this;
  }
  delete(key: K) {
    const entry = this.items.get(key);
    if (!entry) return false;
    this.items.delete(key);
    this.bytes -= entry.bytes;
    this.dispose?.(entry.value, key);
    return true;
  }
  protect(keys: Iterable<K>) {
    this.protectedKeys = new Set(keys);
    this.trim();
  }
  private trim() {
    for (const key of this.items.keys()) {
      if (this.bytes <= this.budget) break;
      if (!this.protectedKeys.has(key)) {
        this.delete(key);
        this.evictions++;
      }
    }
  }
  clear() {
    for (const key of this.items.keys()) this.delete(key);
  }
  *entries(): IterableIterator<[K, V]> {
    for (const [k, v] of this.items) yield [k, v.value];
  }
  *values(): IterableIterator<V> {
    for (const v of this.items.values()) yield v.value;
  }
  keys() {
    return this.items.keys();
  }
  [Symbol.iterator]() {
    return this.entries();
  }
}
export const DEFAULT_DECODED_BUDGETS = {
  map: 32 * 1024 * 1024,
  labels: 8 * 1024 * 1024,
  routing: 16 * 1024 * 1024,
  semantic: 16 * 1024 * 1024,
  directory: 1024 * 1024,
};
export type CacheDomain = keyof typeof DEFAULT_DECODED_BUDGETS;
function domain(key: string): CacheDomain {
  if (key.startsWith("tile/")) return "map";
  if (key.startsWith("labels/")) return "labels";
  if (key.startsWith("routing/")) return "routing";
  if (key.startsWith("index/")) return "directory";
  return "semantic";
}
/** Independent budgets keep a routing/search operation from evicting the map. */
export class DecodedCache {
  private groups: Record<CacheDomain, BudgetCache<string, Uint8Array>>;
  constructor(budgets: Partial<typeof DEFAULT_DECODED_BUDGETS> = {}) {
    const limits = { ...DEFAULT_DECODED_BUDGETS, ...budgets };
    this.groups = Object.fromEntries(
      Object.entries(limits).map(([k, v]) => [
        k,
        new BudgetCache<string, Uint8Array>(v, (bytes) => bytes.byteLength),
      ]),
    ) as typeof this.groups;
  }
  get stats() {
    return Object.fromEntries(
      Object.entries(this.groups).map(([k, c]) => [k, c.stats]),
    ) as Record<CacheDomain, BudgetCache<string, Uint8Array>["stats"]>;
  }
  get size() {
    return Object.values(this.groups).reduce((n, c) => n + c.size, 0);
  }
  get(key: string) {
    return this.groups[domain(key)].get(key);
  }
  has(key: string) {
    return this.groups[domain(key)].has(key);
  }
  set(key: string, bytes: Uint8Array) {
    this.groups[domain(key)].set(key, bytes);
  }
  delete(key: string) {
    return this.groups[domain(key)].delete(key);
  }
  clear() {
    for (const c of Object.values(this.groups)) c.clear();
  }
  *[Symbol.iterator](): IterableIterator<[string, Uint8Array]> {
    for (const c of Object.values(this.groups)) yield* c;
  }
}

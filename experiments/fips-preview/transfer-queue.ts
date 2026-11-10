/** Bounded active work; callers separately bound total accepted requests. */
export class TransferQueue {
  private count = 0;
  private closed = false;
  private waiting: Array<{ resolve: (release: () => void) => void; reject: (error: Error) => void }> = [];
  constructor(private readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error('Invalid transfer concurrency');
  }
  get active() { return this.count; }
  get queued() { return this.waiting.length; }
  acquire(): Promise<() => void> {
    if (this.closed) return Promise.reject(new Error('Preview transfer queue is closed'));
    if (this.count < this.limit) {
      this.count++;
      return Promise.resolve(this.release());
    }
    return new Promise((resolve, reject) => this.waiting.push({ resolve, reject }));
  }
  close() {
    this.closed = true;
    for (const waiter of this.waiting.splice(0)) waiter.reject(new Error('Preview transfer queue is closed'));
  }
  private release() {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiting.shift();
      if (next) next.resolve(this.release());
      else this.count--;
    };
  }
}

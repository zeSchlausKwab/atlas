/** Private preview-only transport. Production Soyli does not expose this interface. */
import type { ConsumerStatus, ConsumerRpcRequest, PreviewStats } from '../../experiments/fips-preview/consumer-protocol';
import type { FipsRpcResponse } from '../../packages/fips/src/rpc';
export type { ConsumerStatus, PreviewStats };
export type PreviewUpdate = ConsumerStatus | { stats: PreviewStats };
type Reply = { type: string; id?: string; bytes?: ArrayBuffer; response?: FipsRpcResponse; error?: string; stats?: PreviewStats } & Partial<ConsumerStatus>;
function isStatus(reply: Reply): reply is Reply & ConsumerStatus {
  return reply.version === 2 && ['discovering', 'ready', 'error', 'closed'].includes(reply.state ?? '') &&
    Array.isArray(reply.catalog) && Array.isArray(reply.preferredMapIds) && !!reply.discovery &&
    !!reply.stats && Number.isSafeInteger(reply.requestTimeoutMs) && reply.requestTimeoutMs! > 0;
}
export class PreviewBridge {
  private sequence = 0;
  private timeoutMs = 30000;
  private disposed = false;
  private readonly nonce = crypto.randomUUID();
  private pending = new Map<string, { type: string; resolve: (value: Reply) => void; reject: (error: Error) => void; cleanup: () => void }>();
  constructor(private changed: (status: PreviewUpdate) => void) { window.addEventListener('message', this.receive); }
  private receive = (event: MessageEvent) => {
    if (this.disposed || event.source !== window.parent || !event.data || typeof event.data !== 'object') return;
    const reply = event.data as Reply;
    if (reply.type === 'atlas-preview.changed') {
      if (isStatus(reply)) { this.timeoutMs = reply.requestTimeoutMs; this.changed(reply); }
      return;
    }
    if (reply.type === 'atlas-preview.stats') { if (reply.stats) this.changed({ stats: reply.stats }); return; }
    if (!reply.id) return;
    const request = this.pending.get(reply.id);
    if (!request || ![`${request.type}.result`, `${request.type}.error`].includes(reply.type)) return;
    request.cleanup(); this.pending.delete(reply.id);
    if (reply.stats) this.changed({ stats: reply.stats });
    if (reply.type.endsWith('.error')) request.reject(new Error(reply.error ?? 'FIPS request failed'));
    else {
      if (isStatus(reply)) this.timeoutMs = reply.requestTimeoutMs;
      request.resolve(reply);
    }
  };
  private send(type: string, data: Record<string, unknown> = {}, signal?: AbortSignal): Promise<Reply> {
    if (this.disposed) return Promise.reject(new Error('Napplet closed'));
    signal?.throwIfAborted();
    const id = `atlas-${this.nonce}-${++this.sequence}`;
    return new Promise((resolve, reject) => {
      const cancel = () => {
        window.parent.postMessage({ type: 'atlas-preview.cancel', id }, '*');
        this.pending.get(id)?.cleanup(); this.pending.delete(id);
        reject(signal?.reason ?? new Error('FIPS preview request timed out. Open this napplet in the patched Soyli preview.'));
      };
      const timer = window.setTimeout(cancel, type === 'atlas-preview.status' ? 8000 : this.timeoutMs);
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', cancel); };
      this.pending.set(id, { type, resolve, reject, cleanup });
      signal?.addEventListener('abort', cancel, { once: true });
      window.parent.postMessage({ type, id, ...data }, '*');
    });
  }
  async status(): Promise<ConsumerStatus> {
    const reply = await this.send('atlas-preview.status');
    if (!isStatus(reply)) throw new Error('Incomplete signed-map preview configuration');
    return reply;
  }
  async refresh(): Promise<ConsumerStatus> {
    const reply = await this.send('atlas-preview.refresh');
    if (!isStatus(reply)) throw new Error('Incomplete discovery refresh');
    return reply;
  }
  async blob(hash: string, root: string, signal?: AbortSignal): Promise<Uint8Array> {
    const reply = await this.send('atlas-preview.getBlob', { hash, root }, signal);
    if (!(reply.bytes instanceof ArrayBuffer)) throw new Error('Preview returned invalid blob bytes');
    return new Uint8Array(reply.bytes);
  }
  async request(root: string, request: ConsumerRpcRequest, signal?: AbortSignal): Promise<FipsRpcResponse> {
    const reply = await this.send('atlas-preview.rpc', { root, request }, signal);
    if (!reply.response || !Number.isInteger(reply.response.status)) throw new Error('Preview returned an invalid operation response');
    return reply.response;
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    window.removeEventListener('message', this.receive);
    for (const [id, request] of this.pending) {
      window.parent.postMessage({ type: 'atlas-preview.cancel', id }, '*');
      request.cleanup(); request.reject(new Error('Napplet closed'));
    }
    this.pending.clear();
  }
}

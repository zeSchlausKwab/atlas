/** Private preview-only transport. Production Soyli does not expose this interface. */
import type { PreviewStatus, PreviewStats } from '../../experiments/fips-preview/protocol';
export type { PreviewStatus, PreviewStats };
type Reply = { type: string; id?: string; bytes?: ArrayBuffer; error?: string; stats?: PreviewStats } & Partial<PreviewStatus>;
export class PreviewBridge {
  private sequence = 0;
  private readonly nonce = crypto.randomUUID();
  private pending = new Map<string, { resolve: (value: Reply) => void; reject: (error: Error) => void; cleanup: () => void }>();
  constructor(private changed: (status: Partial<PreviewStatus>) => void) { window.addEventListener('message', this.receive); }
  private receive = (event: MessageEvent) => {
    if (event.source !== window.parent || !event.data || typeof event.data !== 'object') return;
    const reply = event.data as Reply;
    if (reply.type === 'atlas-preview.status.changed') { this.changed(reply); return; }
    if (!reply.id || !['atlas-preview.status.result', 'atlas-preview.getBlob.result', 'atlas-preview.getBlob.error'].includes(reply.type)) return;
    const request = this.pending.get(reply.id);
    if (!request) return;
    request.cleanup(); this.pending.delete(reply.id);
    if (reply.stats) this.changed({ stats: reply.stats });
    if (reply.type.endsWith('.error')) request.reject(new Error(reply.error ?? 'FIPS request failed'));
    else request.resolve(reply);
  };
  private request(type: string, data: Record<string, unknown> = {}, signal?: AbortSignal): Promise<Reply> {
    signal?.throwIfAborted();
    const id = `atlas-${this.nonce}-${++this.sequence}`;
    return new Promise((resolve, reject) => {
      const cancel = () => {
        window.parent.postMessage({ type: 'atlas-preview.cancel', id }, '*');
        this.pending.get(id)?.cleanup(); this.pending.delete(id);
        reject(signal?.reason ?? new Error('FIPS preview request timed out. Open this napplet in the patched Soyli preview.'));
      };
      const timer = window.setTimeout(cancel, type === 'atlas-preview.status' ? 8000 : 65000);
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', cancel); };
      this.pending.set(id, { resolve, reject, cleanup });
      signal?.addEventListener('abort', cancel, { once: true });
      window.parent.postMessage({ type, id, ...data }, '*');
    });
  }
  async status(): Promise<PreviewStatus> {
    const reply = await this.request('atlas-preview.status');
    if (!reply.map || !reply.providerPeerId || !reply.state) throw new Error('Incomplete preview configuration');
    return reply as PreviewStatus;
  }
  async blob(hash: string, providerPeerId: string, signal?: AbortSignal): Promise<Uint8Array> {
    const reply = await this.request('atlas-preview.getBlob', { hash, providerPeerId }, signal);
    if (!(reply.bytes instanceof ArrayBuffer)) throw new Error('Preview returned invalid blob bytes');
    return new Uint8Array(reply.bytes);
  }
  dispose() {
    window.removeEventListener('message', this.receive);
    for (const [id, request] of this.pending) {
      window.parent.postMessage({ type: 'atlas-preview.cancel', id }, '*');
      request.cleanup(); request.reject(new Error('Napplet closed'));
    }
    this.pending.clear();
  }
}

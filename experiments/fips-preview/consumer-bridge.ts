import { ConsumerSession } from './consumer-session';
import { consumerError, parseConsumerConfig, type ConsumerRpcRequest } from './consumer-protocol';

declare const ATLAS_PREVIEW_CONFIG: unknown;
const session = new ConsumerSession(parseConsumerConfig(ATLAS_PREVIEW_CONFIG));
const pending = new Map<string, { frame: Window; abort: AbortController }>();
let closed = false;
let frameElement: HTMLIFrameElement | null = null;
const activeElement = () => document.querySelector<HTMLIFrameElement>('#stage > iframe');
const activeFrame = () => activeElement()?.contentWindow ?? null;
function cancelPending() {
  for (const request of pending.values()) request.abort.abort(new DOMException('Preview iframe changed', 'AbortError'));
  pending.clear();
}
function watchFrame() {
  const frame = activeElement();
  if (frame === frameElement) return;
  cancelPending();
  frameElement?.removeEventListener('load', cancelPending);
  frameElement = frame;
  frameElement?.addEventListener('load', cancelPending);
}
const observer = new MutationObserver((changes) => {
  if (changes.some((change) => change.type === 'attributes' && change.target === frameElement)) cancelPending();
  watchFrame();
});
observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['src', 'srcdoc'] });
watchFrame();
const unsubscribe = session.subscribe((kind) => {
  if (closed) return;
  watchFrame();
  activeFrame()?.postMessage(kind === 'catalog'
    ? { type: 'atlas-preview.changed', ...session.status() }
    : { type: 'atlas-preview.stats', stats: session.stats() }, '*');
});
function listen(event: MessageEvent) {
  watchFrame();
  const frame = activeFrame();
  if (closed || !frame || event.source !== frame || event.origin !== 'null') return;
  const message = event.data as Record<string, unknown>;
  if (!message || typeof message !== 'object' || typeof message.id !== 'string' ||
      !message.id.length || message.id.length > 128 || typeof message.type !== 'string') return;
  const id = message.id, type = message.type;
  const fields: Record<string, string[]> = {
    'atlas-preview.status': [], 'atlas-preview.cancel': [], 'atlas-preview.refresh': [],
    'atlas-preview.getBlob': ['hash', 'root'], 'atlas-preview.rpc': ['root', 'request'],
  };
  if (!fields[type]) return;
  if (Object.keys(message).some((key) => !['type', 'id', ...fields[type]!].includes(key))) {
    frame.postMessage({ type: `${type}.error`, id, error: 'Invalid or unpinned preview request', stats: session.stats() }, '*');
    return;
  }
  if (type === 'atlas-preview.cancel') {
    pending.get(id)?.abort.abort(new DOMException('Consumer cancelled request', 'AbortError'));
    pending.delete(id); return;
  }
  if (type === 'atlas-preview.status') {
    frame.postMessage({ type: `${type}.result`, id, ...session.status() }, '*'); return;
  }
  if (pending.has(id)) return;
  if (pending.size >= 128) {
    frame.postMessage({ type: `${type}.error`, id, error: 'Preview request queue is full', stats: session.stats() }, '*'); return;
  }
  const request = { frame, abort: new AbortController() };
  pending.set(id, request);
  const live = () => !closed && !request.abort.signal.aborted && activeFrame() === frame && pending.get(id) === request;
  void (async () => {
    try {
      let result: Record<string, unknown>;
      const transfers: Transferable[] = [];
      if (type === 'atlas-preview.refresh') result = { ...await session.refresh() };
      else if (type === 'atlas-preview.getBlob') {
        const data = await session.blob(message.hash as string, message.root as string, request.abort.signal);
        const bytes = new Uint8Array(data).buffer;
        result = { bytes }; transfers.push(bytes);
      } else {
        const response = await session.request(message.root as string, message.request as ConsumerRpcRequest, request.abort.signal);
        result = { response };
        if (response.bytes) {
          const bytes = new Uint8Array(response.bytes);
          result.response = { ...response, bytes }; transfers.push(bytes.buffer);
        }
      }
      if (live()) frame.postMessage({ type: `${type}.result`, id, ...result, stats: session.stats() }, '*', transfers);
    } catch (error) {
      if (live()) frame.postMessage({ type: `${type}.error`, id, error: consumerError(error), stats: session.stats() }, '*');
    } finally { if (pending.get(id) === request) pending.delete(id); }
  })();
}
window.addEventListener('message', listen);
window.addEventListener('pagehide', () => {
  closed = true; cancelPending(); observer.disconnect(); unsubscribe();
  frameElement?.removeEventListener('load', cancelPending);
  window.removeEventListener('message', listen);
  void session.close().catch(() => {});
}, { once: true });
Object.defineProperty(window, '__atlasPreviewFips', {
  value: Object.freeze({ status: () => session.status() }), configurable: true,
});
void session.refresh().catch(() => {});

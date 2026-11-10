import { FipsNode, generateIdentity, type PeerEvent } from '@fips/core';
import { WebSocketTransport } from '@fips/transport-websocket';
import { TcpBlobTransport } from './vendor/hashtree-fips-transport/tcpBlobTransport';
import { fromHex, toHex } from '@hashtree/core';
import { ACTIVE_TRANSFERS, MAX_PENDING_BLOBS, TRANSFER_ATTEMPTS, TRANSFER_RETRY_DELAY_MS, blobRequestTimeoutMs, parsePreviewConfig,
  type PreviewStats, type PreviewStatus } from './protocol';
import { TransferQueue } from './transfer-queue';

declare const ATLAS_PREVIEW_CONFIG: unknown;
const config = parsePreviewConfig(ATLAS_PREVIEW_CONFIG);
const MAX_BLOB_BYTES = 2 * 1024 ** 2;
const MAX_CACHE_BYTES = 32 * 1024 ** 2;
const pending = new Map<string, { frame: Window; cancelled: boolean }>();
const cache = new Map<string, Uint8Array>();
const transfers = new Map<string, Promise<Uint8Array>>();
const connected = new Set<string>();
const transferQueue = new TransferQueue(config.maxConcurrentTransfers ?? ACTIVE_TRANSFERS);
const stats: PreviewStats = {
  requests: 0, networkRequests: 0, retries: 0, fipsBytes: 0, verifiedBlobs: 0,
  cacheHits: 0, errors: 0, cancelledRequests: 0, pending: 0,
  activeTransfers: 0, queuedTransfers: 0,
};
let state: PreviewStatus['state'] = 'starting';
let lastError: string | undefined;
let peerId: string | undefined;
let cacheBytes = 0;
let closed = false;
let node: FipsNode | undefined;
let transport: TcpBlobTransport | undefined;
let currentFrame: Window | null = null;

function status(): PreviewStatus {
  return { state, error: lastError, peerId, providerPeerId: config.providerPeerId,
    seedUrls: config.seedUrls, map: config.map, connectedPeers: connected.size,
    requestTimeoutMs: blobRequestTimeoutMs(config),
    stats: { ...stats, pending: pending.size, activeTransfers: transferQueue.active,
      queuedTransfers: transferQueue.queued } };
}

function errorMessage(error: unknown): string {
  if (error instanceof AggregateError)
    return `${error.message}: ${error.errors.map(errorMessage).join('; ')}`.slice(0, 1800);
  return (error instanceof Error ? error.message : String(error)).slice(0, 1800);
}

function activeFrame() {
  return document.querySelector<HTMLIFrameElement>('#stage > iframe')?.contentWindow ?? null;
}

function changed() {
  if (!closed) activeFrame()?.postMessage({ type: 'atlas-preview.status.changed', ...status() }, '*');
}

const ready = (async () => {
  try {
    const identity = await generateIdentity();
    peerId = toHex(identity.publicKey);
    node = new FipsNode({ identity,
      transports: [new WebSocketTransport({ seedUrls: config.seedUrls })],
      forwarding: false, routingMode: 'reply_learned' });
    node.on('peer', (event) => {
      const peer = event as PeerEvent;
      if (peer.state === 'connected') connected.add(peer.remotePubkey);
      else connected.delete(peer.remotePubkey);
      changed();
    });
    await node.start();
    if (closed) { await node.stop(); return; }
    transport = new TcpBlobTransport({ endpoint: node, timeoutMs: config.timeoutMs,
      // The preview is a reader, not a public cache server. The bridge owns its bounded cache.
      localStore: { get: async () => null, put: async () => false,
        has: async () => false, delete: async () => false },
      allowIncomingPeer: () => false });
    state = 'ready';
    changed();
  } catch (error) {
    state = 'error'; lastError = errorMessage(error); changed();
    throw error;
  }
})();
void ready.catch(() => {});

// Retry only known transport failures. Corrupt/authenticated-missing data is terminal.
function transientTransferError(error: unknown): boolean {
  if (error instanceof AggregateError)
    return error.errors.length > 0 && error.errors.every(transientTransferError);
  return error instanceof Error && (error.name === 'TimeoutError' ||
    /TCP\/FIPS (?:connect|read|write) timed out/.test(error.message));
}

async function fetchBlob(hash: string): Promise<Uint8Array | null> {
  for (let attempt = 0; ; attempt++) {
    if (closed || !transport) throw new Error('Preview transport is closed');
    stats.networkRequests++;
    changed();
    try { return await transport.get(fromHex(hash), [config.providerPeerId], 0); }
    catch (error) {
      if (closed || attempt + 1 >= TRANSFER_ATTEMPTS || !transientTransferError(error)) throw error;
      stats.retries++;
      changed();
      await new Promise(resolve => setTimeout(resolve, TRANSFER_RETRY_DELAY_MS));
    }
  }
}

async function getBlob(hash: string): Promise<Uint8Array> {
  const hit = cache.get(hash);
  if (hit) {
    stats.cacheHits++;
    cache.delete(hash); cache.set(hash, hit);
    return hit;
  }
  const existing = transfers.get(hash);
  if (existing) return existing;
  if (transfers.size >= MAX_PENDING_BLOBS) throw new Error('Preview transfer queue is full');
  const task = (async () => {
    await ready;
    const slot = transferQueue.acquire();
    changed();
    const release = await slot;
    try {
      if (closed || !transport) throw new Error('Preview transport is closed');
      changed();
      const bytes = await fetchBlob(hash);
      if (!bytes) throw new Error(`Pinned provider does not have blob ${hash}`);
      stats.fipsBytes += bytes.byteLength;
      if (bytes.byteLength > MAX_BLOB_BYTES) throw new Error('Atlas blob exceeds the 2 MiB preview bound');
      const digest = toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes))));
      if (digest !== hash) throw new Error('Atlas blob failed SHA-256 verification');
      stats.verifiedBlobs++;
      if (!closed) {
        const saved = new Uint8Array(bytes);
        cache.set(hash, saved); cacheBytes += saved.length;
        while (cacheBytes > MAX_CACHE_BYTES) {
          const oldest = cache.keys().next().value!;
          cacheBytes -= cache.get(oldest)!.length; cache.delete(oldest);
        }
      }
      return bytes;
    } finally { release(); changed(); }
  })();
  transfers.set(hash, task);
  try { return await task; } finally { transfers.delete(hash); }
}

function listen(event: MessageEvent) {
  const frame = activeFrame();
  if (closed || !frame || event.source !== frame || event.origin !== 'null') return;
  if (currentFrame !== frame) { pending.clear(); currentFrame = frame; }
  const message = event.data;
  if (!message || typeof message !== 'object' || typeof message.id !== 'string' || message.id.length > 128) return;
  const id: string = message.id;
  if (message.type === 'atlas-preview.cancel') {
    const request = pending.get(id);
    if (request) {
      request.cancelled = true; pending.delete(id);
      stats.cancelledRequests++;
      changed();
    }
    return;
  }
  if (message.type === 'atlas-preview.status') {
    frame.postMessage({ type: 'atlas-preview.status.result', id, ...status() }, '*');
    return;
  }
  if (message.type !== 'atlas-preview.getBlob') return;
  if (pending.has(id)) return;
  if (pending.size >= MAX_PENDING_BLOBS || typeof message.hash !== 'string' || !/^[a-f0-9]{64}$/.test(message.hash) ||
      (message.providerPeerId !== undefined && message.providerPeerId !== config.providerPeerId)) {
    frame.postMessage({ type: 'atlas-preview.getBlob.error', id,
      error: 'Invalid blob request, unpinned provider, or preview request limit reached', stats: status().stats }, '*');
    return;
  }
  const request = { frame, cancelled: false };
  pending.set(id, request); stats.requests++;
  changed();
  const live = () => !closed && !request.cancelled && activeFrame() === frame && pending.get(id) === request;
  void getBlob(message.hash).then((data) => {
    if (!live()) return;
    const bytes = new Uint8Array(data).buffer;
    pending.delete(id);
    frame.postMessage({ type: 'atlas-preview.getBlob.result', id, bytes, stats: status().stats }, '*', [bytes]);
  }).catch((error) => {
    stats.errors++;
    if (!live()) return;
    pending.delete(id);
    frame.postMessage({ type: 'atlas-preview.getBlob.error', id,
      error: errorMessage(error), stats: status().stats }, '*');
  }).finally(changed);
}

window.addEventListener('message', listen);
window.addEventListener('pagehide', () => {
  closed = true; state = 'closed';
  window.removeEventListener('message', listen);
  pending.clear(); cache.clear(); cacheBytes = 0;
  transferQueue.close();
  void Promise.resolve(transport?.close()).finally(() => node?.stop());
}, { once: true });
// Read-only diagnostics for local preview inspection; never includes the ephemeral secret key.
Object.defineProperty(window, '__atlasPreviewFips', { value: Object.freeze({ status }), configurable: true });

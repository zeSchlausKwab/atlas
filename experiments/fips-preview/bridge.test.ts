import { expect, test } from 'bun:test';
import vm from 'node:vm';
import { ACTIVE_TRANSFERS, MAX_PENDING_BLOBS, blobRequestTimeoutMs, parsePreviewConfig } from './protocol';
import { configFromDescriptor } from './config-from-descriptor';

const config = {
  seedUrls: ['ws://127.0.0.1:9'], providerPeerId: '02' + '1'.repeat(64),
  map: { name: 'Test map', rootHash: '2'.repeat(64), size: 1234, chunkBytes: 65536 },
};
const mockModule = `
export class FipsNode { constructor({identity}) {this.identity=identity} on(){} async start(){} async stop(){} }
export async function generateIdentity(){return {publicKey:new Uint8Array(33)}}
export class WebSocketTransport { constructor(){} }
export class TcpBlobTransport { constructor(){} get(hash){return globalThis.__get(hash)} async close(){} }
export function fromHex(hex){return new Uint8Array(hex.match(/../g).map(x=>parseInt(x,16)))}
export function toHex(bytes){return Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('')}
`;
const build = await Bun.build({
  entrypoints: [new URL('./bridge.ts', import.meta.url).pathname],
  target: 'browser', format: 'iife', define: { ATLAS_PREVIEW_CONFIG: JSON.stringify(config) },
  plugins: [{ name: 'transport-test-double', setup(build) {
    build.onResolve({ filter: /^@(fips|hashtree)\// }, () => ({ path: 'transport', namespace: 'mock' }));
    build.onLoad({ filter: /.*/, namespace: 'mock' }, () => ({ contents: mockModule, loader: 'js' }));
  } }],
});
if (!build.success) throw new Error(build.logs.join('\n'));
const script = await build.outputs[0].text();

function harness(get: (hash: Uint8Array) => Promise<Uint8Array | null>) {
  const replies: Array<Record<string, unknown>> = [];
  const handlers = new Map<string, (event: unknown) => void>();
  const waiters = new Map<string, (reply: Record<string, unknown>) => void>();
  const frame = { postMessage: (value: Record<string, unknown>) => {
    replies.push(value);
    if (typeof value.id === 'string') {
      waiters.get(value.id)?.(value);
      waiters.delete(value.id);
    }
  } };
  const window = {
    addEventListener: (type: string, handler: (event: unknown) => void) => handlers.set(type, handler),
    removeEventListener: (type: string) => handlers.delete(type),
  };
  vm.runInNewContext(script, { window, document: { querySelector: () => ({ contentWindow: frame }) },
    crypto, URL, Uint8Array, ArrayBuffer, Error, AggregateError, console, setTimeout, clearTimeout, __get: get });
  return {
    replies,
    waitForReply: (id: string) => {
      const existing = replies.find((reply) => reply.id === id);
      return existing ? Promise.resolve(existing) :
        new Promise<Record<string, unknown>>((resolve) => waiters.set(id, resolve));
    },
    dispatch: (data: object, source: unknown = frame, origin = 'null') =>
      handlers.get('message')?.({ data, source, origin }),
    close: () => handlers.get('pagehide')?.({}),
  };
}
const drain = () => new Promise<void>((resolve) => setImmediate(resolve));
const hashOf = async (bytes: Uint8Array) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
  (byte) => byte.toString(16).padStart(2, '0')).join('');

test('only the current opaque child can read the pinned provider', async () => {
  let calls = 0;
  const h = harness(async () => { calls++; return new Uint8Array([1]); });
  const request = { type: 'atlas-preview.getBlob', id: 'read', hash: 'a'.repeat(64) };
  h.dispatch(request, {});
  h.dispatch(request, undefined, 'https://other.example');
  h.dispatch({ ...request, providerPeerId: '03' + '3'.repeat(64) });
  await drain();
  expect(calls).toBe(0);
  expect(h.replies.filter((r) => r.type === 'atlas-preview.getBlob.error')).toHaveLength(1);
  h.close();
});

test('valid blobs cross the bridge as bytes and reuse a verified bounded cache', async () => {
  const bytes = new Uint8Array([1, 2, 3, 4]);
  const hash = await hashOf(bytes);
  let calls = 0;
  const h = harness(async () => { calls++; return bytes; });
  h.dispatch({ type: 'atlas-preview.getBlob', id: 'first', hash });
  await drain();
  h.dispatch({ type: 'atlas-preview.getBlob', id: 'second', hash });
  await drain();
  const results = h.replies.filter((r) => r.type === 'atlas-preview.getBlob.result');
  expect(results).toHaveLength(2);
  expect(new Uint8Array(results[0]!.bytes as ArrayBuffer)).toEqual(bytes);
  expect(calls).toBe(1);
  expect(results[1]!.stats).toMatchObject({ requests: 2, networkRequests: 1, fipsBytes: 4, cacheHits: 1 });
  h.close();
});

test('corrupt blobs are rejected without retry and never cached', async () => {
  let calls = 0;
  const h = harness(async () => { calls++; return new Uint8Array([99]); });
  h.dispatch({ type: 'atlas-preview.getBlob', id: 'corrupt', hash: 'a'.repeat(64) });
  await drain();
  expect(h.replies.find((r) => r.type === 'atlas-preview.getBlob.error')?.error).toContain('SHA-256');
  expect(calls).toBe(1);
  expect(h.replies.some((r) => r.type === 'atlas-preview.getBlob.result')).toBe(false);
  h.close();
});

const transientConnectionError = () => new AggregateError(
  [new Error('TCP/FIPS connect timed out')], 'TCP/FIPS blob availability is uncertain');

test('a transient FIPS connection failure retries and returns one verified blob', async () => {
  const bytes = new Uint8Array([4, 8, 15, 16, 23, 42]);
  const hash = await hashOf(bytes);
  const requestedHashes: string[] = [];
  const h = harness(async (requestedHash) => {
    requestedHashes.push(Array.from(requestedHash, (byte) => byte.toString(16).padStart(2, '0')).join(''));
    if (requestedHashes.length === 1) throw transientConnectionError();
    return bytes;
  });
  try {
    h.dispatch({ type: 'atlas-preview.getBlob', id: 'transient', hash });
    const reply = await h.waitForReply('transient');
    expect(reply.type).toBe('atlas-preview.getBlob.result');
    expect(h.replies.filter((value) => value.id === 'transient')).toHaveLength(1);
    expect(requestedHashes).toEqual([hash, hash]);
    const received = new Uint8Array(reply.bytes as ArrayBuffer);
    expect(received).toEqual(bytes);
    expect(await hashOf(received)).toBe(hash);
    expect(reply.stats).toMatchObject({ requests: 1, networkRequests: 2, retries: 1,
      verifiedBlobs: 1, errors: 0, fipsBytes: bytes.length });
  } finally { h.close(); }
});

test('transient FIPS failures stop after two attempts and return one terminal error', async () => {
  let calls = 0;
  const h = harness(async () => { calls++; throw transientConnectionError(); });
  try {
    h.dispatch({ type: 'atlas-preview.getBlob', id: 'exhausted', hash: 'a'.repeat(64) });
    const reply = await h.waitForReply('exhausted');
    expect(reply.type).toBe('atlas-preview.getBlob.error');
    expect(reply.error).toContain('TCP/FIPS connect timed out');
    expect(calls).toBe(2);
    expect(h.replies.filter((value) => value.id === 'exhausted')).toHaveLength(1);
    expect(reply.stats).toMatchObject({ networkRequests: 2, retries: 1, errors: 1, verifiedBlobs: 0 });
  } finally { h.close(); }
});

test('an authenticated missing blob is terminal without retry', async () => {
  let calls = 0;
  const h = harness(async () => { calls++; return null; });
  try {
    h.dispatch({ type: 'atlas-preview.getBlob', id: 'missing', hash: 'a'.repeat(64) });
    const reply = await h.waitForReply('missing');
    expect(reply.type).toBe('atlas-preview.getBlob.error');
    expect(reply.error).toContain('does not have blob');
    expect(calls).toBe(1);
    expect(h.replies.filter((value) => value.id === 'missing')).toHaveLength(1);
    expect(reply.stats).toMatchObject({ networkRequests: 1, retries: 0, errors: 1, verifiedBlobs: 0 });
  } finally { h.close(); }
});

test('an aggregate containing a fatal failure does not retry', async () => {
  let calls = 0;
  const h = harness(async () => {
    calls++;
    throw new AggregateError([new Error('TCP/FIPS connect timed out'), new Error('Invalid response')],
      'TCP/FIPS blob availability is uncertain');
  });
  try {
    h.dispatch({ type: 'atlas-preview.getBlob', id: 'fatal', hash: 'a'.repeat(64) });
    const reply = await h.waitForReply('fatal');
    expect(reply.type).toBe('atlas-preview.getBlob.error');
    expect(reply.error).toContain('Invalid response');
    expect(calls).toBe(1);
    expect(reply.stats).toMatchObject({ networkRequests: 1, retries: 0, errors: 1 });
  } finally { h.close(); }
});

test('cancelled requests never receive a late blob response', async () => {
  const bytes = new Uint8Array([8]);
  const hash = await hashOf(bytes);
  const deferred = Promise.withResolvers<Uint8Array>();
  const h = harness(() => deferred.promise);
  h.dispatch({ type: 'atlas-preview.getBlob', id: 'cancelled', hash });
  expect(h.replies.at(-1)?.stats).toMatchObject({ pending: 1, cancelledRequests: 0 });
  h.dispatch({ type: 'atlas-preview.cancel', id: 'cancelled' });
  expect(h.replies.at(-1)?.stats).toMatchObject({ pending: 0, cancelledRequests: 1, errors: 0 });
  h.dispatch({ type: 'atlas-preview.cancel', id: 'cancelled' });
  h.dispatch({ type: 'atlas-preview.cancel', id: 'unknown' });
  deferred.resolve(bytes);
  await drain();
  expect(h.replies.some((r) => r.id === 'cancelled')).toBe(false);
  expect(h.replies.at(-1)?.stats).toMatchObject({ cancelledRequests: 1, errors: 0 });
  h.close();
});

test('configuration accepts compressed FIPS keys and rejects a different address shape', () => {
  expect(parsePreviewConfig(config).providerPeerId).toBe(config.providerPeerId);
  expect(() => parsePreviewConfig({ ...config, providerPeerId: '1'.repeat(64) })).toThrow('66 hex');
  expect(() => parsePreviewConfig({ ...config, seedUrls: ['ws://example.com/fips'] })).toThrow('loopback');
});

test('status budgets the full accepted queue and transport deadline', () => {
  expect(MAX_PENDING_BLOBS).toBe(32);
  expect(ACTIVE_TRANSFERS).toBe(8);
  expect(blobRequestTimeoutMs(config)).toBe(253000);
  expect(blobRequestTimeoutMs({ timeoutMs: 1000 })).toBe(21000);
  expect(blobRequestTimeoutMs({ timeoutMs: 60000 })).toBe(493000);
  const h = harness(async () => null);
  h.dispatch({ type: 'atlas-preview.status', id: 'budget' });
  expect(h.replies.find((r) => r.id === 'budget')).toMatchObject({ requestTimeoutMs: 253000 });
  h.close();
});

test('tile and label bursts queue after eight transfers and all complete', async () => {
  const payloads = Array.from({ length: 12 }, (_, i) => new Uint8Array([i, 42]));
  const hashes = await Promise.all(payloads.map(hashOf));
  const calls: Array<{ hash: string; resolve: (bytes: Uint8Array) => void }> = [];
  const h = harness((hash) => new Promise((resolve) => calls.push({
    hash: Array.from(hash, (b) => b.toString(16).padStart(2, '0')).join(''), resolve,
  })));
  hashes.forEach((hash, index) => h.dispatch({ type: 'atlas-preview.getBlob', id: `burst-${index}`, hash }));
  expect(h.replies.at(-1)?.stats).toMatchObject({ pending: 12 });
  await drain();
  expect(calls).toHaveLength(8);
  expect(h.replies.at(-1)?.stats).toMatchObject({ pending: 12, activeTransfers: 8, queuedTransfers: 4 });
  expect(h.replies.some((r) => (r.stats as { queuedTransfers?: number } | undefined)?.queuedTransfers === 4)).toBe(true);
  for (const call of calls.slice()) call.resolve(payloads[hashes.indexOf(call.hash)]!);
  await drain();
  expect(calls).toHaveLength(12);
  expect(h.replies.at(-1)?.stats).toMatchObject({ pending: 4, activeTransfers: 4, queuedTransfers: 0 });
  for (const call of calls.slice(8)) call.resolve(payloads[hashes.indexOf(call.hash)]!);
  await drain();
  expect(h.replies.filter((r) => r.type === 'atlas-preview.getBlob.result')).toHaveLength(12);
  expect(h.replies.filter((r) => r.type === 'atlas-preview.getBlob.error')).toHaveLength(0);
  expect(h.replies.at(-1)?.stats).toMatchObject({ pending: 0, activeTransfers: 0, queuedTransfers: 0 });
  h.close();
});

test('public provider descriptors become pinned preview configuration including legacy chunk size', () => {
  const descriptor = { type: 'atlas-fips', version: 1, peerId: config.providerPeerId,
    seedUrls: config.seedUrls, root: config.map.rootHash, bytes: config.map.size };
  expect(configFromDescriptor(descriptor, 'Demo').map).toEqual({ ...config.map, name: 'Demo' });
  expect(configFromDescriptor({ ...descriptor, chunkBytes: 131072 }).map.chunkBytes).toBe(131072);
  expect(() => configFromDescriptor({ ...descriptor, peerId: 'untrusted-address' })).toThrow('66 hex');
});

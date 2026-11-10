import { expect, test } from 'bun:test';
import vm from 'node:vm';
import { TcpBlobTransport as InstalledTcpBlobTransport } from '@hashtree/fips-transport';
import { ACTIVE_TRANSFERS, MAX_PENDING_BLOBS, blobRequestTimeoutMs, parsePreviewConfig } from './protocol';
import { configFromDescriptor } from './config-from-descriptor';

const config = {
  timeoutMs: 30000, maxConcurrentTransfers: 2,
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
  target: 'browser', format: 'iife', define: { ATLAS_PREVIEW_CONFIG: 'globalThis.__previewConfig' },
  plugins: [{ name: 'transport-test-double', setup(build) {
    build.onResolve({ filter: /^(?:@(fips|hashtree)\/|\.\/vendor\/hashtree-fips-transport\/tcpBlobTransport$)/ }, () => ({ path: 'transport', namespace: 'mock' }));
    build.onLoad({ filter: /.*/, namespace: 'mock' }, () => ({ contents: mockModule, loader: 'js' }));
  } }],
});
if (!build.success) throw new Error(build.logs.join('\n'));
const script = await build.outputs[0].text();

function harness(get: (hash: Uint8Array) => Promise<Uint8Array | null>, previewConfig = config) {
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
    crypto, URL, Uint8Array, ArrayBuffer, Error, AggregateError, console, setTimeout, clearTimeout, __get: get, __previewConfig: previewConfig });
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

type TimeoutPhase = 'connect' | 'read' | 'write';

// Exercise the pinned dependency's timeout throw sites and public get() error wrapper.
// An expired deadline removes timing/network noise; only fetchFromPeer dispatch is stubbed.
async function installedTimeoutError(phase: TimeoutPhase): Promise<AggregateError> {
  const transport = new InstalledTcpBlobTransport({
    endpoint: { registerService: () => () => {}, sendDatagram: async () => {} },
    localStore: { get: async () => null, put: async () => false,
      has: async () => false, delete: async () => false },
  });
  const internal = transport as unknown as {
    fetchFromPeer: () => Promise<Uint8Array | null>;
    waitEstablished: (connection: number, deadline: number) => Promise<void>;
    readExact: (connection: number, size: number, deadline: number) => Promise<Uint8Array>;
    writeAll: (connection: number, data: Uint8Array, deadline: number) => Promise<void>;
  };
  let sessions = 0;
  internal.fetchFromPeer = async () => {
    sessions++;
    if (phase === 'connect') await internal.waitEstablished(0, 0);
    else if (phase === 'read') await internal.readExact(0, 1, 0);
    else await internal.writeAll(0, new Uint8Array([1]), 0);
    throw new Error('Expected the installed transport deadline to throw');
  };
  try {
    await transport.get(new Uint8Array(32), [config.providerPeerId], 0);
    throw new Error('Expected the installed transport to aggregate its exhausted attempts');
  } catch (error) {
    expect(sessions).toBe(2);
    expect(error).toBeInstanceOf(AggregateError);
    const aggregate = error as AggregateError;
    expect(aggregate.message).toBe('TCP/FIPS blob availability is uncertain');
    expect(aggregate.errors).toHaveLength(1);
    expect(aggregate.errors[0]).toBeInstanceOf(Error);
    expect(aggregate.errors[0].message).toBe(`TCP/FIPS ${phase} timed out`);
    return aggregate;
  } finally { await transport.close(); }
}

test.each(['connect', 'read', 'write'] as const)(
  'the installed transport %s timeout error retries through the bridge', async (phase) => {
    const timeoutError = await installedTimeoutError(phase);
    const bytes = new Uint8Array([7, 11, 13]);
    const hash = await hashOf(bytes);
    let calls = 0;
    const h = harness(async () => {
      calls++;
      if (calls === 1) throw timeoutError;
      return bytes;
    });
    try {
      h.dispatch({ type: 'atlas-preview.getBlob', id: phase, hash });
      const reply = await h.waitForReply(phase);
      expect(reply.type).toBe('atlas-preview.getBlob.result');
      expect(calls).toBe(2);
      expect(h.replies.filter((value) => value.id === phase)).toHaveLength(1);
      expect(new Uint8Array(reply.bytes as ArrayBuffer)).toEqual(bytes);
      expect(reply.stats).toMatchObject({ networkRequests: 2, retries: 1, errors: 0, verifiedBlobs: 1 });
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

test('configuration defaults to two transfers and validates explicit limits', () => {
  expect(parsePreviewConfig({ ...config, maxConcurrentTransfers: undefined }).maxConcurrentTransfers).toBe(2);
  for (const maxConcurrentTransfers of [1, 2, 8])
    expect(parsePreviewConfig({ ...config, maxConcurrentTransfers }).maxConcurrentTransfers).toBe(maxConcurrentTransfers);
  for (const maxConcurrentTransfers of [0, -1, 9, 1.5, NaN, Infinity, null, '2'])
    expect(() => parsePreviewConfig({ ...config, maxConcurrentTransfers })).toThrow('integer between 1 and 8');
});

test('status budgets the full accepted queue at the configured transfer limit', () => {
  expect(MAX_PENDING_BLOBS).toBe(32);
  expect(ACTIVE_TRANSFERS).toBe(2);
  expect(blobRequestTimeoutMs(config)).toBe(982000);
  expect(blobRequestTimeoutMs({ timeoutMs: 1000 })).toBe(54000);
  expect(blobRequestTimeoutMs({ timeoutMs: 60000 })).toBe(1942000);
  expect(blobRequestTimeoutMs({ maxConcurrentTransfers: 1 })).toBe(1954000);
  expect(blobRequestTimeoutMs({ maxConcurrentTransfers: 8 })).toBe(253000);
  for (const maxConcurrentTransfers of [1, 2, 8]) {
    const custom = { ...config, maxConcurrentTransfers };
    const h = harness(async () => null, custom);
    h.dispatch({ type: 'atlas-preview.status', id: 'budget' });
    expect(h.replies.find((r) => r.id === 'budget')).toMatchObject({ requestTimeoutMs: blobRequestTimeoutMs(custom) });
    h.close();
  }
});

test.each([1, 2, 8])('tile and label bursts respect the configured limit of %i transfers', async (limit) => {
  const payloads = Array.from({ length: 12 }, (_, i) => new Uint8Array([i, 42]));
  const hashes = await Promise.all(payloads.map(hashOf));
  const calls: Array<{ hash: string; resolve: (bytes: Uint8Array) => void }> = [];
  const h = harness((hash) => new Promise((resolve) => calls.push({
    hash: Array.from(hash, (b) => b.toString(16).padStart(2, '0')).join(''), resolve,
  })), { ...config, maxConcurrentTransfers: limit });
  try {
    hashes.forEach((hash, index) => h.dispatch({ type: 'atlas-preview.getBlob', id: `burst-${index}`, hash }));
    expect(h.replies.at(-1)?.stats).toMatchObject({ pending: payloads.length });
    await drain();
    for (let completed = 0; completed < payloads.length; completed += limit) {
      const active = Math.min(limit, payloads.length - completed);
      expect(calls).toHaveLength(completed + active);
      expect(h.replies.at(-1)?.stats).toMatchObject({ pending: payloads.length - completed,
        activeTransfers: active, queuedTransfers: payloads.length - completed - active });
      for (const call of calls.slice(completed, completed + active))
        call.resolve(payloads[hashes.indexOf(call.hash)]!);
      await drain();
    }
    expect(h.replies.filter((r) => r.type === 'atlas-preview.getBlob.result')).toHaveLength(payloads.length);
    expect(h.replies.filter((r) => r.type === 'atlas-preview.getBlob.error')).toHaveLength(0);
    expect(h.replies.at(-1)?.stats).toMatchObject({ pending: 0, activeTransfers: 0, queuedTransfers: 0 });
  } finally { h.close(); }
});

test('public provider descriptors become pinned preview configuration including legacy chunk size', () => {
  const descriptor = { type: 'atlas-fips', version: 1, peerId: config.providerPeerId,
    seedUrls: config.seedUrls, root: config.map.rootHash, bytes: config.map.size };
  expect(configFromDescriptor(descriptor, 'Demo').map).toEqual({ ...config.map, name: 'Demo' });
  expect(configFromDescriptor({ ...descriptor, chunkBytes: 131072 }).map.chunkBytes).toBe(131072);
  expect(() => configFromDescriptor({ ...descriptor, peerId: 'untrusted-address' })).toThrow('66 hex');
});

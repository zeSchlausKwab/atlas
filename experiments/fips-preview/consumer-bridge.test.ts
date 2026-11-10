import { expect, test } from 'bun:test';
import vm from 'node:vm';

const built = await Bun.build({
  entrypoints: [new URL('./consumer-bridge.ts', import.meta.url).pathname], target: 'browser', format: 'iife',
  define: { ATLAS_PREVIEW_CONFIG: '{}' },
  plugins: [{ name: 'session-double', setup(build) {
    build.onResolve({ filter: /^\.\/consumer-(session|protocol)$/ }, () => ({ path: 'session', namespace: 'double' }));
    build.onLoad({ filter: /.*/, namespace: 'double' }, () => ({ loader: 'js', contents: `
      export class ConsumerSession { constructor() { return globalThis.__session; } }
      export const parseConsumerConfig = (value) => value;
      export const consumerError = (error) => error.message;
    ` }));
  } }],
});
if (!built.success) throw Error(built.logs.join('\n'));
const script = await built.outputs[0]!.text();
const drain = () => new Promise<void>((resolve) => setImmediate(resolve));
function harness() {
  type Message = Record<string, any>;
  const replies: Message[] = [], events = new Map<string, (event: Message) => void>();
  const frame = { postMessage: (message: Message) => replies.push(message) };
  function element(window = frame) {
    const handlers = new Map<string, () => void>();
    return { contentWindow: window, handlers, addEventListener: (type: string, handler: () => void) => handlers.set(type, handler),
      removeEventListener: (type: string) => handlers.delete(type) };
  }
  let current = element(), observe: (mutations: Message[]) => void = () => {}, disconnected = false, closed = 0;
  let change: (kind: 'catalog' | 'stats') => void = () => {};
  const calls: Array<{ kind: string; root: string; hash?: string; signal?: AbortSignal; request?: unknown }> = [];
  const deferred = Promise.withResolvers<Uint8Array>();
  const status = { version: 2, state: 'ready', catalog: [{ key: 'signed-map' }], stats: { requests: 7 } };
  const session = {
    status: () => status, stats: () => status.stats,
    subscribe: (callback: typeof change) => { change = callback; return () => {}; },
    refresh: async () => status, close: async () => { closed++; },
    blob: (hash: string, root: string, signal: AbortSignal) => { calls.push({ kind: 'blob', hash, root, signal }); return deferred.promise; },
    request: async (root: string, request: unknown, signal: AbortSignal) => {
      calls.push({ kind: 'rpc', root, request, signal }); return { status: 200, body: { ok: true } };
    },
  };
  const window = { addEventListener: (type: string, callback: (event: Message) => void) => events.set(type, callback),
    removeEventListener: (type: string) => events.delete(type) };
  vm.runInNewContext(script, { window, document: { documentElement: {}, querySelector: () => current },
    MutationObserver: class { constructor(callback: typeof observe) { observe = callback; } observe() {} disconnect() { disconnected = true; } },
    AbortController, DOMException, Uint8Array, Error, __session: session });
  return { replies, calls, session, deferred, change: (kind: 'catalog' | 'stats') => change(kind),
    dispatch: (message: Message, source: unknown = frame, origin = 'null') => events.get('message')?.({ data: message, source, origin }),
    replace: () => { current = element({ postMessage: (message) => replies.push(message) }); observe([{ type: 'childList' }]); },
    navigate: () => current.handlers.get('load')?.(),
    close: () => events.get('pagehide')?.({}), disconnected: () => disconnected, closed: () => closed,
  };
}

test('only current opaque iframe may use the private bridge; extra provider fields are refused', async () => {
  const h = harness(), request = { type: 'atlas-preview.getBlob', id: 'a', root: 'root', hash: 'hash' };
  h.dispatch(request, {}); h.dispatch(request, undefined, 'https://other.example');
  h.dispatch({ ...request, providerPeerId: 'other' }); await drain();
  expect(h.calls).toHaveLength(0); expect(h.replies).toHaveLength(1);
  expect(h.replies[0]!.type).toBe('atlas-preview.getBlob.error'); h.close();
});

test('catalog updates carry full status while request stats do not serialize the catalog', () => {
  const h = harness(); h.dispatch({ type: 'atlas-preview.status', id: 's' });
  h.change('catalog'); h.change('stats');
  expect(h.replies[0]).toMatchObject({ type: 'atlas-preview.status.result', id: 's', version: 2, catalog: [{ key: 'signed-map' }] });
  expect(h.replies[1]).toMatchObject({ type: 'atlas-preview.changed', catalog: [{ key: 'signed-map' }] });
  expect(h.replies[2]).toEqual({ type: 'atlas-preview.stats', stats: { requests: 7 } }); h.close();
});

test('blob reads pass pinned root and signal and send one transferable result', async () => {
  const h = harness(); h.dispatch({ type: 'atlas-preview.getBlob', id: 'b', root: 'root', hash: 'hash' });
  h.deferred.resolve(new Uint8Array([1, 2, 3])); await drain();
  expect(h.calls[0]).toMatchObject({ kind: 'blob', root: 'root', hash: 'hash' });
  expect(h.replies).toHaveLength(1); expect(h.replies[0]!.type).toBe('atlas-preview.getBlob.result');
  expect(new Uint8Array(h.replies[0]!.bytes)).toEqual(new Uint8Array([1, 2, 3])); h.close();
});

test.each(['cancel', 'replace', 'navigate', 'close'] as const)('%s aborts old iframe work and suppresses late replies', async (action) => {
  const h = harness(); h.dispatch({ type: 'atlas-preview.getBlob', id: 'late', root: 'root', hash: 'hash' });
  if (action === 'cancel') h.dispatch({ type: 'atlas-preview.cancel', id: 'late' }); else h[action]();
  expect(h.calls[0]!.signal!.aborted).toBe(true);
  h.deferred.resolve(new Uint8Array([9])); await drain();
  expect(h.replies.some((reply) => reply.id === 'late')).toBe(false);
  if (action !== 'close') h.close();
  expect(h.closed()).toBe(1); expect(h.disconnected()).toBe(true);
});

test('RPC and refresh replies follow the new consumer wire contract', async () => {
  const h = harness(), request = { path: 'capabilities', method: 'GET' };
  h.dispatch({ type: 'atlas-preview.rpc', id: 'rpc', root: 'root', request });
  h.dispatch({ type: 'atlas-preview.refresh', id: 'refresh' }); await drain();
  expect(h.calls[0]).toMatchObject({ kind: 'rpc', root: 'root', request });
  expect(h.replies.find((reply) => reply.id === 'rpc')).toMatchObject({ type: 'atlas-preview.rpc.result', response: { status: 200, body: { ok: true } } });
  expect(h.replies.find((reply) => reply.id === 'refresh')).toMatchObject({ type: 'atlas-preview.refresh.result', version: 2 }); h.close();
});

import { readFile, writeFile } from 'node:fs/promises';
import { FipsNode, generateIdentity, identityFromSecretKey, type Logger } from '@fips/core';
import { WebSocketTransport } from '@fips/transport-websocket';
import { TcpBlobTransport } from '@hashtree/fips-transport';
import { MemoryStore, fromHex, toHex, type Hash } from '@hashtree/core';

export interface AtlasFipsServiceOptions {
  keyPath: string;
  seedUrls: string[];
  getBlob: (hash: Hash) => Promise<Uint8Array | null>;
  requestTimeoutMs?: number;
  logger?: Logger;
  onServed?: (request: { hash: string; peerId: string; bytes: number; found: boolean }) => void;
}

/** Native Bun/Node server: authenticated FIPS packets over WSS, no HTTP blob path. */
export async function startAtlasFipsService(options: AtlasFipsServiceOptions) {
  let key: Uint8Array;
  try {
    const hex = (await readFile(options.keyPath, 'utf8')).trim();
    if (!/^[a-f0-9]{64}$/i.test(hex)) throw new Error('Invalid FIPS private-key file');
    key = fromHex(hex);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    key = crypto.getRandomValues(new Uint8Array(32));
    await writeFile(options.keyPath, toHex(key) + '\n', { mode: 0o600, flag: 'wx' });
  }
  const identity = await identityFromSecretKey(key);
  const websocket = new WebSocketTransport({ seedUrls: options.seedUrls, logger: options.logger });
  const node = new FipsNode({ identity, transports: [websocket], forwarding: false,
    routingMode: 'reply_learned', logger: options.logger });
  const connected = new Set<string>();
  node.on('peer', (event: { state?: string; remotePubkey?: string }) => {
    if (!event.remotePubkey) return;
    if (event.state === 'connected') connected.add(event.remotePubkey);
    else if (event.state === 'disconnected') connected.delete(event.remotePubkey);
  });
  let requests = 0, bytesServed = 0;
  const transport = new TcpBlobTransport({ endpoint: node, localStore: new MemoryStore(),
    timeoutMs: options.requestTimeoutMs ?? 30_000,
    serveBlob: async (hash, peerId, signal) => {
      signal.throwIfAborted();
      const bytes = await options.getBlob(hash);
      signal.throwIfAborted();
      requests += 1;
      bytesServed += bytes?.byteLength ?? 0;
      options.onServed?.({ hash: toHex(hash), peerId, bytes: bytes?.byteLength ?? 0, found: bytes !== null });
      return bytes;
    },
  });
  try { await node.start(); } catch (error) { await transport.close(); await node.stop(); throw error; }
  let stopped = false;
  return {
    peerId: toHex(identity.publicKey), node, transport,
    status: () => ({ peerId: toHex(identity.publicKey), connectedPeers: [...connected], requests, bytesServed,
      websocket: websocket.stats() }),
    stop: async () => { if (stopped) return; stopped = true; await transport.close(); await node.stop(); },
  };
}

export async function createFipsReader(seedUrls: string[]) {
  const node = new FipsNode({ identity: await generateIdentity(),
    transports: [new WebSocketTransport({ seedUrls })], forwarding: false, routingMode: 'reply_learned' });
  const transport = new TcpBlobTransport({ endpoint: node, localStore: new MemoryStore(), timeoutMs: 30_000,
    allowIncomingPeer: () => false });
  await node.start();
  return { node, transport, stop: async () => { await transport.close(); await node.stop(); } };
}

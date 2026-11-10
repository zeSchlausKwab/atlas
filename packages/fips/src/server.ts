import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  FipsNode,
  identityFromSecretKey,
  type Transport,
  type PeerEvent,
} from "@fips/core";
import { WebSocketTransport } from "@fips/transport-websocket";
import { fromHex, toHex } from "@hashtree/core";
import { TcpBlobTransport } from "./vendor/tcpBlobTransport";
import { FipsRpcEndpoint, type FipsRpcHandler } from "./rpc";

export const DEFAULT_FIPS_SEEDS = [
  "wss://fips1.iris.to/fips",
  "wss://fips2.iris.to/fips",
];
export const discardStore = {
  get: async () => null,
  put: async () => false,
  has: async () => false,
  delete: async () => false,
};
export interface FipsServerOptions {
  keyPath: string;
  seedUrls: string[];
  getBlob: (hash: string) => Promise<Uint8Array | null>;
  rpc?: FipsRpcHandler;
  /** Injectable authenticated carrier for offline integration tests. */
  transports?: Transport[];
}
export async function startFipsServer(options: FipsServerOptions) {
  await mkdir(dirname(options.keyPath), { recursive: true });
  let key: Uint8Array;
  try {
    const raw = (await readFile(options.keyPath, "utf8")).trim();
    if (!/^[a-f0-9]{64}$/i.test(raw))
      throw new Error("Invalid FIPS identity file");
    key = fromHex(raw);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    key = crypto.getRandomValues(new Uint8Array(32));
    await writeFile(options.keyPath, toHex(key) + "\n", {
      mode: 0o600,
      flag: "wx",
    });
  }
  const identity = await identityFromSecretKey(key);
  const websocket = options.transports
    ? undefined
    : new WebSocketTransport({ seedUrls: options.seedUrls });
  const node = new FipsNode({
    identity,
    transports: options.transports ?? [websocket!],
    forwarding: false,
    routingMode: "reply_learned",
  });
  const connected = new Set<string>();
  node.on("peer", (raw) => {
    const event = raw as PeerEvent;
    if (event.state === "connected") connected.add(event.remotePubkey);
    else if (event.state === "disconnected")
      connected.delete(event.remotePubkey);
  });
  let requests = 0,
    bytesServed = 0,
    rpcRequests = 0;
  const blobs = new TcpBlobTransport({
    endpoint: node,
    localStore: discardStore,
    timeoutMs: 30000,
    serveBlob: async (hash, _peer, signal) => {
      signal.throwIfAborted();
      const bytes = await options.getBlob(toHex(hash));
      signal.throwIfAborted();
      if (bytes && bytes.length > 2 * 1024 ** 2)
        throw new Error("Atlas blob exceeds 2 MiB");
      requests++;
      bytesServed += bytes?.length ?? 0;
      return bytes;
    },
  });
  const rpc = options.rpc
    ? new FipsRpcEndpoint(node, async (...args) => {
        rpcRequests++;
        return options.rpc!(...args);
      })
    : undefined;
  let closed = false;
  const stop = async () => {
    if (closed) return;
    closed = true;
    await Promise.all([blobs.close(), rpc?.close()]);
    await node.stop();
  };
  try {
    await node.start();
  } catch (error) {
    await stop();
    throw error;
  }
  return {
    peerId: toHex(identity.publicKey),
    node,
    status: () => ({
      peerId: toHex(identity.publicKey),
      connectedPeers: [...connected],
      requests,
      bytesServed,
      rpcRequests,
      websocket: websocket?.stats(),
    }),
    stop,
  };
}

import { rename, writeFile, rm } from "node:fs/promises";
import { dirname, join, basename } from "node:path";

export interface PublicFipsStatus {
  version: 1;
  updatedAt: string;
  startedAt: string;
  lastActivityAt: string | null;
  state: "connected" | "connecting" | "stopped";
  descriptor: {
    type: "atlas-fips";
    version: 1;
    peerId: string;
    root: string;
    bytes: number;
    chunkBytes: number;
    servicePort: number;
    seedUrls: string[];
  };
  mapName: string;
  requestTimeoutMs: number;
  connectedPeers: number;
  counters: {
    blobLookups: number;
    blobBytes: number;
    framesSent: number;
    framesReceived: number;
    bytesSent: number;
    bytesReceived: number;
    reconnects: number;
    invalidFrames: number;
  };
}

type Descriptor = PublicFipsStatus["descriptor"];
type ServiceStatus = {
  connectedPeers: readonly string[];
  requests: number;
  bytesServed: number;
  websocket: {
    framesSent: number;
    framesReceived: number;
    bytesSent: number;
    bytesReceived: number;
    reconnectsScheduled: number;
    invalidFrames: number;
  };
};

/** Explicit allowlist: the static host endpoint is public and must never contain process/config objects. */
export function publicFipsStatus(
  descriptor: Descriptor,
  status: ServiceStatus,
  options: {
    startedAt: string;
    lastActivityAt: string | null;
    mapName: string;
    requestTimeoutMs: number;
    stopped?: boolean;
  },
): PublicFipsStatus {
  const count = (n: number) =>
    Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    startedAt: options.startedAt,
    lastActivityAt: options.lastActivityAt,
    state: options.stopped
      ? "stopped"
      : status.connectedPeers.length
        ? "connected"
        : "connecting",
    descriptor: {
      type: "atlas-fips",
      version: 1,
      peerId: descriptor.peerId,
      root: descriptor.root,
      bytes: descriptor.bytes,
      chunkBytes: descriptor.chunkBytes,
      servicePort: descriptor.servicePort,
      seedUrls: descriptor.seedUrls.map((value) => {
        const url = new URL(value);
        return `${url.protocol}//${url.host}${url.pathname}`;
      }),
    },
    mapName: options.mapName.slice(0, 200),
    requestTimeoutMs: options.requestTimeoutMs,
    connectedPeers: status.connectedPeers.length,
    counters: {
      blobLookups: count(status.requests),
      blobBytes: count(status.bytesServed),
      framesSent: count(status.websocket.framesSent),
      framesReceived: count(status.websocket.framesReceived),
      bytesSent: count(status.websocket.bytesSent),
      bytesReceived: count(status.websocket.bytesReceived),
      reconnects: count(status.websocket.reconnectsScheduled),
      invalidFrames: count(status.websocket.invalidFrames),
    },
  };
}

/** Readers see either complete snapshot; hidden temporary files are rejected by Atlas static serving. */
export async function writePublicFipsStatus(
  path: string,
  status: PublicFipsStatus,
) {
  const temporary = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.tmp`,
  );
  try {
    await writeFile(temporary, JSON.stringify(status) + "\n", { mode: 0o644 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { publicFipsStatus, writePublicFipsStatus } from "./public-status";
import { fipsStatusView } from "../../apps/host/src/host-fips";

const descriptor = {
  type: "atlas-fips" as const,
  version: 1 as const,
  peerId: "02" + "1".repeat(64),
  root: "2".repeat(64),
  bytes: 16000,
  chunkBytes: 65536,
  servicePort: 39018,
  seedUrls: ["wss://user:password@seed.example/fips?secret=token#private"],
  keyPath: "/private/provider.key",
  indexPath: "/private/map.sqlite",
  secretKey: "private-key-must-not-escape",
};
const service = {
  connectedPeers: ["private-client-identity"],
  requests: 6,
  bytesServed: 393216,
  websocket: {
    framesSent: 20,
    framesReceived: 12,
    bytesSent: 400000,
    bytesReceived: 1400,
    reconnectsScheduled: 1,
    invalidFrames: 0,
  },
  privateKey: "private-key-must-not-escape",
};
const options = {
  startedAt: "2026-11-10T10:00:00.000Z",
  lastActivityAt: null,
  mapName: "Lower Rhine West",
  requestTimeoutMs: 30000,
};

test("public provider status uses an allowlist and strips seed credentials and private topology", () => {
  const status = publicFipsStatus(descriptor, service, options);
  expect(status.descriptor.seedUrls).toEqual(["wss://seed.example/fips"]);
  expect(status.connectedPeers).toBe(1);
  expect(status.counters.blobLookups).toBe(6);
  expect(status.state).toBe("connected");
  const json = JSON.stringify(status);
  for (const secret of [
    "private-client-identity",
    "/private/",
    "private-key-must-not-escape",
    "password",
    "secret=",
    "#private",
  ])
    expect(json).not.toContain(secret);
  expect(Object.keys(status.descriptor).sort()).toEqual(
    [
      "type",
      "version",
      "peerId",
      "root",
      "bytes",
      "chunkBytes",
      "servicePort",
      "seedUrls",
    ].sort(),
  );
});

test("host view distinguishes missing, stale, connecting and stopped providers", () => {
  const status = publicFipsStatus(descriptor, service, options);
  status.updatedAt = "2026-11-10T10:01:00.000Z";
  expect(fipsStatusView(undefined).state).toBe("unavailable");
  expect(
    fipsStatusView(status, Date.parse(status.updatedAt) + 10_000).state,
  ).toBe("connected");
  expect(fipsStatusView(status, Date.parse(status.updatedAt) + 31_000)).toEqual(
    { state: "stale", title: "Status is stale" },
  );
  expect(
    fipsStatusView(
      { ...status, state: "connecting" },
      Date.parse(status.updatedAt),
    ).state,
  ).toBe("connecting");
  expect(
    fipsStatusView(
      { ...status, state: "stopped" },
      Date.parse(status.updatedAt) + 60_000,
    ).state,
  ).toBe("stopped");
});

test("status snapshot replacement leaves complete JSON and no temporary artifacts", async () => {
  const dir = await mkdtemp("/tmp/atlas-fips-status-");
  try {
    const path = `${dir}/fips-status.json`;
    await writePublicFipsStatus(
      path,
      publicFipsStatus(descriptor, service, options),
    );
    await writePublicFipsStatus(
      path,
      publicFipsStatus(descriptor, service, { ...options, stopped: true }),
    );
    expect(JSON.parse(await readFile(path, "utf8")).state).toBe("stopped");
    expect(await readdir(dir)).toEqual(["fips-status.json"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("failed replacement removes its temporary snapshot", async () => {
  const dir = await mkdtemp("/tmp/atlas-fips-status-");
  try {
    const path = `${dir}/fips-status.json`;
    await mkdir(path);
    await expect(
      writePublicFipsStatus(
        path,
        publicFipsStatus(descriptor, service, options),
      ),
    ).rejects.toThrow();
    expect(await readdir(dir)).toEqual(["fips-status.json"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

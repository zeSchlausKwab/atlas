import { describe, expect, test } from "bun:test";
import { encodePackage } from "../packages/format/src/writer";
import {
  AtlasReader,
  FileSource,
  HttpSource,
} from "../packages/format/src/reader";
import {
  HEADER_SIZE,
  parseHeader,
  parseIndex,
  type Manifest,
} from "../packages/format/src/index";
import { parseRange, servePackage } from "../apps/server/ranges";
const manifest: Omit<Manifest, "snapshot"> = {
  format: "atlas",
  version: 1,
  name: "Fixture",
  source: { url: "fixture", sha256: "0".repeat(64), attribution: "Test" },
  bounds: [9, 47, 10, 48],
  minZoom: 9,
  maxZoom: 9,
  features: 3,
  peaks: 3,
  places: [],
  capabilities: ["peak-query"],
  limitations: [],
};
const peaks = [
  { id: "a", name: "Lower", coordinates: [9, 47], elevation: 800 },
  { id: "b", name: "Unknown", coordinates: [9, 47], elevation: null },
  { id: "c", name: "Highest", coordinates: [9, 47], elevation: 2000 },
];
const inputs = [
  {
    key: "query/peaks",
    bytes: new TextEncoder().encode(JSON.stringify(peaks)),
    features: 3,
  },
];
async function fixture() {
  return encodePackage(manifest, inputs);
}
describe("ATLAS format and query contract", () => {
  test("deterministic packages and independent query blocks", async () => {
    const a = await fixture();
    expect(a).toEqual(await fixture());
    const reader = await new AtlasReader(new FileSource(new Blob([a]))).open();
    expect(reader.bytesRead).toBe(reader.index.header.payloadOffset);
    expect(reader.bytesRead).toBeLessThan(a.length);
    const result = await reader.highestPeak();
    expect(result.peak?.name).toBe("Highest");
    expect(result.known).toBe(2);
    expect(result.unknown).toBe(1);
    expect(reader.requests).toBe(3);
  });
  test("offline misses fail explicitly; cached queries work without reads", async () => {
    const reader = await new AtlasReader(
      new FileSource(new Blob([await fixture()])),
    ).open();
    reader.offline = true;
    await expect(reader.highestPeak()).rejects.toThrow("Not cached");
    reader.offline = false;
    await reader.highestPeak();
    const reads = reader.requests;
    reader.offline = true;
    expect((await reader.highestPeak()).peak?.name).toBe("Highest");
    expect(reader.requests).toBe(reads);
  });
  test("concurrent queries share the same pending read", async () => {
    const reader = await new AtlasReader(
      new FileSource(new Blob([await fixture()])),
    ).open();
    await Promise.all([reader.highestPeak(), reader.highestPeak()]);
    expect(reader.requests).toBe(3);
  });
  test("corrupted blocks fail SHA-256 verification", async () => {
    const bytes = await fixture();
    bytes[bytes.length - 2] ^= 1;
    const reader = await new AtlasReader(
      new FileSource(new Blob([bytes])),
    ).open();
    await expect(reader.highestPeak()).rejects.toThrow(
      "Integrity check failed",
    );
    expect(reader.cache.size).toBe(0);
  });
  test("malformed and truncated headers and indexes are rejected", async () => {
    const bytes = await fixture();
    expect(() => parseHeader(bytes.slice(0, 12))).toThrow();
    const wrongVersion = bytes.slice(0, 32);
    new DataView(wrongVersion.buffer).setUint32(8, 99, true);
    expect(() => parseHeader(wrongVersion)).toThrow("version");
    const header = parseHeader(bytes.slice(0, 32));
    expect(() =>
      parseIndex(header, bytes.slice(32, header.payloadOffset - 1)),
    ).toThrow("Truncated");
    const wrongOffset = bytes.slice(0, 32);
    new DataView(wrongOffset.buffer).setUint32(20, 0, true);
    expect(() => parseHeader(wrongOffset)).toThrow("bounds");
  });
  test("directory cannot point outside payload", async () => {
    const bytes = await fixture();
    const header = parseHeader(bytes.slice(0, 32));
    const meta = bytes.slice(32, header.payloadOffset);
    const blocks = JSON.parse(
      new TextDecoder().decode(meta.slice(header.manifestLength)),
    );
    blocks[0].offset = 900000;
    const directory = new TextEncoder().encode(JSON.stringify(blocks));
    const malformed = new Uint8Array(header.manifestLength + directory.length);
    malformed.set(meta.slice(0, header.manifestLength));
    malformed.set(directory, header.manifestLength);
    expect(() =>
      parseIndex(
        {
          ...header,
          directoryLength: directory.length,
          payloadOffset: 32 + malformed.length,
        },
        malformed,
      ),
    ).toThrow("directory");
  });
});
describe("HTTP delivery", () => {
  test("closed, open, suffix and unsatisfiable ranges", () => {
    expect(parseRange("bytes=2-5", 10)).toEqual([2, 5]);
    expect(parseRange("bytes=7-", 10)).toEqual([7, 9]);
    expect(parseRange("bytes=-3", 10)).toEqual([7, 9]);
    expect(parseRange("bytes=2-100", 10)).toEqual([2, 9]);
    for (const range of [
      "bytes=10-",
      "bytes=-0",
      "bytes=5-3",
      "bytes=0-1,3-4",
      "bytes=-",
      "bytes=1e2-",
      "invalid",
    ])
      expect(parseRange(range, 10)).toBeNull();
  });
  test("correct 206 bytes, 416, HEAD and snapshot preconditions", async () => {
    const blob = new Blob(["0123456789"]);
    const request = (headers: Record<string, string>, method = "GET") =>
      new Request("http://localhost/map", { headers, method });
    const response = servePackage(
      request({ Range: "bytes=2-5" }),
      blob,
      '"v1"',
    );
    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe("bytes 2-5/10");
    expect(await response.text()).toBe("2345");
    expect(
      servePackage(request({ Range: "bytes=10-" }), blob, '"v1"').status,
    ).toBe(416);
    expect(
      servePackage(request({ "If-Match": '"v0"' }), blob, '"v1"').status,
    ).toBe(412);
    const head = servePackage(request({}, "HEAD"), blob, '"v1"');
    expect(head.headers.get("content-length")).toBe("10");
    expect(await head.text()).toBe("");
    expect(servePackage(request({}, "OPTIONS"), blob, '"v1"').status).toBe(204);
  });
  test("real range server and HTTP reader round trip, including version change", async () => {
    const blob = new Blob([await fixture()]);
    let etag = '"v1"';
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (r) => servePackage(r, blob, etag),
    });
    try {
      const reader = await new AtlasReader(
        new HttpSource(server.url.toString()),
      ).open();
      expect((await reader.highestPeak()).peak?.name).toBe("Highest");
      const other = await new AtlasReader(
        new HttpSource(server.url.toString()),
      ).open();
      etag = '"v2"';
      await expect(other.highestPeak()).rejects.toThrow("Package changed");
    } finally {
      server.stop(true);
    }
  });
});

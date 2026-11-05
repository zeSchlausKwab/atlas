import { expect, test } from "bun:test";
import { consumeRoutingOutput } from "../packages/cli/src/routing-output";
const text = new TextEncoder();
function frame(key: string, body = new Uint8Array()) {
  const k = text.encode(key),
    out = new Uint8Array(8 + k.length + body.length);
  const v = new DataView(out.buffer);
  v.setUint32(0, k.length, true);
  v.setUint32(4, body.length, true);
  out.set(k, 8);
  out.set(body, 8 + k.length);
  return out;
}
const protocol = () =>
  frame(
    "protocol",
    text.encode(JSON.stringify({ version: 1, windowBytes: 1024 ** 2 })),
  );
const metadata = () =>
  frame("metadata", text.encode('{"walking":{"count":2}}'));
function cell(id: number, size = 40) {
  const body = new Uint8Array(size);
  body.set(text.encode("RCL3"));
  new DataView(body.buffer).setUint32(24, id, true);
  return frame(`routing/walking/cells/14/${id}/12`, body);
}
async function* parts(frames: Uint8Array[], split = 0) {
  for (const f of frames) {
    if (split) {
      yield f.subarray(0, split);
      yield f.subarray(split);
    } else yield f;
  }
}
test("producer credit follows completed slow archive writes, across split frames", async () => {
  let written = 0,
    acknowledgments = 0;
  const started = Promise.withResolvers<void>(),
    finish = Promise.withResolvers<void>();
  const result = consumeRoutingOutput(
    {
      add: async () => {
        if (!written) {
          started.resolve();
          await finish.promise;
        }
        written++;
      },
    },
    parts(
      [protocol(), cell(1), frame("ack"), cell(2), frame("ack"), metadata()],
      3,
    ),
    ["walking"],
    true,
    async () => {
      expect(written).toBe(++acknowledgments);
    },
  );
  await started.promise;
  expect(acknowledgments).toBe(0);
  finish.resolve();
  expect(await result).toEqual({ walking: { count: 2 } });
  expect(acknowledgments).toBe(2);
});
test("unselected profiles are consumed and acknowledged without writing", async () => {
  let acks = 0;
  await consumeRoutingOutput(
    {
      add: async () => {
        throw Error("unexpected write");
      },
    },
    parts([protocol(), cell(1), frame("ack"), metadata()]),
    ["driving"],
    true,
    async () => {
      acks++;
    },
  );
  expect(acks).toBe(1);
});
test("missing credit boundaries cannot grow an unbounded output queue", async () => {
  await expect(
    consumeRoutingOutput(
      { add: async () => {} },
      parts([protocol(), cell(1, 600000), cell(2, 600000)]),
      ["walking"],
      true,
      async () => {},
    ),
  ).rejects.toThrow("output window");
});
test("older native binary fails early with a rebuild instruction", async () => {
  await expect(
    consumeRoutingOutput(
      { add: async () => {} },
      parts([cell(1)]),
      ["walking"],
      true,
      async () => {},
    ),
  ).rejects.toThrow("rebuild transport-partitioned");
});
test("bad lengths report the exact stream position before payload allocation", async () => {
  const bad = new Uint8Array(8);
  const v = new DataView(bad.buffer);
  v.setUint32(0, 20, true);
  v.setUint32(4, 33 * 1024 ** 2, true);
  await expect(
    consumeRoutingOutput(
      { add: async () => {} },
      parts([protocol(), bad]),
      [],
      true,
      async () => {},
    ),
  ).rejects.toThrow(
    /at byte \d+ after protocol: key 20 bytes, payload 34603008 bytes/,
  );
});
test("truncation, missing final metadata and malformed credit never silently succeed", async () => {
  for (const frames of [
    [protocol(), cell(1).slice(0, -1)],
    [protocol(), cell(1), frame("ack")],
    [protocol(), frame("ack")],
    [protocol(), cell(1), metadata()],
  ]) {
    await expect(
      consumeRoutingOutput(
        { add: async () => {} },
        parts(frames),
        [],
        true,
        async () => {},
      ),
    ).rejects.toThrow();
  }
});
test("cancellation does not release another batch", async () => {
  const abort = new AbortController();
  let ack = false;
  await expect(
    consumeRoutingOutput(
      {
        add: async () => {
          abort.abort();
        },
      },
      parts([protocol(), cell(1), frame("ack")]),
      ["walking"],
      true,
      async () => {
        ack = true;
      },
      abort.signal,
    ),
  ).rejects.toThrow();
  expect(ack).toBe(false);
});

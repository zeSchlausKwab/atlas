import { expect, test } from "bun:test";
import {
  modelSchema,
  completionStream,
  type Completion,
  type ToolCall,
  type ToolDefinition,
  type WireMessage,
} from "../packages/chat/src/protocol";
import { AtlasAgentSession, type AgentTools } from "../packages/chat/src/agent";
import { ChatDataRuntime } from "../packages/chat/src/data";
import {
  GeometryResults,
  collection,
  validateDrawing,
} from "../packages/chat/src/geometry";
import { chatProxy } from "../apps/web/chat-proxy";
import { workspaceFixture, taskBounds } from "./helpers/workspace-fixture";
const signal = () => new AbortController().signal;
const call = (name: string, args: unknown, id = "call-1"): ToolCall => ({
  id,
  type: "function",
  function: { name, arguments: JSON.stringify(args) },
});
const definition: ToolDefinition = {
  type: "function",
  function: {
    name: "query",
    description: "test",
    parameters: { type: "object" },
  },
};
const answer = (calls: ToolCall[] = [], content = ""): Completion => ({
  content,
  calls,
});
const sse = (frames: unknown[], finish = "stop") =>
  frames.map((f) => `data: ${JSON.stringify(f)}\r\n\r\n`).join("") +
  `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: finish }] })}\r\n\r\ndata: [DONE]\r\n\r\n`;
function response(text: string, chunk = 3) {
  const bytes = new TextEncoder().encode(text);
  let pos = 0;
  return new Response(
    new ReadableStream({
      pull(c) {
        if (pos === bytes.length) c.close();
        else {
          c.enqueue(bytes.slice(pos, pos + chunk));
          pos = Math.min(bytes.length, pos + chunk);
        }
      },
    }),
    { headers: { "Content-Type": "text/event-stream" } },
  );
}
test("model stream reconstructs split UTF-8, CRLF and multiple function arguments", async () => {
  const out = await completionStream(
    response(
      sse(
        [
          { choices: [{ delta: { content: "Straße ☕" } }] },
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: "a",
                      function: { name: "query", arguments: '{"x":' },
                    },
                    {
                      index: 1,
                      id: "b",
                      function: { name: "draw", arguments: "{}" },
                    },
                  ],
                },
              },
            ],
          },
          {
            choices: [
              {
                delta: {
                  tool_calls: [{ index: 0, function: { arguments: "2}" } }],
                },
              },
            ],
          },
        ],
        "tool_calls",
      ),
      1,
    ),
    signal(),
    () => {},
  );
  expect(out.content).toBe("Straße ☕");
  expect(out.calls.map((c) => c.function.arguments)).toEqual(['{"x":2}', "{}"]);
});
test("truncated, invalid and cancelled streams cannot dispatch partial tool calls", async () => {
  await expect(
    completionStream(
      response(
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"a","function":{"name":"query","arguments":"{}"}}]}}]}\n\n',
      ),
      signal(),
      () => {},
    ),
  ).rejects.toThrow("before completion");
  await expect(
    completionStream(response(sse([], "length")), signal(), () => {}),
  ).rejects.toThrow("incomplete");
  const abort = new AbortController();
  abort.abort();
  await expect(
    completionStream(response(sse([])), abort.signal, () => {}),
  ).rejects.toBeDefined();
});
test("agent serializes tools and retains complete tool exchanges after invalid arguments", async () => {
  let round = 0;
  const executed: string[] = [],
    histories: WireMessage[][] = [];
  const tools: AgentTools = {
    definitions: async () => [definition],
    context: () => ({}),
    execute: async (n, a) => {
      executed.push(n);
      return { count: 3 };
    },
  };
  const agent = new AtlasAgentSession(tools, async (messages) => {
    histories.push(structuredClone(messages));
    return ++round === 1
      ? answer([
          call("unknown", {}),
          {
            ...call("query", {}, "call-2"),
            function: { name: "query", arguments: "{" },
          },
          call("query", {}, "call-3"),
        ])
      : answer([], "Three objects.");
  });
  await agent.send("Count here");
  expect(executed).toEqual(["query"]);
  expect(
    histories[1]!.filter((m) => m.role === "tool").map((m) => m.tool_call_id),
  ).toEqual(["call-1", "call-2", "call-3"]);
  expect(agent.getSnapshot().messages.at(-1)?.text).toBe("Three objects.");
});
test("stopping during a tool prevents remaining calls and preserves provider history", async () => {
  let started!: () => void;
  const begun = new Promise<void>((r) => (started = r));
  let executed = 0,
    round = 0;
  const history: WireMessage[][] = [];
  const tools: AgentTools = {
    definitions: async () => [definition],
    context: () => ({}),
    execute: async (n, a, s) => {
      executed++;
      started();
      return new Promise((_, reject) =>
        s.addEventListener("abort", () => reject(s.reason), { once: true }),
      );
    },
  };
  const agent = new AtlasAgentSession(tools, async (messages) => {
    history.push(structuredClone(messages));
    return ++round === 1
      ? answer([call("query", {}), call("query", {}, "b")])
      : answer([], "Resumed");
  });
  const pending = agent.send("Start");
  await begun;
  agent.cancel();
  await pending;
  expect(executed).toBe(1);
  expect(agent.getSnapshot().running).toBe(false);
  await agent.send("Continue");
  const results = history[1]!.filter((m) => m.role === "tool");
  expect(results).toHaveLength(2);
  expect(
    results.every((r) => JSON.parse(r.content!).code === "cancelled"),
  ).toBe(true);
});
test("local task analysis deduplicates overlap, preserves unknowns and draws without new reads", async () => {
  let reads = 0;
  const a = await workspaceFixture(
      [16, 48, 16.012, 48.02],
      "18",
      () => reads++,
    ),
    b = await workspaceFixture([16.008, 48, 16.02, 48.02], "18", () => reads++);
  const runtime = new ChatDataRuntime([a.reader, b.reader]);
  try {
    const p = await runtime.invoke(
      "workspace_prepare",
      {
        bounds: taskBounds,
        families: ["buildings", "locations"],
        geometry: true,
      },
      signal(),
    );
    const baseline = reads;
    a.reader.dispose();
    b.reader.dispose();
    const q = await runtime.invoke(
      "workspace_query",
      { workspace: p.workspace },
      signal(),
    );
    expect(q.count).toBe(4);
    const stats = await runtime.invoke(
      "analyze",
      { result: q.result, operation: "stats", field: "heightMeters" },
      signal(),
    );
    expect(stats).toMatchObject({ known: 1, unknown: 3, min: 18, mean: 18 });
    const groups = await runtime.invoke(
      "analyze",
      { result: q.result, operation: "group", field: "tags.wheelchair" },
      signal(),
    );
    expect(groups.groups).toContainEqual({ value: "yes", count: 1 });
    expect(groups.unknown).toBe(3);
    const tall = await runtime.invoke(
      "workspace_query",
      {
        workspace: p.workspace,
        where: [{ field: "heightMeters", op: "gte", value: 15 }],
      },
      signal(),
    );
    expect(
      (await runtime.resolve(tall.result)).collection.features,
    ).toHaveLength(1);
    const region = runtime.results.save(
      collection({
        type: "Polygon",
        coordinates: [
          [
            [16, 48],
            [16.008, 48],
            [16.008, 48.008],
            [16, 48.008],
            [16, 48],
          ],
        ],
      }),
      { approximate: true },
    );
    const inside = await runtime.invoke(
      "analyze",
      { result: q.result, operation: "within", regionResult: region.result },
      signal(),
    );
    expect(inside.count).toBe(1);
    expect(inside.region.approximate).toBe(true);
    expect(inside.execution.sourceBytes).toBe(0);
    expect(reads).toBe(baseline);
    await expect(
      runtime.invoke(
        "workspace_result",
        { result: q.result, fields: ["geometry"] },
        signal(),
      ),
    ).rejects.toThrow("raw geometry");
    runtime.clear();
    await expect(runtime.resolve(q.result)).rejects.toThrow("expired");
  } finally {
    runtime.clear();
    a.reader.dispose();
    b.reader.dispose();
  }
});
test("attribute-only workspaces cannot invent drawable shapes", async () => {
  const { reader } = await workspaceFixture(),
    r = new ChatDataRuntime([reader]);
  try {
    const p = await r.invoke(
      "workspace_prepare",
      { bounds: taskBounds, families: ["buildings"], geometry: false },
      signal(),
    );
    const q = await r.invoke(
      "workspace_query",
      { workspace: p.workspace },
      signal(),
    );
    await expect(r.resolve(q.result)).rejects.toThrow("no shapes");
  } finally {
    r.clear();
    reader.dispose();
  }
});
test("drawing validation rejects malformed geometry and result storage is isolated", () => {
  expect(() =>
    validateDrawing(collection({ type: "Point", coordinates: [500, 48] })),
  ).toThrow("coordinates");
  expect(() =>
    validateDrawing(
      collection({
        type: "Polygon",
        coordinates: [
          [
            [0, 0],
            [1, 0],
            [1, 1],
            [0, 1],
          ],
        ],
      }),
    ),
  ).toThrow("closed");
  const store = new GeometryResults(),
    fc = collection({ type: "Point", coordinates: [16, 48] });
  const r = store.save(fc, {});
  fc.features.length = 0;
  expect(store.get(r.result).collection.features).toHaveLength(1);
  store.clear();
  expect(() => store.get(r.result)).toThrow("expired");
});
const request = (data: unknown, origin = "http://localhost:5173") =>
  new Request("http://localhost:5173/api/chat/completions", {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify(data),
  });
const input = {
  messages: [{ role: "user", content: "Hi" }],
  tools: [definition],
};
test("inference proxy protects the key, pins provider/model, and rejects cross-origin calls", async () => {
  let forwarded: any,
    auth = "",
    url = "";
  const proxy = chatProxy({
    key: "synthetic-secret",
    fetch: (async (u: string, init: RequestInit) => {
      url = String(u);
      forwarded = JSON.parse(String(init!.body));
      auth = new Headers(init!.headers).get("authorization")!;
      return response(sse([]));
    }) as unknown as typeof fetch,
  });
  expect((await proxy(request(input, "https://other.example")))!.status).toBe(
    403,
  );
  const status = await proxy(
    new Request("http://localhost:5173/api/chat/status"),
  );
  expect(await status!.text()).not.toContain("synthetic-secret");
  const out = await proxy(
    request({
      ...input,
      model: "other",
      url: "https://evil.example",
      apiKey: "ignore",
    }),
  );
  await out!.text();
  expect(url).toBe("https://api.deepseek.com/chat/completions");
  expect(auth).toBe("Bearer synthetic-secret");
  expect(forwarded.model).toBe("deepseek-flash");
  expect(forwarded.thinking.type).toBe("enabled");
  expect(forwarded.max_tokens).toBeUndefined();
  expect(forwarded.apiKey).toBeUndefined();
});
test("proxy permits concurrent requests and propagates stream cancellation", async () => {
  const proxy = chatProxy({
    key: "test",
    fetch: (async () =>
      new Response(new ReadableStream(), {
        headers: { "Content-Type": "text/event-stream" },
      })) as unknown as typeof fetch,
  });
  for (let i = 0; i < 4; i++)
    expect((await proxy(request({})))!.status).toBe(400);
  const a = (await proxy(request(input)))!,
    b = (await proxy(request(input)))!;
  const third = (await proxy(request(input)))!;
  expect(third.status).toBe(200);
  await third.body!.cancel();
  await a.body!.cancel();
  await b.body!.cancel();
  const c = (await proxy(request(input)))!;
  expect(c.status).toBe(200);
  await c.body!.cancel();
  const failed = chatProxy({
    key: "test",
    fetch: (async () =>
      new Response("secret upstream error", {
        status: 401,
      })) as unknown as typeof fetch,
  });
  for (let i = 0; i < 3; i++) {
    const r = (await failed(request(input)))!;
    expect(r.status).toBe(502);
    expect(await r.text()).not.toContain("secret upstream error");
  }
});

test("model schemas adapt tuple arrays without changing local validation contracts", () => {
  const local = {
    type: "object",
    properties: {
      point: {
        type: "array",
        items: [
          { type: "number", minimum: -180, maximum: 180 },
          { type: "number", minimum: -85, maximum: 85 },
        ],
        minItems: 2,
        maxItems: 2,
      },
    },
  };
  const adapted = modelSchema(local) as any;
  expect(adapted.properties.point.items.anyOf).toHaveLength(2);
  expect(Array.isArray(local.properties.point.items)).toBe(true);
  expect(adapted.properties.point.minItems).toBe(2);
});

test("bounded address/place candidates disclose omitted matches", async () => {
  const { reader } = await workspaceFixture(),
    r = new ChatDataRuntime([reader]);
  try {
    const found = await r.invoke(
      "search",
      { query: "Coffee", limit: 1 },
      signal(),
    );
    expect(found.matches).toHaveLength(1);
    expect(found.truncated).toBe(true);
    expect(found.sourceMatchCounts[0].total).toBe(2);
  } finally {
    r.clear();
    reader.dispose();
  }
});

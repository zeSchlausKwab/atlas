import { expect, test } from "bun:test";
import { AtlasAgentSession, type AgentTools } from "../packages/chat/src/agent";
import {
  completionStream,
  type WireMessage,
} from "../packages/chat/src/protocol";
import { ChatDataRuntime } from "../packages/chat/src/data";
import { AtlasWorkspace } from "../packages/workspace/src/index";
import { workspaceFixture, taskBounds } from "./helpers/workspace-fixture";
import { GeometryResults, collection } from "../packages/chat/src/geometry";

test("interactive chat continues past 12 rounds and 32 tools without dropping history or reasoning", async () => {
  let rounds = 0,
    calls = 0;
  const tools: AgentTools = {
    context: () => ({}),
    definitions: async () => [
      {
        type: "function",
        function: {
          name: "query",
          description: "",
          parameters: { type: "object" },
        },
      },
    ],
    execute: async () => {
      calls++;
      return { text: "x".repeat(70000) };
    },
  };
  const histories: WireMessage[][] = [];
  const agent = new AtlasAgentSession(
    tools,
    async (messages, _, signal, text, reasoning) => {
      histories.push(structuredClone(messages));
      reasoning?.("streamed thought " + rounds);
      if (++rounds > 17)
        return { content: "Done", reasoning: "final reasoning", calls: [] };
      return {
        content: "",
        reasoning: "reasoning " + rounds,
        calls: [0, 1].map((n) => ({
          id: `${rounds}-${n}`,
          type: "function" as const,
          function: { name: "query", arguments: "{}" },
        })),
      };
    },
  );
  await agent.send("long request " + "a".repeat(9000));
  expect(calls).toBe(34);
  expect(agent.getSnapshot().rounds).toBe(18);
  expect(agent.getSnapshot().error).toBeUndefined();
  expect(agent.getSnapshot().messages.at(-1)?.reasoning).toBe(
    "final reasoning",
  );
  expect(histories.at(-1)!.filter((m) => m.role === "tool")).toHaveLength(34);
  expect(
    histories
      .at(-1)!
      .filter((m) => m.tool_calls)
      .every((m) => !!m.reasoning_content),
  ).toBe(true);
  for (let i = 0; i < 10; i++) await agent.send("follow-up " + i);
  expect(histories.at(-1)!.filter((m) => m.role === "user")).toHaveLength(11);
  expect(
    histories.at(-1)!.some((m) => m.reasoning_content === "final reasoning"),
  ).toBe(true);
});

test("reasoning deltas are streamed and retained separately from answer text", async () => {
  const deltas = [
    { reasoning_content: "First " },
    { reasoning_content: "consider ☕" },
    { content: "Answer" },
  ];
  const stream =
    deltas
      .map(
        (delta) => "data: " + JSON.stringify({ choices: [{ delta }] }) + "\n\n",
      )
      .join("") +
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
  const thoughts: string[] = [],
    answers: string[] = [];
  const result = await completionStream(
    new Response(stream, { headers: { "Content-Type": "text/event-stream" } }),
    new AbortController().signal,
    (t) => answers.push(t),
    (t) => thoughts.push(t),
  );
  expect(thoughts).toEqual(["First ", "First consider ☕"]);
  expect(answers).toEqual(["Answer"]);
  expect(result.reasoning).toBe("First consider ☕");
});

test("interactive workspaces keep data and handles while host policy stays bounded", async () => {
  const { reader } = await workspaceFixture();
  const host = new AtlasWorkspace([reader]),
    data = new ChatDataRuntime([reader]);
  try {
    await expect(
      host.prepare({
        bounds: taskBounds,
        families: ["buildings"],
        maxMemoryBytes: 1,
      }),
    ).rejects.toThrow("memory estimate");
    const prepare = data
      .definitions()
      .find((d) => d.id === "workspace_prepare")!;
    expect(
      (prepare.inputSchema as any).properties.maxMemoryBytes,
    ).toBeUndefined();
    for (let i = 0; i < 3; i++) {
      const p = await data.invoke(
        "workspace_prepare",
        { bounds: taskBounds, families: ["buildings"] },
        new AbortController().signal,
      );
      expect(p.expiresAt).toBe(Number.MAX_SAFE_INTEGER);
      for (let n = 0; n < 70; n++)
        data.workspace.query({ workspace: p.workspace });
      const result = data.workspace.query({ workspace: p.workspace });
      expect(data.workspace.result(result.result).count).toBe(result.count);
    }
  } finally {
    host.clear();
    data.clear();
    reader.dispose();
  }
});

test("drawing result references have no count cap or time expiration", () => {
  const store = new GeometryResults();
  for (let i = 0; i < 40; i++) {
    const result = store.save(
      collection({ type: "Point", coordinates: [16, 48] }),
      {},
    );
    expect(result.expiresAt).toBe(Number.MAX_SAFE_INTEGER);
    expect(store.get(result.result).collection.features).toHaveLength(1);
  }
  store.clear();
});

test("QuickJS operates on frozen cached rows, emits geometry, isolates runs and denies host APIs", async () => {
  const { runCode } = await import("../packages/chat/src/sandbox");
  const fc = collection({ type: "Point", coordinates: [16, 48] });
  const result = await runCode(
    `
    console.log('rows', data.rows.length);
    emit(data.collection);
    return { count: data.rows.filter(r => r.height >= 20).length, frozen: Object.isFrozen(data.rows), network: typeof fetch, node: typeof process, dom: typeof document };
  `,
    { rows: [{ height: 10 }, { height: 30 }], collection: fc },
  );
  expect(result.value).toEqual({
    count: 1,
    frozen: true,
    network: "undefined",
    node: "undefined",
    dom: "undefined",
  });
  expect(result.console).toEqual(["rows 2"]);
  expect(result.collection).toEqual(fc);
  expect((await runCode("globalThis.leak = 1; return 1;", {})).value).toBe(1);
  expect((await runCode("return typeof leak;", {})).value).toBe("undefined");
  await expect(runCode("data.x = 2;", { x: 1 })).rejects.toThrow();
  await expect(
    runCode("emit(data.collection); throw new Error('failed calculation');", {
      collection: fc,
    }),
  ).rejects.toThrow("failed calculation");
  await expect(
    runCode("return fetch('https://example.com');", {}),
  ).rejects.toThrow();
  await expect(runCode("return Promise.resolve(1);", {})).rejects.toThrow(
    "synchronous",
  );
  await expect(runCode("throw null;", {})).rejects.toThrow("null");
  await expect(runCode("return 1n;", {})).rejects.toThrow("JSON-serializable");
  await expect(
    runCode("const x = {}; x.self=x; return x;", {}),
  ).rejects.toThrow("JSON-serializable");
  expect(
    (
      await runCode("return geo.intersects(data.a,data.b);", {
        a: fc.features[0],
        b: fc.features[0],
      })
    ).value,
  ).toBe(true);
});

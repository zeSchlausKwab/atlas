import { expect, test } from "bun:test";
import { AtlasAgentSession, type AgentTools } from "../packages/chat/src/agent";
import type { WireMessage } from "../packages/chat/src/protocol";
import { collection } from "../packages/chat/src/geometry";
import {
  featureStyle,
  contrastingInk,
  validateLayerStyle,
} from "../packages/chat/src/drawing-style";
import { ChatLayers } from "../apps/web/src/chat/layers";
import { project } from "../packages/format/src/index";

const point = (label: string | number = 0) =>
  collection(
    { type: "Point", coordinates: [16.38, 48.208] },
    { label, fill: "#2576aa", radius: 12 },
  );

test("labels and halos choose contrast for both pale and dark colors", () => {
  expect(contrastingInk("#ffffff")).toBe("#142b25");
  expect(contrastingInk("#000000")).toBe("#ffffff");
  expect(contrastingInk("#ffd966")).toBe("#142b25");
});

test("styles have explicit property bindings, preserve zero labels and unknown fallbacks", () => {
  const fc = point();
  const s = {
    colorProperty: "fill",
    labelProperty: "label",
    radiusProperty: "radius",
  };
  validateLayerStyle(fc, "#be5438", s, []);
  expect(featureStyle(fc.features[0]!, "#be5438", s)).toEqual({
    color: "#2576aa",
    radius: 12,
    label: "0",
  });
  fc.features[0]!.properties = { fill: null, label: null, radius: null };
  expect(featureStyle(fc.features[0]!, "#be5438", s)).toEqual({
    color: "#be5438",
    radius: 5,
    label: "",
  });
  expect(() =>
    validateLayerStyle(fc, "#be5438", { fillOpacity: 2 }, []),
  ).toThrow();
  expect(() =>
    validateLayerStyle(fc, "#be5438", { pointRadius: Infinity }, []),
  ).toThrow();
  expect(() =>
    validateLayerStyle(fc, "#be5438", {}, [{ color: "red", label: "Invalid" }]),
  ).toThrow();
});

test("restyling retains geometry, validates atomically, and can clear bindings and legends", () => {
  const map = { overlays: { add: () => () => {} }, invalidate: () => {} };
  const layers = new ChatLayers(map as any);
  const fc = point("stop");
  const first = layers.add(
    fc,
    "Stops",
    "#be5438",
    undefined,
    { labelProperty: "label" },
    [{ color: "#be5438", label: "Stops" }],
  );
  const geometry = layers.getSnapshot()[0]!.collection;
  fc.features[0]!.properties!.label = "mutated input";
  layers.restyle(first.layer, { style: { pointRadius: 14, fillOpacity: 0.5 } });
  expect(layers.getSnapshot()[0]!.collection).toBe(geometry);
  expect(geometry.features[0]!.properties!.label).toBe("stop");
  expect(layers.getSnapshot()[0]!.style.labelProperty).toBe("label");
  const before = layers.getSnapshot();
  expect(() =>
    layers.restyle(first.layer, { style: { radiusProperty: "label" } }),
  ).toThrow("radius");
  expect(layers.getSnapshot()).toBe(before);
  layers.restyle(first.layer, { legend: [], style: { labelProperty: null } });
  expect(layers.getSnapshot()[0]!.legend).toEqual([]);
  expect(layers.getSnapshot()[0]!.style.labelProperty).toBeNull();
  layers.undo(first.layer);
  expect(layers.getSnapshot()).toEqual([]);
});

test("numbered nearby stops get distinct on-map badges with leader lines", () => {
  const original = globalThis.Path2D;
  const operations: string[] = [];
  globalThis.Path2D = class {
    moveTo() {}
    lineTo() {}
    closePath() {}
    arc() {}
  } as any;
  let draw: any;
  const layers = new ChatLayers({
    overlays: {
      add: (overlay: any) => {
        draw = overlay.draw;
        return () => {};
      },
    },
    invalidate: () => {},
  } as any);
  const fc = point(1);
  fc.features.push({ ...point(2).features[0]! });
  layers.add(fc, "Nearby stops", "#2576aa", undefined, {
    labelProperty: "label",
    labelPlacement: "center",
    pointRadius: 12,
  });
  const labels: Array<[string, number, number]> = [];
  const ctx = {
    measureText: (text: string) => ({ width: text.length * 7 }),
    fill: () => {},
    stroke: () => {},
    beginPath: () => {},
    moveTo: () => {},
    lineTo: () => operations.push("leader"),
    arc: () => {},
    strokeText: () => {},
    fillText: (t: string, x: number, y: number) => labels.push([t, x, y]),
  };
  try {
    draw({
      camera: {
        center: project(16.38, 48.208),
        zoom: 16,
        width: 800,
        height: 600,
        pitch: 0,
        bearing: 0,
      },
      ctx,
    });
    expect(labels.map((l) => l[0])).toEqual(["1", "2"]);
    expect(labels[0]!.slice(1)).not.toEqual(labels[1]!.slice(1));
    expect(operations).toContain("leader");
  } finally {
    globalThis.Path2D = original;
  }
});

const fakeTools = (): AgentTools => ({
  context: () => ({ datasets: [{ name: "Vienna", snapshot: "abc" }] }),
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
  execute: async () => ({ count: 2, execution: { sourceBytes: 0 } }),
});

test("exports reconstruct model inputs with all reasoning, raw arguments, results and per-turn metrics", async () => {
  const inputs: WireMessage[][] = [];
  let round = 0;
  const agent = new AtlasAgentSession(fakeTools(), async (messages) => {
    inputs.push(structuredClone(messages));
    round++;
    return {
      content: "answer " + round,
      reasoning: "thought " + round,
      usage: { total_tokens: 10 },
      calls:
        round === 1
          ? [
              {
                id: "call-1",
                type: "function",
                function: { name: "query", arguments: '{ "number": 7 }' },
              },
            ]
          : [],
    };
  });
  await agent.send("first");
  await agent.send("follow up");
  const out = agent.exportConversation({
    layers: [{ collection: point(), style: { labelProperty: "label" } }],
  });
  expect(JSON.parse(JSON.stringify(out))).toEqual(out);
  expect(out.totals).toEqual({
    turns: 2,
    modelRounds: 3,
    reportedTokens: 30,
    toolCalls: 1,
  });
  expect(
    out.turns.every(
      (t) =>
        t.finishedAt && t.elapsedMs !== undefined && t.status === "complete",
    ),
  ).toBe(true);
  const flat = out.turns.flatMap((t) => t.messages);
  let i = 0;
  for (const t of out.turns)
    for (const r of t.rounds)
      expect([t.system, ...flat.slice(0, r.inputMessages)]).toEqual(
        inputs[i++]!,
      );
  const call = out.state.messages.find((m) => m.tools.length)!.tools[0]!;
  expect(call.argumentsText).toBe('{ "number": 7 }');
  expect(call.result).toEqual({ count: 2, execution: { sourceBytes: 0 } });
  expect(call.finishedAt).toBeDefined();
  expect(call.startedAt).toBeDefined();
  out.state.messages[0]!.text = "changed export";
  expect(agent.getSnapshot().messages[0]!.text).toBe("first");
  const id = out.sessionId;
  agent.clear();
  expect(agent.exportConversation().sessionId).not.toBe(id);
  expect(agent.exportConversation().turns).toHaveLength(0);
});

test("exports preserve partial streaming, cancellation and failed tool arguments", async () => {
  let ready!: () => void;
  const reached = new Promise<void>((r) => (ready = r));
  const agent = new AtlasAgentSession(
    fakeTools(),
    async (_m, _t, signal, text, reasoning) => {
      text("partial answer");
      reasoning?.("partial thought");
      ready();
      await new Promise((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        }),
      );
      return { content: "", calls: [] };
    },
  );
  const running = agent.send("cancel me");
  await reached;
  const partial = agent.exportConversation();
  expect(partial.state.running).toBe(true);
  expect(partial.state.messages.at(-1)?.reasoning).toBe("partial thought");
  expect(partial.turns[0]!.rounds[0]!.status).toBe("running");
  agent.cancel();
  await running;
  const stopped = agent.exportConversation();
  expect(stopped.turns[0]!.status).toBe("cancelled");
  expect(stopped.turns[0]!.rounds[0]!.status).toBe("cancelled");
  let step = 0;
  const bad = new AtlasAgentSession(fakeTools(), async () =>
    ++step === 1
      ? {
          content: "",
          calls: [
            {
              id: "bad",
              type: "function",
              function: { name: "query", arguments: "invalid JSON" },
            },
          ],
        }
      : { content: "fixed", calls: [] },
  );
  await bad.send("try");
  const call = bad
    .exportConversation()
    .state.messages.find((m) => m.tools.length)!.tools[0]!;
  expect(call.state).toBe("error");
  expect(call.argumentsText).toBe("invalid JSON");
  expect(call.result).toHaveProperty("error");
});

import { MarkdownTextPrimitive } from "@assistant-ui/react-markdown";
import { createPortal } from "react-dom";
import { createRoot } from "react-dom/client";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  AssistantRuntimeProvider,
  useExternalStoreRuntime,
  ThreadPrimitive,
  MessagePrimitive,
  ComposerPrimitive,
  type ThreadMessageLike,
  type ToolCallMessagePartProps,
  type ReasoningMessagePartProps,
} from "@assistant-ui/react";
import {
  AtlasAgentSession,
  type ChatMessage,
} from "../../../../packages/chat/src/agent";
import type { WorkspaceMap } from "../../../../packages/renderer/src/workspace-map";
import type { AtlasReader } from "../../../../packages/format/src/reader";
import { InsightsPanel } from "./insights-panel";
import { ChatTools } from "./tools";
const bytes = (n: number) =>
  n < 1000
    ? n + " B"
    : n < 1e6
      ? (n / 1000).toFixed(1) + " KB"
      : (n / 1e6).toFixed(2) + " MB";
const convert = (m: ChatMessage): ThreadMessageLike => ({
  id: m.id,
  role: m.role,
  content: [
    ...(m.reasoning ? [{ type: "reasoning" as const, text: m.reasoning }] : []),
    ...(m.text ? [{ type: "text" as const, text: m.text }] : []),
    ...m.tools.map((t) => ({
      type: "tool-call" as const,
      toolCallId: t.id,
      toolName: t.name,
      argsText: t.argumentsText ?? JSON.stringify(t.args),
      args: t.args as never,
      result: t.result,
      isError: t.state === "error",
      artifact: { elapsedMs: t.elapsedMs, progress: t.progress },
    })),
  ],
});
function Thinking({ text }: ReasoningMessagePartProps) {
  const scroll = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  useEffect(() => {
    if (scroll.current && following.current)
      scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [text]);
  return (
    <details className="chat-thinking" open>
      <summary>
        Thinking <small>DeepSeek</small>
      </summary>
      <div
        ref={scroll}
        className="chat-thinking-scroll"
        tabIndex={0}
        onScroll={() => {
          const el = scroll.current!;
          following.current =
            el.scrollHeight - el.scrollTop - el.clientHeight < 30;
        }}
      >
        {text}
      </div>
    </details>
  );
}
function TraceData({ title, value }: { title: string; value: unknown }) {
  const [open, setOpen] = useState(false);
  return (
    <details
      className="chat-trace-data"
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary>{title}</summary>
      {open && <pre tabIndex={0}>{JSON.stringify(value, null, 2)}</pre>}
    </details>
  );
}
function ToolCall({
  toolName,
  args,
  argsText,
  result,
  isError,
  artifact,
}: ToolCallMessagePartProps) {
  let input: unknown = args;
  try {
    if (argsText) input = JSON.parse(argsText);
  } catch {
    input = argsText;
  }
  const r = result as any,
    a = artifact as { elapsedMs?: number; progress?: string } | undefined;
  return (
    <details className={"chat-tool" + (isError ? " chat-tool-error" : "")}>
      <summary>
        <span>
          {result === undefined ? "◌" : isError ? "!" : "✓"}{" "}
          <code>{toolName}</code>
        </span>
        <small>
          {a?.elapsedMs !== undefined
            ? Math.round(a.elapsedMs) + " ms"
            : "working"}
        </small>
      </summary>
      {a?.progress && <p>{a.progress}</p>}
      {r?.execution && (
        <p className="chat-evidence">
          This device · {bytes(r.execution.sourceBytes ?? 0)} source reads
        </p>
      )}
      {r?.count !== undefined && <p>{r.count.toLocaleString()} results</p>}
      {r?.error && <p role="alert">{r.error}</p>}
      <TraceData title="Arguments" value={input} />
      {result !== undefined && <TraceData title="Response" value={result} />}
    </details>
  );
}
function UserMessage() {
  return (
    <MessagePrimitive.Root className="chat-message chat-user">
      <span className="eyebrow">You</span>
      <MessagePrimitive.Parts />
    </MessagePrimitive.Root>
  );
}
function MarkdownText() {
  return (
    <MarkdownTextPrimitive
      className="chat-markdown"
      smooth={false}
      defer
      components={{
        img: () => null,
        a: ({ node, ...props }) => (
          <a {...props} target="_blank" rel="noopener noreferrer" />
        ),
      }}
    />
  );
}
function AssistantMessage() {
  return (
    <MessagePrimitive.Root className="chat-message chat-assistant">
      <span className="eyebrow">Atlas</span>
      <MessagePrimitive.Parts
        components={{
          Text: MarkdownText,
          Reasoning: Thinking,
          tools: { Fallback: ToolCall },
        }}
      />
    </MessagePrimitive.Root>
  );
}
export function mountChat(
  element: HTMLElement,
  map: WorkspaceMap,
  readers: AtlasReader[],
  enabled: () => Set<string>,
  offline: () => boolean,
) {
  const tools = new ChatTools(map, readers, enabled, offline),
    agent = new AtlasAgentSession(tools);
  let dead = false;
  const root = createRoot(element);
  function Panel() {
    const state = useSyncExternalStore(agent.subscribe, agent.getSnapshot);
    const layers = useSyncExternalStore(
      tools.layers.subscribe,
      tools.layers.getSnapshot,
    );
    const [status, setStatus] = useState("Checking DeepSeek…"),
      [available, setAvailable] = useState(false);
    const [scope, setScope] = useState("Current map view"),
      [picking, setPicking] = useState(false);
    const [problem, setProblem] = useState("");
    const [inspecting, setInspecting] = useState(false);
    const [dataBytes, setDataBytes] = useState(0);
    const byteBaseline = useRef(tools.sourceBytes);
    const areaDetails = useRef<HTMLDetailsElement>(null);
    useEffect(() => {
      const abort = new AbortController();
      fetch("/api/chat/status", { signal: abort.signal, cache: "no-store" })
        .then(async (r) => {
          if (!r.ok)
            throw new Error(
              "Run the local client server to enable the inference proxy.",
            );
          const s = await r.json();
          setAvailable(s.available);
          setStatus(
            s.available
              ? "DeepSeek Flash"
              : "Set DS_API_KEY in the client server environment, then restart.",
          );
        })
        .catch((e) => {
          if (!abort.signal.aborted) setStatus(e.message);
        });
      return () => abort.abort();
    }, []);
    useEffect(() => {
      setDataBytes(tools.sourceBytes - byteBaseline.current);
    }, [state]);
    const runtime = useExternalStoreRuntime<ChatMessage>({
      messages: state.messages,
      convertMessage: convert,
      isRunning: state.running,
      isDisabled: !available,
      onNew: async (message) => {
        const text = message.content
          .filter((p) => p.type === "text")
          .map((p) => p.text)
          .join("\n");
        await agent.send(text);
      },
      onCancel: async () => agent.cancel(),
    });
    const select = (b: [number, number, number, number]) => {
      tools.selectedBounds = b;
      setScope(b.map((v) => v.toFixed(4)).join(", "));
      setProblem("");
      if (areaDetails.current) areaDetails.current.open = false;
    };
    const pick = () => {
      const points: Array<[number, number]> = [];
      setPicking(true);
      setProblem("");
      map.beginPicking(
        "chat",
        (point) => {
          points.push(point);
          if (points.length === 2) {
            const a = points[0]!,
              b = points[1]!;
            select([
              Math.min(a[0], b[0]),
              Math.min(a[1], b[1]),
              Math.max(a[0], b[0]),
              Math.max(a[1], b[1]),
            ]);
            map.endPicking("chat");
            setPicking(false);
          }
        },
        () => setPicking(false),
        "Chat area: click two opposite corners. Space picks the map center; Escape cancels.",
      );
      map.canvas.focus({ preventScroll: true });
    };
    useEffect(() => {
      const b = tools.selectedBounds;
      const id = "chat-area";
      if (!b) return;
      const ring = [
        [b[0], b[1]],
        [b[2], b[1]],
        [b[2], b[3]],
        [b[0], b[3]],
        [b[0], b[1]],
      ];
      // The selection is a separate removable overlay, never a dataset mutation.
      const remove = map.overlays.add({
        id,
        order: 47,
        draw: (frame) => {
          const camera = frame.camera,
            ctx = frame.ctx;
          // Selection drawing uses the same projection as result layers.
          const points = ring.map((p) => screenPoint(p, camera));
          ctx.beginPath();
          points.forEach(([x, y], i) =>
            i ? ctx.lineTo(x, y) : ctx.moveTo(x, y),
          );
          ctx.closePath();
          ctx.strokeStyle = "#345d48";
          ctx.lineWidth = 2;
          ctx.setLineDash([5, 5]);
          ctx.stroke();
        },
      });
      map.invalidate();
      return () => {
        remove();
        map.invalidate();
      };
    }, [scope]);
    const testArea = () => {
      const b: [number, number, number, number] = [
        16.368, 48.198, 16.392, 48.218,
      ];
      select(b);
      tools.layers.fitBounds(b);
    };
    const safely = (fn: () => void) => {
      try {
        fn();
        setProblem("");
      } catch (e) {
        setProblem(String(e));
      }
    };
    const clear = async () => {
      setInspecting(false);
      agent.clear();
      await tools.clear(new AbortController().signal);
      byteBaseline.current = tools.sourceBytes;
      setDataBytes(0);
    };
    const exportJson = () =>
      safely(() => {
        const dump = agent.exportConversation({
          model: { provider: "DeepSeek", model: "deepseek-flash" },
          camera: map.camera,
          insights: tools.insights.getSnapshot(),
          layers: tools.layers.getSnapshot(),
          sourceBytes: tools.sourceBytes - byteBaseline.current,
        });
        const url = URL.createObjectURL(
          new Blob([JSON.stringify(dump, null, 2)], {
            type: "application/json",
          }),
        );
        const a = document.createElement("a");
        a.href = url;
        a.download = `atlas-chat-${dump.exportedAt.replace(/[:.]/g, "-")}.json`;
        document.body.append(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      });
    return (
      <AssistantRuntimeProvider runtime={runtime}>
        {layers.some((l) => l.legend.length) &&
          map.canvas.parentElement &&
          createPortal(
            <details
              className="chat-map-legend"
              open
              aria-label="Map visualization legend"
            >
              <summary>
                Map legend{" "}
                <span>{layers.filter((l) => l.legend.length).length}</span>
              </summary>
              <div>
                {layers
                  .filter((l) => l.legend.length)
                  .map((l) => (
                    <section key={l.id}>
                      <strong>{l.title}</strong>
                      <ul>
                        {l.legend.map((entry, i) => (
                          <li key={i}>
                            <i style={{ background: entry.color }} />
                            <span>{entry.label}</span>
                          </li>
                        ))}
                      </ul>
                    </section>
                  ))}
              </div>
            </details>,
            map.canvas.parentElement,
          )}
        <div className="chat-heading">
          <h2>Ask this place.</h2>
          <div className="chat-status">
            <span className="chat-device">● Tools on this device</span>
            <span>{status}</span>
          </div>
        </div>
        <details className="chat-scope" ref={areaDetails}>
          <summary>
            Analysis area{" "}
            <span>
              {tools.selectedBounds ? "Pinned rectangle" : "Current view"}
            </span>
          </summary>
          <div className="chat-row">
            <strong>Analysis area</strong>
            <button
              disabled={state.running}
              onClick={() => {
                tools.selectedBounds = undefined;
                setScope("Current map view");
              }}
            >
              Use live view
            </button>
          </div>
          <p className="chat-coordinates">
            {picking ? "Click two corners on the map…" : scope}
          </p>
          <div className="chat-row">
            <button disabled={state.running} onClick={pick}>
              Draw rectangle
            </button>
            <button
              disabled={state.running}
              onClick={() => select(map.viewBounds())}
            >
              Pin visible area
            </button>
          </div>
          {readers.some(
            (r) =>
              r.index.manifest.bounds[0] < 16.38 &&
              r.index.manifest.bounds[2] > 16.38,
          ) && (
            <button
              className="chat-example-area"
              disabled={state.running}
              onClick={testArea}
            >
              Use Vienna test area ↗
            </button>
          )}
        </details>
        <ThreadPrimitive.Root className="chat-thread">
          <ThreadPrimitive.Viewport className="chat-viewport">
            {!state.messages.length && (
              <div className="chat-welcome">
                <p className="eyebrow">TRY A QUESTION</p>
                <button
                  disabled={!available}
                  onClick={() =>
                    void agent.send(
                      "In the analysis area, count buildings with known or estimated height at least 20 metres. Report unknown heights separately and highlight the tall buildings. Use the same cached workspace for the analysis.",
                    )
                  }
                >
                  Count & highlight tall buildings <span>↗</span>
                </button>
                <button
                  disabled={!available}
                  onClick={() =>
                    void agent.send(
                      "Find Handelskai 300 and Kaiserstraße in Vienna. Show the address candidates and draw a walking route between them if both are unambiguous.",
                    )
                  }
                >
                  Walk across the two maps <span>↗</span>
                </button>
                <button
                  disabled={!available}
                  onClick={() =>
                    void agent.send(
                      "Color the buildings in the analysis area by height: under 10 m, 10–20 m, 20–30 m, and 30 m or more; unknown heights in gray. Add a legend with counts and units. Label only the five tallest buildings with their heights and distinguish estimates. Reuse the cached workspace.",
                    )
                  }
                >
                  Paint the skyline <span>↗</span>
                </button>
                <button
                  disabled={!available}
                  onClick={() =>
                    void agent.send(
                      "In this analysis area, prepare water and buildings with geometry. Make a 100-metre water buffer, union it, and select buildings that intersect it. Show the water and selected buildings with a legend. Report retained counts and clarify this is proximity, not flood risk.",
                    )
                  }
                >
                  Buildings near water <span>↗</span>
                </button>
                <button
                  disabled={!available}
                  onClick={() =>
                    void agent.send(
                      "Measure the retained road and railway features in this analysis area after clipping them to its bounds. Compare their length distributions in linked histograms in metres. Explain that OSM ways and parallel tracks are separate features, not necessarily whole named streets or rail lines.",
                    )
                  }
                >
                  Roads & rails, measured <span>↗</span>
                </button>
                <button
                  disabled={!available}
                  onClick={() =>
                    void agent.send(
                      "What kinds of map data can you use here, and which operations can run from cached data on this device?",
                    )
                  }
                >
                  What does this map know? <span>↗</span>
                </button>
              </div>
            )}
            <ThreadPrimitive.Messages
              components={{ UserMessage, AssistantMessage }}
            />
            <InsightsPanel insights={tools.insights} />
            {state.running && (
              <p className="chat-working" role="status">
                Working with your map…
              </p>
            )}
          </ThreadPrimitive.Viewport>
          {(state.error || problem) && (
            <p className="chat-error" role="alert">
              {state.error || problem}
            </p>
          )}
          <ComposerPrimitive.Root className="chat-composer">
            <ComposerPrimitive.Input
              aria-label="Message Atlas"
              placeholder="Ask about this area…"
              rows={2}
            />
            <div className="chat-row">
              <small>Map tools stay local · model inference online</small>
              {state.running ? (
                <ComposerPrimitive.Cancel aria-label="Stop reply">
                  Stop
                </ComposerPrimitive.Cancel>
              ) : (
                <ComposerPrimitive.Send aria-label="Send message">
                  Send ↗
                </ComposerPrimitive.Send>
              )}
            </div>
          </ComposerPrimitive.Root>
        </ThreadPrimitive.Root>
        <div className="chat-metrics" aria-label="Chat measurements">
          <span>
            <b>{bytes(dataBytes)}</b> map source reads
          </span>
          <span>
            <b>{state.rounds}</b> model rounds
          </span>
          <span>
            <b>{state.tokens.toLocaleString()}</b> model tokens
          </span>
          <span>
            <b>{(state.elapsedMs / 1000).toFixed(1)} s</b> last reply
          </span>
        </div>
        <details className="chat-layer-list">
          <summary>
            Drawings <span>{layers.length}</span>
          </summary>
          <div className="chat-row">
            <button
              disabled={!layers.length}
              onClick={() => {
                if (inspecting) {
                  map.endPicking("chat-inspect");
                  setInspecting(false);
                  return;
                }
                setInspecting(true);
                map.beginPicking(
                  "chat-inspect",
                  (point) => {
                    const value = tools.layers.inspect(point);
                    tools.insights.inspect(value);
                    if (value) {
                      map.endPicking("chat-inspect");
                      setInspecting(false);
                    }
                  },
                  () => setInspecting(false),
                  "Inspect a colored chat drawing. Click a feature; Escape cancels.",
                );
              }}
            >
              {inspecting ? "Cancel inspection" : "Inspect drawings"}
            </button>
            <strong>
              Drawings <span className="quiet">{layers.length}</span>
            </strong>
            <button
              disabled={!layers.length || state.running}
              onClick={() =>
                safely(() => {
                  tools.layers.undo();
                })
              }
            >
              Undo last
            </button>
          </div>
          {layers.map((l) => (
            <div className="chat-layer" key={l.id}>
              <i style={{ background: l.color }} />
              <button onClick={() => safely(() => tools.layers.fit(l.id))}>
                {l.title}
                <small>
                  {l.count.toLocaleString()} objects · fit to map ↗
                </small>
              </button>
              <button
                aria-label={"Remove " + l.title}
                disabled={state.running}
                onClick={() =>
                  safely(() => {
                    tools.layers.undo(l.id);
                  })
                }
              >
                ×
              </button>
            </div>
          ))}
        </details>
        <div className="chat-footer">
          <span>Cached results stay until you start a new chat.</span>
          <button
            disabled={!state.messages.length}
            onClick={exportJson}
            title="Download messages, reasoning, tool traces, timings, map context and drawings"
          >
            Export JSON ↓
          </button>
          <button
            disabled={state.running}
            onClick={() => void clear().catch((e) => setProblem(String(e)))}
          >
            New chat
          </button>
        </div>
      </AssistantRuntimeProvider>
    );
  }
  root.render(<Panel />);
  return {
    destroy() {
      if (dead) return;
      dead = true;
      agent.destroy();
      root.unmount();
      tools.destroy();
    },
    cancel() {
      agent.cancel();
    },
  };
}
import { project } from "../../../../packages/format/src/index";
import {
  worldToScreen,
  type Camera,
} from "../../../../packages/renderer/src/camera";
function screenPoint(p: number[], camera: Camera) {
  return worldToScreen(project(p[0]!, p[1]!), camera);
}

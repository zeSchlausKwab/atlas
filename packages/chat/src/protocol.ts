export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}
export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}
export interface WireMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}
export interface Completion {
  content: string;
  calls: ToolCall[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}
export type Model = (
  messages: WireMessage[],
  tools: ToolDefinition[],
  signal: AbortSignal,
  onText: (text: string) => void,
) => Promise<Completion>;

/** Incremental SSE parser: frames can span arbitrary UTF-8/network chunks. */
export async function completionStream(
  response: Response,
  signal: AbortSignal,
  onText: (text: string) => void,
): Promise<Completion> {
  if (!response.ok) {
    const error = (await response.json().catch(() => ({}))) as {
      error?: string;
    };
    throw new Error(
      error.error ?? "Model request failed (HTTP " + response.status + ")",
    );
  }
  if (
    !response.body ||
    !response.headers.get("content-type")?.includes("text/event-stream")
  )
    throw new Error("Expected a streaming model response");
  const reader = response.body.getReader(),
    decoder = new TextDecoder();
  let buffer = "",
    content = "",
    received = 0,
    done = false,
    finish: string | undefined;
  const calls = new Map<number, ToolCall>();
  let usage: Completion["usage"];
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  const frame = (text: string) => {
    const data = text
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trimStart())
      .join("\n");
    if (!data) return;
    if (data === "[DONE]") {
      done = true;
      return;
    }
    const event = JSON.parse(data);
    if (event.error) throw new Error("The model provider reported an error");
    if (event.usage) usage = event.usage;
    const choice = event.choices?.[0];
    if (!choice) return;
    if (choice.finish_reason) finish = choice.finish_reason;
    const delta = choice.delta ?? {};
    if (typeof delta.content === "string") {
      content += delta.content;
      onText(content);
    }
    for (const part of delta.tool_calls ?? []) {
      if (!Number.isInteger(part.index) || part.index < 0 || part.index >= 16)
        throw new Error("Invalid model tool-call index");
      const call = calls.get(part.index) ?? {
        id: "",
        type: "function",
        function: { name: "", arguments: "" },
      };
      if (part.id) call.id += part.id;
      if (part.function?.name) call.function.name += part.function.name;
      if (part.function?.arguments)
        call.function.arguments += part.function.arguments;
      if (call.function.arguments.length > 65536)
        throw new Error("Tool arguments exceed 64 KiB");
      calls.set(part.index, call);
    }
  };
  try {
    while (!done) {
      signal.throwIfAborted();
      const next = await reader.read();
      if (next.done) break;
      received += next.value.byteLength;
      if (received > 2 * 1024 ** 2)
        throw new Error("Model response exceeds 2 MiB");
      buffer += decoder.decode(next.value, { stream: true });
      buffer = buffer.replaceAll("\r\n", "\n");
      let at: number;
      while ((at = buffer.indexOf("\n\n")) >= 0) {
        frame(buffer.slice(0, at));
        buffer = buffer.slice(at + 2);
      }
    }
    signal.throwIfAborted();
    if (!done)
      throw new Error(
        "Model stream ended before completion; retry the request",
      );
    if (!["stop", "tool_calls"].includes(finish ?? ""))
      throw new Error(
        "Model response was incomplete (" +
          (finish ?? "missing finish reason") +
          ")",
      );
    const result = [...calls.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, v]) => v);
    if (
      result.some(
        (c) => !c.id || !/^[a-z][a-z0-9_]{0,63}$/.test(c.function.name),
      ) ||
      new Set(result.map((c) => c.id)).size !== result.length
    )
      throw new Error("Invalid model tool identity");
    if (finish === "tool_calls" && !result.length)
      throw new Error("Missing model tool calls");
    return { content, calls: result, usage };
  } finally {
    signal.removeEventListener("abort", cancel);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
export const deepseekModel: Model = async (messages, tools, signal, onText) =>
  completionStream(
    await fetch("/api/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages,
        tools: tools.map((t) => ({
          ...t,
          function: {
            ...t.function,
            parameters: modelSchema(t.function.parameters),
          },
        })),
      }),
      signal,
    }),
    signal,
    onText,
  );

/** Provider dialect accepts homogeneous array items, but not JSON Schema tuple items.
 * Local AJV contracts retain their per-position bounds; only model guidance is adapted. */
export function modelSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(modelSchema);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      key === "items" && Array.isArray(child)
        ? { anyOf: child.map(modelSchema) }
        : modelSchema(child),
    ]),
  );
}

const UPSTREAM = "https://api.deepseek.com/chat/completions";
const MAX_REQUEST = 1024 * 1024;
interface Options {
  key?: string;
  fetch?: (input: string, init: RequestInit) => Promise<Response>;
  timeoutMs?: number;
}
export function chatProxy(options: Options = {}) {
  let active = 0;
  const headers = {
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  };
  const fail = (error: string, status: number) =>
    Response.json({ error }, { status, headers });
  return async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url);
    if (url.pathname === "/api/chat/status" && request.method === "GET")
      return Response.json(
        { available: !!options.key, model: "deepseek-flash", tools: "device" },
        { headers },
      );
    if (url.pathname !== "/api/chat/completions") return;
    if (request.method !== "POST") return fail("POST required", 405);
    if (
      request.headers.get("origin") !== url.origin ||
      !["same-origin", "none", null].includes(
        request.headers.get("sec-fetch-site"),
      )
    )
      return fail("Same-origin chat requests only", 403);
    if (!request.headers.get("content-type")?.startsWith("application/json"))
      return fail("JSON required", 415);
    if (!options.key)
      return fail(
        "Add DS_API_KEY to the client server environment and restart it.",
        503,
      );
    if (active >= 2)
      return fail(
        "Two model requests are already running. Try again shortly.",
        429,
      );
    const timeout = AbortSignal.timeout(options.timeoutMs ?? 120000);
    const signal = AbortSignal.any([request.signal, timeout]);
    active++;
    let released = false,
      streaming = false;
    const release = () => {
      if (!released) {
        released = true;
        active--;
      }
    };
    try {
      if (Number(request.headers.get("content-length") ?? 0) > MAX_REQUEST)
        return fail("Chat request exceeds 1 MiB", 413);
      const body = request.body?.getReader();
      if (!body) return fail("Missing request body", 400);
      let size = 0;
      const chunks: Uint8Array[] = [];
      const cancelBody = () => {
        void body.cancel().catch(() => {});
      };
      signal.addEventListener("abort", cancelBody, { once: true });
      try {
        while (true) {
          signal.throwIfAborted();
          const { value, done } = await body.read();
          if (done) break;
          size += value.byteLength;
          if (size > MAX_REQUEST) {
            await body.cancel();
            return fail("Chat request exceeds 1 MiB", 413);
          }
          chunks.push(value);
        }
      } finally {
        signal.removeEventListener("abort", cancelBody);
        body.releaseLock();
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
      const input = JSON.parse(new TextDecoder().decode(bytes));
      if (
        !Array.isArray(input.messages) ||
        input.messages.length < 1 ||
        input.messages.length > 200 ||
        !input.messages.every(
          (m: any) =>
            ["system", "user", "assistant", "tool"].includes(m?.role) &&
            (m.content === null || typeof m.content === "string"),
        ) ||
        !Array.isArray(input.tools) ||
        input.tools.length > 32 ||
        !input.tools.every(
          (t: any) =>
            t?.type === "function" &&
            /^[a-z][a-z0-9_]{0,63}$/.test(t.function?.name) &&
            t.function?.parameters?.type === "object",
        )
      )
        return fail("Invalid chat messages or tool schemas", 400);
      const response = await (options.fetch ?? fetch)(UPSTREAM, {
        method: "POST",
        headers: {
          Authorization: "Bearer " + options.key,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "deepseek-flash",
          messages: input.messages,
          tools: input.tools,
          stream: true,
          stream_options: { include_usage: true },
          max_tokens: 8192,
          thinking: { type: "disabled" },
        }),
        signal,
      });
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        return fail(
          "DeepSeek returned HTTP " +
            response.status +
            ". Check provider access or retry.",
          502,
        );
      }
      const reader = response.body.getReader();
      let sent = 0;
      const stream = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            signal.throwIfAborted();
            const { value, done } = await reader.read();
            if (done) {
              release();
              controller.close();
              return;
            }
            sent += value.byteLength;
            if (sent > 2 * 1024 ** 2)
              throw new Error("Model response exceeds 2 MiB");
            controller.enqueue(value);
          } catch (e) {
            release();
            await reader.cancel().catch(() => {});
            controller.error(e);
          }
        },
        async cancel() {
          release();
          await reader.cancel().catch(() => {});
        },
      });
      // Release only when the response stream closes, cancels or times out.
      signal.addEventListener(
        "abort",
        () => {
          release();
          void reader.cancel().catch(() => {});
        },
        { once: true },
      );
      streaming = true;
      return new Response(stream, {
        headers: {
          ...headers,
          "Content-Type": "text/event-stream",
          "X-Accel-Buffering": "no",
        },
      });
    } catch (e) {
      return fail(
        signal.aborted
          ? "Model request timed out or was cancelled"
          : "Could not complete model request",
        signal.aborted ? 504 : 400,
      );
    } finally {
      if (!streaming) release();
    }
  };
}

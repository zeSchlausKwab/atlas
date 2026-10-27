const UPSTREAM = "https://api.deepseek.com/chat/completions";
interface Options {
  key?: string;
  fetch?: (input: string, init: RequestInit) => Promise<Response>;
}
export function chatProxy(options: Options = {}) {
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
    const signal = request.signal;
    try {
      const input = await request.json();
      if (
        !Array.isArray(input.messages) ||
        input.messages.length < 1 ||
        !input.messages.every(
          (m: any) =>
            ["system", "user", "assistant", "tool"].includes(m?.role) &&
            (m.content === null || typeof m.content === "string"),
        ) ||
        !Array.isArray(input.tools) ||
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
          thinking: { type: "enabled" },
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
      return new Response(response.body, {
        headers: {
          ...headers,
          "Content-Type": "text/event-stream",
          "X-Accel-Buffering": "no",
        },
      });
    } catch (e) {
      return fail(
        signal.aborted
          ? "Model request was cancelled"
          : "Could not complete model request",
        signal.aborted ? 504 : 400,
      );
    }
  };
}

import { WorkspaceError } from "../../packages/workspace/src/index";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { NostrServerTransport } from "@contextvm/sdk";
import type { OperationHost } from "../../packages/operations/src/host";
/** Tool discovery and execution are projections of the registry, not a second API. */
export function createMcpServer(host: OperationHost) {
  const server = new Server(
    { name: "atlas", version: "0.1.0" },
    { capabilities: { tools: { listChanged: true } } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: host.engine.registry
      .catalog()
      .filter((d) => d.enabled && d.available && d.result !== "file")
      .map((d) => ({
        name: d.id,
        title: d.title,
        description: d.description,
        inputSchema: {
          type: "object" as const,
          additionalProperties: false,
          required: ["snapshot", "implementation", "input"],
          properties: {
            snapshot: {
              type: "string",
              const: host.engine.reader.index.manifest.snapshot,
            },
            implementation: { type: "string", const: d.implementation },
            input: d.inputSchema,
          },
        },
        outputSchema: {
          type: "object" as const,
          anyOf: [
            { required: ["result", "execution", "provenance"] },
            { required: ["error"] },
          ],
          properties: {
            result: d.outputSchema,
            execution: { type: "object" },
            provenance: { type: "object" },
            error: {
              type: "object",
              required: ["code", "message", "details"],
              properties: {
                code: { type: "string" },
                message: { type: "string" },
                details: { type: "object" },
              },
            },
          },
        },
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: !["workspace_prepare", "workspace_query"].includes(
            d.id,
          ),
        },
        _meta: { "atlas/contract": d },
      })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    try {
      const d = host.engine.registry.describe(request.params.name),
        args = request.params.arguments;
      if (!d || d.result === "file") throw new Error("Unknown MCP tool");
      const result = await host.invoke(
        {
          id: d.id,
          version: d.version,
          implementation: String(args?.implementation ?? ""),
          snapshot: String(args?.snapshot ?? ""),
          input: args?.input,
        },
        extra.signal,
      );
      const structuredContent = result as Record<string, unknown>;
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
        structuredContent,
      };
    } catch (e) {
      return {
        ...(e instanceof WorkspaceError
          ? { structuredContent: { error: e.toJSON() } }
          : {}),
        isError: true,
        content: [
          {
            type: "text" as const,
            text: e instanceof Error ? e.message : String(e),
          },
        ],
      };
    }
  });
  return server;
}
export async function startContextVM(host: OperationHost) {
  if (!process.env.ATLAS_CVM_SECRET) return undefined;
  const relays = (process.env.ATLAS_CVM_RELAYS ?? "")
    .split(",")
    .filter(Boolean);
  const allowedPublicKeys = (process.env.ATLAS_CVM_CLIENTS ?? "")
    .split(",")
    .filter(Boolean);
  if (!relays.length || !allowedPublicKeys.length)
    throw new Error(
      "ContextVM requires ATLAS_CVM_RELAYS and ATLAS_CVM_CLIENTS.",
    );
  const transport = new NostrServerTransport({
    signer: process.env.ATLAS_CVM_SECRET,
    relayHandler: relays,
    allowedPublicKeys,
    isAnnouncedServer: false,
    publishRelayList: false,
  });
  const server = createMcpServer(host);
  await server.connect(transport);
  return server;
}

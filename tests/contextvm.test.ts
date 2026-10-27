import { test, expect } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  PrivateKeySigner,
  NostrServerTransport,
  NostrClientTransport,
} from "@contextvm/sdk";
import { createMcpServer } from "../apps/server/contextvm";
import { OperationHost } from "../packages/operations/src/host";
import { localRelay } from "./helpers/nostr-relay";
import { pluginFixture, polygon } from "./helpers/plugin-fixture";
test("real ContextVM SDK discovers and invokes the registry over an isolated Nostr relay", async () => {
  const relay = localRelay(),
    f = await pluginFixture(),
    host = new OperationHost(f.engine),
    server = createMcpServer(host),
    client = new Client({ name: "atlas-proof", version: "1.0.0" });
  const serverSigner = new PrivateKeySigner(),
    clientSigner = new PrivateKeySigner();
  try {
    await server.connect(
      new NostrServerTransport({
        signer: serverSigner,
        relayHandler: [relay.url],
        allowedPublicKeys: [await clientSigner.getPublicKey()],
        isAnnouncedServer: false,
        publishRelayList: false,
        logLevel: "error",
      }),
    );
    await client.connect(
      new NostrClientTransport({
        signer: clientSigner,
        serverPubkey: await serverSigner.getPublicKey(),
        relayHandler: [relay.url],
        logLevel: "error",
      }),
    );
    const list = await client.listTools();
    expect(list.tools.map((t) => t.name)).toContain(f.ref.id);
    const args = {
      snapshot: f.reader.index.manifest.snapshot,
      implementation: f.ref.implementation,
      input: { polygon },
    };
    const result = await client.callTool({ name: f.ref.id, arguments: args });
    expect(result.isError).not.toBe(true);
    const wire = result.structuredContent as any;
    expect(wire.result).toEqual(
      await f.engine.registry.invoke(f.ref, { polygon }),
    );
    expect(wire.provenance.implementation).toBe(f.ref.implementation);
    expect(list.tools.map((t) => t.name)).toContain("workspace_prepare");
    const task = async (name: string, input: unknown) =>
      client.callTool({
        name,
        arguments: {
          snapshot: f.reader.index.manifest.snapshot,
          implementation: "atlas-core-1",
          input,
        },
      });
    const prepared = await task("workspace_prepare", {
      bounds: [9, 47, 9.2, 47.2],
      families: ["water"],
    });
    expect(prepared.isError).not.toBe(true);
    const workspace = (prepared.structuredContent as any).result.workspace;
    const queried = await task("workspace_query", {
      workspace,
      where: [{ field: "tags.water", op: "eq", value: "lake" }],
    });
    expect(queried.isError).not.toBe(true);
    expect((queried.structuredContent as any).result.count).toBe(2);
    const absent = await task("workspace_prepare", {
      bounds: [9, 47, 9.2, 47.2],
      families: ["locations"],
    });
    expect(absent.isError).toBe(true);
    expect((absent.structuredContent as any).error.code).toBe(
      "unsupported_data",
    );
    f.engine.registry.setEnabled(f.ref.id, false);
    expect((await client.listTools()).tools.map((t) => t.name)).not.toContain(
      f.ref.id,
    );
    expect(
      (await client.callTool({ name: f.ref.id, arguments: args })).isError,
    ).toBe(true);
    expect([...relay.kinds].some((k) => k >= 11316 && k <= 11320)).toBe(false);
  } finally {
    await client.close();
    await server.close();
    await relay.close();
    f.reader.dispose();
    f.engine.destroy();
  }
}, 20000);

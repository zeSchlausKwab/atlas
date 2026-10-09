import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  PrivateKeySigner,
  NostrServerTransport,
  NostrClientTransport,
} from "@contextvm/sdk";
import { AtlasReader } from "../packages/format/src/reader";
import { AtlasEngine } from "../packages/operations/src/index";
import { OperationHost } from "../packages/operations/src/host";
import { PackageSource } from "../apps/server/package-source";
import { createMcpServer } from "../apps/server/contextvm";
import { buildPlugins, loadPlugins } from "./plugins";
import { localRelay } from "../tests/helpers/nostr-relay";
const root = new URL("../", import.meta.url).pathname;
const file = await PackageSource.open(
  process.env.ATLAS_FILE ?? `${root}data/vienna-plus.atlas`,
);
const reader = await new AtlasReader(file).open(),
  engine = new AtlasEngine(reader);
for (const p of await loadPlugins(root, await buildPlugins(root)))
  engine.registry.register(p.plugin, p.implementation);
const host = new OperationHost(engine),
  server = createMcpServer(host),
  client = new Client({ name: "atlas-demo", version: "1.0.0" });
const relay = localRelay(),
  serverSigner = new PrivateKeySigner(),
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
  const tools = await client.listTools(),
    d = engine.registry.describe("atlas.lakes.rank")!;
  const input = {
    polygon: [
      [16.37, 48.2],
      [16.48, 48.2],
      [16.48, 48.29],
      [16.37, 48.29],
    ],
    classification: "lake-and-oxbow",
    limit: 5,
  };
  const response = await client.callTool({
    name: d.id,
    arguments: {
      snapshot: reader.index.manifest.snapshot,
      implementation: d.implementation,
      input,
    },
  });
  if (response.isError) throw new Error(JSON.stringify(response.content));
  const wire = response.structuredContent as any;
  const local = await engine.registry.invoke(d, input);
  if (JSON.stringify(local) !== JSON.stringify(wire.result))
    throw new Error("Local/CVM mismatch");
  console.log(
    JSON.stringify(
      {
        relay: relay.url,
        publicAnnouncements: false,
        tools: tools.tools.map((t) => t.name),
        identicalResults: true,
        provenance: wire.provenance,
        lakes: wire.result.features.map((f: any) => ({
          name: f.properties.name || f.id,
          areaM2: Number(f.properties.tags["atlas:area_m2"]),
        })),
        execution: wire.execution,
      },
      null,
      2,
    ),
  );
} finally {
  await client.close();
  await server.close();
  await relay.close();
  engine.destroy();
  reader.dispose();
  await file.close();
}

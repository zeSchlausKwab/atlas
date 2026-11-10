import { MapDiscovery, type DiscoveryPeer } from "../../apps/server/discovery";
import { AtlasReader, FileSource } from "../../packages/format/src/reader";
import { watchMaps } from "../../packages/hashtree/src/discovery";
import type { MapOffer } from "../../packages/format/src/catalog";

/** Real publisher and its read-only Nostr relay. Loopback only; raw range delivery
 * deliberately disabled so a successful rehearsal proves Hashtree delivery. */
export async function publishedHost(path: string, directory: string) {
  const manifestReader = await new AtlasReader(
    new FileSource(Bun.file(path)),
  ).open();
  const manifest = manifestReader.index.manifest;
  manifestReader.dispose();
  const discovery = await MapDiscovery.open(
    directory,
    () => false,
    () => [
      {
        id: "demo",
        path,
        offer: {
          id: "demo",
          url: "/maps/demo.atlas",
          api: "/api",
          bytes: Bun.file(path).size,
          manifest,
        },
      },
    ],
  );
  let available = true,
    blobRequests = 0,
    rawRequests = 0;
  const server = Bun.serve<DiscoveryPeer["data"]>({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request, server) {
      const url = new URL(request.url);
      if (
        url.pathname === "/nostr" &&
        server.upgrade(request, { data: { subscriptions: new Map() } })
      )
        return;
      if (url.pathname.startsWith("/maps/")) {
        rawRequests++;
        return new Response("Hashtree only in this rehearsal", { status: 410 });
      }
      if (url.pathname.startsWith("/hashtree/")) {
        blobRequests++;
        if (!available) return new Response(null, { status: 503 });
      }
      return (
        (await discovery.handle(request)) ?? new Response(null, { status: 404 })
      );
    },
    websocket: discovery.websocket,
  });
  try {
    const job = await discovery.publish("demo", server.url.origin);
    await discovery.settled();
    if (job.state !== "ready") throw Error(job.message);
    return {
      origin: server.url.origin,
      pubkey: discovery.pubkey,
      offer: job.offer!,
      unavailable(value = true) {
        available = !value;
      },
      stats: () => ({ blobRequests, rawRequests }),
      async close() {
        await discovery.close();
        server.stop(true);
      },
    };
  } catch (error) {
    await discovery.close();
    server.stop(true);
    throw error;
  }
}
export async function discoverPublishedHost(
  host: Awaited<ReturnType<typeof publishedHost>>,
) {
  const received = Promise.withResolvers<MapOffer>();
  const abort = new AbortController();
  const timeout = setTimeout(() => {
    abort.abort();
    received.reject(Error("Discovery timed out"));
  }, 5000);
  let close: (() => void) | undefined;
  try {
    close = await watchMaps(
      host.origin.replace("http:", "ws:") + "/nostr",
      [host.pubkey],
      received.resolve,
      abort.signal,
    );
    return await received.promise;
  } finally {
    clearTimeout(timeout);
    abort.abort();
    close?.();
  }
}

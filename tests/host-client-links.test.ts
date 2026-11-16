import { expect, test } from "bun:test";
import {
  hostClientLinks,
  type HostClientConfig,
} from "../apps/shared/host-client-links";
import { discoveryConnection } from "../apps/web/src/connection";
import { deliveryChoice } from "../apps/web/src/transport";

const publisher = "a".repeat(64);
const config: HostClientConfig = {
  clientUrl:
    "http://127.0.0.1:5173/?server=http://old.example&maps=old&source=old&api=old&publisher=old&relay=wss://old.example&viewRecipe=old&view=old&transport=fips&httpFallback=1#old",
  discovery: {
    pubkey: publisher,
    relays: ["wss://relay.example/", "wss://second.example/"],
  },
  delivery: { fips: true, http: true },
};

test("host inspection selects HTTP and the current host without inherited FIPS discovery or view state", () => {
  const links = hostClientLinks(config, "http://192.168.0.179:3100", {
    maps: ["west", "east"],
  });
  expect(links.map((link) => link.transport)).toEqual(["http", "fips"]);
  const url = new URL(links[0]!.url);
  expect(Object.fromEntries(url.searchParams)).toEqual({
    server: "http://192.168.0.179:3100/",
    maps: "west,east",
    transport: "http",
  });
  expect(discoveryConnection(url.searchParams)).toBeUndefined();
  expect(deliveryChoice(url.searchParams)).toEqual({
    transport: "http",
    allowHttpFallback: false,
  });
});

test("FIPS launch pins discovery and keeps HTTP fallback off even when inspection is available", () => {
  const link = hostClientLinks(config, "http://192.168.0.179:3100", {
    maps: ["north-sea"],
  })[1]!;
  const url = new URL(link.url);
  expect(url.searchParams.has("server")).toBe(false);
  expect(url.searchParams.get("maps")).toBe("north-sea");
  expect(url.searchParams.get("publisher")).toBe(publisher);
  expect(url.searchParams.getAll("relay")).toEqual(config.discovery!.relays);
  expect(deliveryChoice(url.searchParams)).toEqual({
    transport: "fips",
    allowHttpFallback: false,
  });
});

test("host links reflect both delivery toggles without offering a disabled transport", () => {
  expect(
    hostClientLinks(
      { ...config, delivery: { fips: true, http: false } },
      "http://localhost:3100",
    ).map((l) => l.transport),
  ).toEqual(["fips"]);
  expect(
    hostClientLinks(
      { ...config, delivery: { fips: false, http: true } },
      "http://localhost:3100",
    ).map((l) => l.transport),
  ).toEqual(["http"]);
  expect(
    hostClientLinks(
      { ...config, delivery: { fips: false, http: false } },
      "http://localhost:3100",
    ),
  ).toEqual([]);
  expect(
    hostClientLinks(
      { ...config, discovery: { pubkey: publisher, relays: [] } },
      "http://localhost:3100",
    ).map((l) => l.transport),
  ).toEqual(["http"]);
});

test("older HTTP-only host configuration still opens explicitly over HTTP", () => {
  const link = hostClientLinks(
    { clientUrl: "http://localhost:5173/" },
    "http://localhost:3100",
    { map: "demo" },
  )[0]!;
  expect(link.transport).toBe("http");
  expect(new URL(link.url).searchParams.get("map")).toBe("demo");
  expect(deliveryChoice(new URL(link.url).searchParams).transport).toBe("http");
});

test("changing host delivery settings refreshes launch choices immediately", async () => {
  const { spyOn } = await import("bun:test");
  const previousLocation = Object.getOwnPropertyDescriptor(
    globalThis,
    "location",
  );
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: { origin: "http://localhost:3100" },
  });
  const fetchConfig = spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json(config),
  );
  let unsubscribe: (() => void) | undefined;
  try {
    const links = await import("../apps/host/src/client-link");
    const changes: string[][] = [];
    unsubscribe = links.onClientDeliveryChange(() => {
      changes.push(links.clientLinks().map((link) => link.transport));
    });
    links.updateClientDiscovery(config.discovery!, true, false);
    links.updateClientDiscovery(config.discovery!, true, false);
    links.updateClientDiscovery(config.discovery!, true, true);
    links.updateClientDiscovery(config.discovery!, false, true);
    links.updateClientDiscovery(config.discovery!, false, false);
    expect(changes).toEqual([["fips"], ["http", "fips"], ["http"], []]);
    unsubscribe();
    links.updateClientDiscovery(config.discovery!, true, true);
    expect(changes).toHaveLength(4);
  } finally {
    unsubscribe?.();
    fetchConfig.mockRestore();
    if (previousLocation)
      Object.defineProperty(globalThis, "location", previousLocation);
    else Reflect.deleteProperty(globalThis, "location");
  }
});

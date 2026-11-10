import {
  HashtreeSource,
  type TreeOffer,
  type FipsProvider,
} from "../../../packages/hashtree/src/source";
import type { MapOffer } from "../../../packages/format/src/catalog";
import type { BlockStore } from "../../../packages/format/src/store";
import { RemoteOperations } from "../../../packages/operations/src/index";

export interface DeliveryChoice {
  transport: "fips" | "http";
  allowHttpFallback: boolean;
}
export const FIPS_DEFAULT: DeliveryChoice = {
  transport: "fips",
  allowHttpFallback: false,
};
let loadedRuntime:
  | Promise<typeof import("../../../packages/fips/src/client")>
  | undefined;
const runtime = () =>
  (loadedRuntime ??= import("../../../packages/fips/src/client"));
/** Purge releases the mesh and its queues before readers may reopen. HTTP-only
 * sessions do not load the FIPS runtime just to shut it down. */
export async function closeMapTransport() {
  const pending = loadedRuntime;
  loadedRuntime = undefined;
  if (pending) await (await pending).closeFipsClient();
}
const sourcePolicies = new WeakMap<HashtreeSource, DeliveryChoice>();
export const sourceDelivery = (source: HashtreeSource) =>
  sourcePolicies.get(source) ?? FIPS_DEFAULT;
export function deliveryChoice(
  query: URLSearchParams,
  configured?: string,
): DeliveryChoice {
  const transport = query.get("transport") ?? configured ?? "fips";
  if (transport !== "fips" && transport !== "http")
    throw new Error("Choose FIPS or HTTP delivery.");
  return {
    transport,
    allowHttpFallback:
      transport === "fips" && query.get("httpFallback") === "1",
  };
}
export function deliveryLabel(tree: TreeOffer, choice: DeliveryChoice) {
  if (choice.transport === "http") return "HTTP · explicitly selected";
  if (!tree.fips?.length)
    return choice.allowHttpFallback
      ? "HTTP fallback · explicitly allowed"
      : "FIPS unavailable · this offer only advertises HTTP";
  return `FIPS${choice.allowHttpFallback ? " · HTTP fallback allowed" : " · no HTTP fallback"}`;
}

/** One transport policy is shared by display, analysis, routing and export reads. */
export function mapSource(
  offer: MapOffer,
  choice: DeliveryChoice = FIPS_DEFAULT,
  options: { store?: BlockStore; offline?: () => boolean } = {},
) {
  if (!offer.hashtree)
    throw new Error("This map has no published Hashtree revision.");
  const source = new HashtreeSource(offer.url, offer.hashtree, offer.api, {
    ...options,
    ...choice,
    requestTimeoutMs: choice.transport === "fips" ? 20 * 60_000 : 10_000,
    fetchFipsBlob: async (hash, providers, signal) => {
      const { getFipsClient } = await runtime();
      signal.throwIfAborted();
      return getFipsClient().fetchBlob(hash, providers, signal);
    },
  });
  sourcePolicies.set(source, { ...choice });
  return source;
}

export type FipsRequest = (
  provider: FipsProvider,
  request: {
    root: string;
    path: string;
    method: "GET" | "POST";
    body?: unknown;
  },
  signal: AbortSignal,
) => Promise<{
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
  bytes?: Uint8Array;
}>;
/** Each RPC stays on one provider. Replaying a call elsewhere could repeat
 * stateful workspace work, including when its response was lost in transit. */
export function fipsOperationRequest(tree: TreeOffer, request?: FipsRequest) {
  // Workspace/result handles belong to this host, not every mirror of the root.
  const selected = tree.fips?.find((p) => p.rpcPort !== undefined);
  const provider = selected ? structuredClone(selected) : undefined;
  const root = tree.root;
  return async (path: string, init: RequestInit = {}): Promise<Response> => {
    const signal = init.signal
      ? AbortSignal.any([init.signal, AbortSignal.timeout(10 * 60_000)])
      : AbortSignal.timeout(10 * 60_000);
    signal.throwIfAborted();
    const method = init.method ?? "GET";
    if (method !== "GET" && method !== "POST")
      throw new Error("Unsupported FIPS operation method");
    if (!provider)
      throw new Error(
        "This provider does not advertise server tools over FIPS. Use This device.",
      );
    if (
      !tree.fips?.some(
        (p) => p.peerId === provider.peerId && p.rpcPort === provider.rpcPort,
      )
    )
      throw new Error(
        "The server tools provider was withdrawn. Reopen the map to start a new server workspace.",
      );
    const invoke =
      request ??
      (async (...args: Parameters<FipsRequest>) => {
        const { getFipsClient } = await runtime();
        args[2].throwIfAborted();
        return getFipsClient().request(...args);
      });
    const result = await invoke(
      provider,
      {
        root,
        path,
        method,
        ...(init.body ? { body: JSON.parse(String(init.body)) } : {}),
      },
      signal,
    );
    signal.throwIfAborted();
    const headers = new Headers(result.headers);
    if (!headers.has("Content-Type"))
      headers.set(
        "Content-Type",
        result.bytes ? "application/octet-stream" : "application/json",
      );
    return new Response(
      result.bytes
        ? new Uint8Array(result.bytes)
        : JSON.stringify(result.body ?? null),
      { status: result.status, headers },
    );
  };
}
export function remoteForSource(
  source: HashtreeSource,
  snapshot: string,
  choice: DeliveryChoice,
  prefix = "",
) {
  if (
    choice.transport === "fips" &&
    source.tree.fips?.some((p) => p.rpcPort !== undefined)
  ) {
    const request = fipsOperationRequest(source.tree);
    return new RemoteOperations(source.url, snapshot, (path, init) =>
      request(prefix + path, init),
    );
  }
  if (choice.transport === "http" && source.apiUrl)
    return new RemoteOperations(source.apiUrl + prefix, snapshot);
  // HTTP fallback is a data-read permission, not consent to execute remote tools elsewhere.
  return undefined;
}

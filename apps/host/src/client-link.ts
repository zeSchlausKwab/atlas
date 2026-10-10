import { clientLink } from "../../shared/urls";
const response = await fetch("/host-config.json", { cache: "no-store" });
if (!response.ok) throw new Error("Host configuration unavailable");
const config = (await response.json()) as { clientUrl: string };
export const openClient = (selection: { map?: string; maps?: string[] } = {}) =>
  clientLink(config.clientUrl, location.origin, selection);

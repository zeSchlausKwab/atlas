import type { Descriptor } from "./registry";
export interface InstalledPlugin { url: string; implementation: string; descriptor: Descriptor }
declare const ATLAS_PLUGIN_ASSETS: InstalledPlugin[];
/** Build-time allowlist, never code learned from an untrusted remote catalog. */
export const installedPlugins: InstalledPlugin[] = typeof ATLAS_PLUGIN_ASSETS === "undefined" ? [] : ATLAS_PLUGIN_ASSETS;

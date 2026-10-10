import { describe, expect, test } from "bun:test";
import {
  deployablePath,
  managedUnit,
  parseDeployArgs,
  shellQuote,
} from "../scripts/deploy-support";

describe("deployment input and isolation", () => {
  test("working-tree deployment accepts both value syntaxes and explicit data opt-in", () => {
    const options = parseDeployArgs([
      "--host=nixuser@nixos",
      "--map",
      "data/custom.atlas",
      "--with-library",
      "--dry-run",
      "--format=json",
    ]);
    expect(options.command).toBe("deploy");
    expect(options.host).toBe("nixuser@nixos");
    expect(options.map).toBe("data/custom.atlas");
    expect(options.withLibrary).toBe(true);
    expect(options.dryRun).toBe(true);
    expect(options.format).toBe("json");
    expect(parseDeployArgs([]).withLibrary).toBe(false);
    expect(parseDeployArgs([]).map).toBeUndefined();
    expect(parseDeployArgs(["--upload-mib=8"]).uploadMiB).toBe(8);
    expect(() => parseDeployArgs(["--upload-mib=0"])).toThrow();
    expect(() => parseDeployArgs(["status", "--upload-mib=8"])).toThrow();
    expect(
      parseDeployArgs(["--resume", "20261010T064147309Z-a495dbcf1785-38a9b710"])
        .resume,
    ).toBeDefined();
    expect(() => parseDeployArgs(["--resume", "../../current"])).toThrow();
  });
  test("rejects shell options, unsafe systemd paths, typos and misplaced flags", () => {
    for (const args of [
      ["--host=-oProxyCommand=bad"],
      ["--root=/"],
      ["--root=/home/nixuser/../other"],
      ["--root=/home/nixuser/atlas%h"],
      ["--port=3100junk"],
      ["--port=80"],
      ["--map"],
      ["--dry-run=false"],
      ["--unkown"],
      ["status", "--with-library"],
    ])
      expect(() => parseDeployArgs(args)).toThrow();
  });
  test("excludes secrets, mutable map storage and platform-specific outputs even when tracked", () => {
    for (const path of [
      ".env",
      "deploy/.env.production",
      "private.key",
      "tls/cert.pem",
      ".git/config",
      "data/hosted/map.atlas",
      "node_modules/foo/index.ts",
      "target/release/importer",
      "dist/main.js",
      "apps/web/server.ts",
      "apps/web/src/main.ts",
      ".aws/credentials",
      "../outside.ts",
      "/tmp/outside.ts",
      "packages/renderer/pkg/atlas_renderer_bg.wasm",
    ])
      expect(deployablePath(path)).toBe(false);
    for (const path of [
      "apps/server/index.ts",
      "apps/host/src/host.ts",
      "apps/shared/styles.css",
      "bun.lock",
      "Cargo.lock",
      "deploy/runtime.nix",
      "scripts/new-tool.ts",
    ])
      expect(deployablePath(path)).toBe(true);
  });
  test("remote shell quoting preserves metacharacters literally", async () => {
    const value = "a' b\n$(printf unsafe)`printf unsafe`";
    const p = Bun.spawn(["/bin/sh", "-c", `printf %s ${shellQuote(value)}`], {
      stdout: "pipe",
    });
    expect(await new Response(p.stdout).text()).toBe(value);
    expect(await p.exited).toBe(0);
  });
  test("unit keeps state outside releases and caps the whole service including import children", () => {
    const unit = managedUnit("/home/nixuser/atlas");
    expect(unit).toContain(
      "EnvironmentFile=-/home/nixuser/atlas/shared/server.env",
    );
    expect(unit).toContain("MemoryMax=20G");
    expect(unit).toContain("CPUQuota=600%");
    expect(unit).toContain("KillMode=control-group");
    expect(unit).not.toContain("sudo");
  });
});

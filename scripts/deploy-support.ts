import { isAbsolute, normalize } from "node:path";

export interface DeployOptions {
  command: "deploy" | "status" | "logs" | "tunnel" | "rollback" | "help";
  host: string;
  root: string;
  port: number;
  localPort: number;
  map?: string;
  resume?: string;
  uploadMiB?: number;
  withLibrary: boolean;
  dryRun: boolean;
  skipChecks: boolean;
  format: "md" | "json";
}

export function parseDeployArgs(args: string[]): DeployOptions {
  const result: DeployOptions = {
    command: "deploy",
    host: "nixuser@192.168.0.179",
    root: "/home/nixuser/atlas",
    port: 3100,
    localPort: 13100,
    withLibrary: false,
    dryRun: false,
    skipChecks: false,
    format: "md",
  };
  const booleans = new Map([
    ["dry-run", "dryRun"],
    ["with-library", "withLibrary"],
    ["skip-checks", "skipChecks"],
  ] as const);
  let commandSeen = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--help" || arg === "-h") {
      result.command = "help";
      continue;
    }
    if (!arg.startsWith("--")) {
      if (
        commandSeen ||
        !["deploy", "status", "logs", "tunnel", "rollback", "help"].includes(
          arg,
        )
      )
        throw new Error(`Unknown command: ${arg}`);
      result.command = arg as DeployOptions["command"];
      commandSeen = true;
      continue;
    }
    const equals = arg.indexOf("="),
      key = arg.slice(2, equals < 0 ? undefined : equals);
    const bool = booleans.get(key as "dry-run");
    if (bool) {
      if (equals >= 0) throw new Error(`--${key} does not take a value`);
      result[bool] = true;
      continue;
    }
    if (
      ![
        "host",
        "root",
        "port",
        "local-port",
        "map",
        "format",
        "resume",
        "upload-mib",
      ].includes(key)
    )
      throw new Error(`Unknown option: --${key}`);
    const value = equals >= 0 ? arg.slice(equals + 1) : args[++i];
    if (!value || value.startsWith("--"))
      throw new Error(`Missing value for --${key}`);
    switch (key) {
      case "host":
        result.host = value;
        break;
      case "root":
        result.root = value;
        break;
      case "upload-mib":
        if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 1024)
          throw new Error("--upload-mib must be 1-1024");
        result.uploadMiB = Number(value);
        break;
      case "resume":
        if (!/^[0-9]{8}T[0-9]{9}Z-[a-f0-9]{12}-[a-f0-9]{8}$/.test(value))
          throw new Error("Invalid release ID for --resume");
        result.resume = value;
        break;
      case "map":
        result.map = value;
        break;
      case "format":
        if (value !== "md" && value !== "json")
          throw new Error("--format must be md or json");
        result.format = value;
        break;
      case "port":
      case "local-port": {
        const n = Number(value);
        if (!/^\d+$/.test(value) || n < 1024 || n > 65535)
          throw new Error(`Invalid --${key}`);
        result[key === "port" ? "port" : "localPort"] = n;
      }
    }
  }
  if (!/^[a-z_][a-z0-9_-]*@[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(result.host))
    throw new Error(
      "--host must be user@hostname (SSH config aliases are supported)",
    );
  // These paths also appear in systemd units. Keep their grammar deliberately small.
  if (
    !isAbsolute(result.root) ||
    normalize(result.root) !== result.root ||
    !/^\/[A-Za-z0-9_/-]+$/.test(result.root) ||
    result.root.split("/").length < 4
  )
    throw new Error(
      "--root must be a dedicated absolute directory, without spaces or ..",
    );
  if (
    result.command !== "deploy" &&
    (result.map ||
      result.withLibrary ||
      result.skipChecks ||
      result.resume ||
      result.uploadMiB)
  )
    throw new Error(
      "--map, --with-library, --resume and --skip-checks apply only to deploy",
    );
  return result;
}

export function shellQuote(value: string) {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}

/** Git supplies the candidate list; never include machine state or credentials. */
export function deployablePath(path: string) {
  const parts = path.split("/");
  return (
    !isAbsolute(path) &&
    !path.startsWith("apps/web/") &&
    !parts.some((p) => p === ".." || !p) &&
    !parts.some((p) =>
      [
        ".git",
        "node_modules",
        "target",
        "dist",
        "data",
        ".ssh",
        ".aws",
        ".codex",
        ".agents",
      ].includes(p),
    ) &&
    !parts.some((p) => p === ".env" || p.startsWith(".env.")) &&
    !/\.(pem|key|p12|pfx)$/i.test(path) &&
    !/^packages\/(renderer|routing)\/pkg\//.test(path)
  );
}

export function managedUnit(root: string) {
  return `# Managed by Atlas: ${root}
[Unit]
Description=Atlas map server
After=network-online.target

[Service]
Type=simple
WorkingDirectory=${root}/current
EnvironmentFile=-${root}/shared/server.env
EnvironmentFile=${root}/current/deploy/release.env
ExecStart=${root}/current/.runtime/bin/bun apps/server/index.ts
Restart=on-failure
RestartSec=3
TimeoutStopSec=90
KillMode=control-group
UMask=0077
Nice=5
CPUQuota=600%
MemoryHigh=16G
MemoryMax=20G
TasksMax=512

[Install]
WantedBy=default.target
`;
}

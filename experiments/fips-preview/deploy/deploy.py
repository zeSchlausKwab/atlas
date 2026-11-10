#!/usr/bin/env python3
"""Stage and activate only atlas-fips-preview.service over SSH."""
import argparse
import datetime
import json
from pathlib import Path, PurePosixPath
import re
import shlex
import subprocess
import tarfile
import tempfile
import uuid
from urllib.parse import urlsplit

SERVICE = "atlas-fips-preview.service"
FILES = (
    "serve-atlas.ts", "fips-service.ts", "package.json", "package-lock.json", ".npmrc",
    "deploy/atlas-fips-preview.service.in", "deploy/validate-provider.ts",
)


def absolute_path(value):
    if not re.fullmatch(r"/[A-Za-z0-9_./+-]+", value):
        raise argparse.ArgumentTypeError("Use an absolute path without spaces or shell metacharacters")
    path = PurePosixPath(value)
    if ".." in path.parts or str(path) != value or value == "/":
        raise argparse.ArgumentTypeError("Use a normalized absolute path, without '..'")
    return value


def ancestor(left, right):
    return PurePosixPath(left) == PurePosixPath(right) or PurePosixPath(left) in PurePosixPath(right).parents


def arguments(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", required=True, help="SSH target, e.g. user@host")
    parser.add_argument("--root", required=True, type=absolute_path, help="Dedicated remote preview directory")
    parser.add_argument("--source-root", required=True, type=absolute_path, help="Existing Atlas source with dependencies")
    parser.add_argument("--index", required=True, type=absolute_path, help="Existing published .sqlite index (read only)")
    parser.add_argument("--bun", required=True, type=absolute_path, help="Remote absolute Bun executable")
    installer = parser.add_mutually_exclusive_group()
    installer.add_argument("--npm", default="npm", help="Remote npm command name or absolute executable")
    installer.add_argument("--npm-via-nix", action="store_true", help="Install with nix shell nixpkgs#nodejs --command npm")
    parser.add_argument("--seeds", default="wss://fips1.iris.to/fips,wss://fips2.iris.to/fips")
    parser.add_argument("--dry-run", action="store_true", help="Validate and print deployment plan; no SSH or mutation")
    args = parser.parse_args(argv)
    if not re.fullmatch(r"[A-Za-z0-9_][A-Za-z0-9_.@:-]*", args.host):
        parser.error("Invalid SSH target")
    if len(PurePosixPath(args.root).parts) < 4:
        parser.error("--root must be a dedicated directory, not a top-level/home directory")
    if any(ancestor(args.root, path) or ancestor(path, args.root)
           for path in (args.source_root, args.index)):
        parser.error("Preview root must be separate from Atlas source and index paths")
    if not args.index.endswith(".sqlite"):
        parser.error("--index must name an existing .sqlite index")
    if not re.fullmatch(r"(?:[A-Za-z0-9_-]+|/[A-Za-z0-9_./+-]+)", args.npm):
        parser.error("--npm accepts one executable, not a shell command")
    seeds = args.seeds.split(",")
    for seed in seeds:
        url = urlsplit(seed)
        if (url.scheme != "wss" or not url.hostname or url.username or url.password
                or url.query or url.fragment or not re.fullmatch(r"wss://[A-Za-z0-9_.:/-]+", seed)):
            parser.error("--seeds must contain comma-separated credential-free wss:// URLs")
    return args


def main():
    args = arguments()
    source = Path(__file__).resolve().parent.parent
    for name in FILES:
        if not (source / name).is_file() or (source / name).is_symlink():
            raise SystemExit(f"Missing regular deployment file: {name}")
    plan = {"service": SERVICE, "host": args.host, "root": args.root,
            "sourceRoot": args.source_root, "index": args.index, "bun": args.bun,
            "files": FILES, "identity": args.root + "/state/provider.key",
            "installer": "nix shell + npm ci" if args.npm_via_nix else "npm ci"}
    print(json.dumps(plan, indent=2), flush=True)
    if args.dry_run:
        return
    ssh = ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", args.host]
    staging = subprocess.check_output(ssh + ["umask 077\nmktemp -d /tmp/atlas-fips-deploy.XXXXXXXX"], text=True).strip()
    if not re.fullmatch(r"/tmp/atlas-fips-deploy\.[A-Za-z0-9]+", staging):
        raise SystemExit("Unexpected SSH staging-directory response; nothing installed")
    release = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ-") + uuid.uuid4().hex[:8]
    try:
        with tempfile.TemporaryDirectory(prefix="atlas-fips-package-") as folder:
            archive = Path(folder) / "provider.tar.gz"
            with tarfile.open(archive, "w:gz", format=tarfile.PAX_FORMAT) as tar:
                for name in FILES:
                    tar.add(source / name, arcname=name, recursive=False)
            subprocess.run(["scp", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15",
                            str(archive), f"{args.host}:{staging}/provider.tar.gz"], check=True)
        params = [args.root, args.source_root, args.index, args.bun, args.npm,
                  "nix" if args.npm_via_nix else "npm", args.seeds, staging, release]
        remote = "bash -s -- " + " ".join(shlex.quote(value) for value in params)
        subprocess.run(ssh + [remote], input=(source / "deploy/remote-install.sh").read_text(), text=True, check=True)
    finally:
        # Only the validated random upload directory is removed. Release/identity state stays.
        subprocess.run(ssh + ["rm -rf -- " + shlex.quote(staging)], check=False)


if __name__ == "__main__":
    main()

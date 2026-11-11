#!/usr/bin/env python3
"""Read a real map over validated cellular; restore the original Wi-Fi setting."""
import argparse
import json
import os
import pathlib
import re
import subprocess
import time

parser = argparse.ArgumentParser()
parser.add_argument("--serial", required=True)
parser.add_argument("--config", required=True)
parser.add_argument("--label", default="public-cellular")
parser.add_argument("--ready-timeout", type=int, default=600)
parser.add_argument("--configured-profile", action="store_true",
                    help="Use the supplied config intent instead of testing bundled defaults")
args = parser.parse_args()
if not re.fullmatch(r"[a-zA-Z0-9_-]+", args.label):
    parser.error("Label must be a simple artifact name")
if args.ready_timeout <= 0:
    parser.error("Ready timeout must be positive")
root = pathlib.Path(__file__).resolve().parents[1]
sdk = pathlib.Path(os.environ.get("ANDROID_HOME", str(pathlib.Path.home() / "Library/Android/sdk")))
adb = [str(sdk / "platform-tools/adb"), "-s", args.serial]

def run(*command):
    return subprocess.check_output(adb + list(command), text=True, timeout=30)

def validated_cellular():
    state = run("shell", "dumpsys", "connectivity")
    active = re.search(r"Active default network: (\d+)", state)
    lines = [line for line in state.splitlines()
             if active and "NetworkAgentInfo{network{" + active.group(1) + "}" in line]
    return bool(lines and "Transports: CELLULAR" in lines[0] and "VALIDATED" in lines[0]
                and run("shell", "settings", "get", "global", "wifi_on").strip() == "0")

was_wifi = run("shell", "settings", "get", "global", "wifi_on").strip() == "1"
try:
    run("shell", "svc", "wifi", "disable")
    deadline = time.monotonic() + 45
    while time.monotonic() < deadline:
        if validated_cellular():
            break
        time.sleep(.2)
    else:
        raise RuntimeError("No validated cellular network with Wi-Fi disabled")
    evidence = {"transport": "CELLULAR", "validated": True, "wifiDisabled": True,
                "testedAt": time.time(), "profile": "configured" if args.configured_profile else "bundled"}
    out = root / "output/phone"
    out.mkdir(parents=True, exist_ok=True)
    evidence_path = out / (args.label + "-network.json")
    evidence_path.write_text(json.dumps(evidence))
    print(evidence, flush=True)
    command = ["python3", str(root / "scripts/test-phone.py"), "--serial", args.serial,
               "--config", args.config, "--ready-timeout", str(args.ready_timeout), "--label", args.label]
    if not args.configured_profile:
        command.append("--bundled-default")
    subprocess.run(command, check=True)
    if not validated_cellular():
        raise RuntimeError("Network changed before acceptance completed; cellular pass is invalid")
    evidence["validatedAtCompletion"] = True
    evidence["completedAt"] = time.time()
    evidence_path.write_text(json.dumps(evidence))
finally:
    run("shell", "svc", "wifi", "enable" if was_wifi else "disable")
    print("Original Wi-Fi setting restored", flush=True)

#!/usr/bin/env python3
"""Install and exercise the UI on an explicitly selected, already running emulator."""
import argparse
import json
import os
import pathlib
import re
import selectors
import shlex
import signal
import socket
import subprocess
import time
import xml.etree.ElementTree as ET

ROOT = pathlib.Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser()
parser.add_argument("--serial", required=True)
args = parser.parse_args()
if not args.serial.startswith("emulator-"):
    parser.error("This smoke test uses 10.0.2.2 and must target an emulator")
sdk = pathlib.Path(os.environ.get("ANDROID_HOME", str(pathlib.Path.home()/"Library/Android/sdk")))
ADB = [str(sdk/"platform-tools/adb"), "-s", args.serial]
OUT = ROOT/"output/emulator"
OUT.mkdir(parents=True, exist_ok=True)


def adb(*args, binary=False):
    return subprocess.check_output(ADB+list(args), text=not binary, timeout=30)


def screen():
    adb("shell", "uiautomator dump /sdcard/fips-demo-ui.xml >/dev/null")
    return ET.fromstring(adb("shell", "cat /sdcard/fips-demo-ui.xml"))


def tap(text):
    for node in screen().iter("node"):
        if node.attrib.get("text", "").casefold() == text.casefold():
            x1,y1,x2,y2 = map(int,re.findall(r"\d+",node.attrib["bounds"]))
            adb("shell", "input", "tap", str((x1+x2)//2), str((y1+y2)//2))
            return
    raise AssertionError(f"No visible control: {text}")


def wait_text(fragment, timeout=30):
    end=time.monotonic()+timeout
    while time.monotonic()<end:
        root=screen()
        if any(fragment in n.attrib.get("text", "") for n in root.iter("node")):
            return root
        time.sleep(0.3)
    (OUT/"failure.png").write_bytes(adb("exec-out","screencap","-p",binary=True))
    raise AssertionError(f"UI did not show {fragment}")


def launch(config):
    adb("shell", "am force-stop soy.napplet.fipsdemo")
    adb("shell", "am start -n soy.napplet.fipsdemo/.MainActivity --es config "+shlex.quote(json.dumps(config)))
    wait_text("Peer details loaded")


adb("install","-r",str(ROOT/"output/native-fips-demo.apk"))
adb("shell","input","keyevent","KEYCODE_WAKEUP")
adb("shell","wm dismiss-keyguard")
for transport in ["udp","tcp"]:
    with socket.socket(type=socket.SOCK_DGRAM if transport=="udp" else socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1",0))
        port=s.getsockname()[1]
    fixture=subprocess.Popen([str(ROOT/"native/target/debug/fips-demo"),"serve",transport,f"127.0.0.1:{port}",f"10.0.2.2:{port}"],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
    try:
        selector=selectors.DefaultSelector();selector.register(fixture.stdout,selectors.EVENT_READ)
        if not selector.select(10): raise AssertionError("Companion peer did not start")
        selector.close()
        config=json.loads(fixture.stdout.readline())
        launch(config);tap("Connect & verify")
        tree=wait_text("SHA-256 verified")
        texts="\n".join(n.attrib.get("text","") for n in tree.iter("node"))
        assert f"{transport.upper()} · " in texts and "verified bytes" in texts, texts
        (OUT/f"{transport}.xml").write_text(ET.tostring(tree,encoding="unicode"))
        (OUT/f"{transport}.png").write_bytes(adb("exec-out","screencap","-p",binary=True))
        print(f"PASS Android {transport.upper()} verified transfer",flush=True)
        if transport=="tcp":
            # No server on this port: exercise cancellation during authentication.
            blocked=dict(config,address="10.0.2.2:9")
            launch(blocked);tap("Connect & verify");tap("Cancel transfer")
            wait_text("Transfer cancelled",10)
            print("PASS Android cancellation",flush=True)
            tap("Connect & verify")
            wait_text("Authenticating")
            adb("shell","input","keyevent","KEYCODE_HOME")
            time.sleep(0.5)
            adb("shell","am start -n soy.napplet.fipsdemo/.MainActivity")
            wait_text("Transfer cancelled",10)
            print("PASS Android background cancellation",flush=True)
    finally:
        fixture.send_signal(signal.SIGINT)
        try: fixture.communicate(timeout=5)
        except subprocess.TimeoutExpired: fixture.kill();fixture.communicate()
print("All emulator checks passed; screenshots in output/emulator",flush=True)

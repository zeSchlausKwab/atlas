#!/usr/bin/env python3
"""Exercise real touch pan/pinch on a configured physical Atlas viewer."""
import argparse
import json
import os
import pathlib
import re
import subprocess

root = pathlib.Path(__file__).resolve().parents[1]
p = argparse.ArgumentParser()
p.add_argument('--serial', required=True)
p.add_argument('--label', default='gestures')
a = p.parse_args()
if a.serial.startswith('emulator-'):
    p.error('Use a physical device for this acceptance test')
sdk = pathlib.Path(os.environ.get('ANDROID_HOME', str(pathlib.Path.home()/'Library/Android/sdk')))
adb = [str(sdk/'platform-tools/adb'), '-s', a.serial]
out = root/'output/phone'
out.mkdir(parents=True, exist_ok=True)

def run(*args, binary=False, timeout=100):
    return subprocess.check_output(adb+list(args), text=not binary, timeout=timeout)

run('install', '-r', str(root/'app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk'))
run('shell', 'input', 'keyevent', 'KEYCODE_WAKEUP')
run('shell', 'wm', 'dismiss-keyguard')
result = run('shell', 'am', 'instrument', '-w', 'org.atlas.nativeviewer.test/soy.napplet.fipsdemo.GestureInstrumentation')
print(result, flush=True)
assert 'result=PASS' in result, result
pid = re.search(r'pid=(\d+)', result).group(1)
logs = run('logcat', '-d', '--pid', pid, '-s', 'AtlasRenderer:I', 'AtlasNative:I', '*:S')
rows=[]
for line in logs.splitlines():
    if 'AtlasRenderer: ' in line:
        try: rows.append(json.loads(line.split('AtlasRenderer: ', 1)[1]))
        except ValueError: pass
ready = [r for r in rows if r.get('triangles', 0)>0 and r.get('tiles')==r.get('wanted') and r.get('loading')==0 and r.get('center')]
assert len(ready)>1, logs
assert ready[-1]['zoom']>ready[0]['zoom']+.3, ready
assert ready[-1]['center']!=ready[0]['center'], ready
(out/(a.label+'.log')).write_text(result+'\n'+logs)
(out/(a.label+'.png')).write_bytes(run('exec-out', 'run-as', 'org.atlas.nativeviewer', 'cat', 'files/gesture.png', binary=True))
print('PASS changed center and zoom, with fully loaded new tiles', ready[0], ready[-1])

#!/usr/bin/env python3
"""Fresh public map read over validated cellular; always restore Wi-Fi."""
import argparse,json,os,pathlib,re,subprocess,time
p=argparse.ArgumentParser();p.add_argument('--serial',required=True);p.add_argument('--config',required=True);a=p.parse_args()
root=pathlib.Path(__file__).resolve().parents[1]
sdk=pathlib.Path(os.environ.get('ANDROID_HOME',str(pathlib.Path.home()/'Library/Android/sdk')))
adb=[str(sdk/'platform-tools/adb'),'-s',a.serial]
def run(*args):return subprocess.check_output(adb+list(args),text=True,timeout=30)
was_wifi=run('shell','settings','get','global','wifi_on').strip()=='1'
try:
 run('shell','svc','wifi','disable')
 deadline=time.monotonic()+45
 while time.monotonic()<deadline:
  state=run('shell','dumpsys','connectivity');active=re.search(r'Active default network: (\d+)',state)
  lines=[l for l in state.splitlines() if active and 'NetworkAgentInfo{network{'+active.group(1)+'}' in l]
  if lines and 'Transports: CELLULAR' in lines[0] and 'VALIDATED' in lines[0]:
   evidence={'transport':'CELLULAR','validated':True,'wifiDisabled':True,'testedAt':time.time()}
   (root/'output/phone').mkdir(parents=True,exist_ok=True)
   (root/'output/phone/public-cellular-network.json').write_text(json.dumps(evidence));print(evidence,flush=True);break
  time.sleep(.2)
 else:raise RuntimeError('No validated cellular network')
 subprocess.run(['python3',str(root/'scripts/test-phone.py'),'--serial',a.serial,'--config',a.config,'--bundled-default','--ready-timeout','600','--label','public-cellular'],check=True)
finally:
 if was_wifi:run('shell','svc','wifi','enable')
 print('Original Wi-Fi setting restored',flush=True)

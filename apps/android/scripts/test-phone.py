#!/usr/bin/env python3
"""Physical-device acceptance, using real LAN peers. No adb reverse or port forwarding."""
import argparse,atexit,json,os,pathlib,re,shlex,subprocess,time,xml.etree.ElementTree as ET
ROOT=pathlib.Path(__file__).resolve().parents[1]
P=argparse.ArgumentParser();P.add_argument('--serial',required=True);P.add_argument('--config',required=True);P.add_argument('--expect-error');P.add_argument('--label',default='map');P.add_argument('--lifecycle',action='store_true');P.add_argument('--network-change',action='store_true');P.add_argument('--bundled-default',action='store_true');P.add_argument('--cancel-pending',action='store_true');P.add_argument('--switch-map',action='append',default=[]);P.add_argument('--check-layers',action='store_true');a=P.parse_args()
if a.serial.startswith('emulator-'):P.error('Use a connected physical device for this test')
SDK=pathlib.Path(os.environ.get('ANDROID_HOME',str(pathlib.Path.home()/'Library/Android/sdk')))
ADB=[str(SDK/'platform-tools/adb'),'-s',a.serial];OUT=ROOT/'output/phone';OUT.mkdir(parents=True,exist_ok=True)
PACKAGE='org.atlas.nativeviewer';ACTIVITY=PACKAGE+'/soy.napplet.fipsdemo.AtlasActivity'
def adb(*args,binary=False):return subprocess.check_output(ADB+list(args),text=not binary,timeout=40)
def screen():
 adb('shell','uiautomator dump /sdcard/atlas-native-ui.xml >/dev/null');return ET.fromstring(adb('exec-out','cat','/sdcard/atlas-native-ui.xml'))
def texts(tree):return '\n'.join(n.get('text','') for n in tree.iter('node'))
def wait_ui(check,timeout=40):
 end=time.monotonic()+timeout
 while time.monotonic()<end:
  t=screen()
  if check(texts(t)):return t
 (OUT/(a.label+'-failure.png')).write_bytes(adb('exec-out','screencap','-p',binary=True));raise AssertionError(texts(t))
def tap(fragment):
 for n in screen().iter('node'):
  if fragment.casefold() in (n.get('text','') or n.get('content-desc','')).casefold() and (n.get('clickable')=='true' or n.get('checkable')=='true'):
   x,y,x2,y2=map(int,re.findall(r'\d+',n.get('bounds')));adb('shell','input','tap',str((x+x2)//2),str((y+y2)//2));return
 raise AssertionError('Control absent: '+fragment)
def logs():return live_path.read_text(errors='replace')
def ready():
 tree=wait_ui(lambda t:'Map · z' in t and 'tiles · ready' in t,timeout=120)
 events=[]
 for line in logs().splitlines():
  marker='AtlasRenderer: '
  if marker in line:
   try:events.append(json.loads(line.split(marker,1)[1]))
   except ValueError:pass
 selected=re.findall(r'selected root=([a-f0-9]{64})',logs())
 good=[e for e in events if e.get('tiles',0)>0 and e.get('tiles')==e.get('wanted') and e.get('loading')==0 and (not selected or e.get('root')==selected[-1])]
 assert good,logs();return tree,good[-1]
config=json.loads(pathlib.Path(a.config).read_text());assert config['address'].split(':')[0] not in ['127.0.0.1','10.0.2.2','localhost'],'Physical test must use LAN endpoint'
adb('shell','am','force-stop',PACKAGE)
adb('shell','input','keyevent','KEYCODE_WAKEUP');adb('shell','wm','dismiss-keyguard')
if a.bundled_default:
 adb('shell','pm','clear',PACKAGE) # Only this isolated test app; prove the APK needs no setup.
 adb('shell','am','start','-W','-n',ACTIVITY)
else:adb('shell','am','start','-W','-n',ACTIVITY,'--es','config',shlex.quote(json.dumps(config)))
pid=adb('shell','pidof',PACKAGE).strip()
# Stream evidence: logcat's ring can wrap during long multi-map tests, so slicing
# successive snapshots by character count can otherwise miss lifecycle events.
live_path=OUT/(a.label+'-live.log');live_file=live_path.open('w')
log_reader=subprocess.Popen(ADB+['logcat','--pid',pid,'-s','AtlasNative:I','AtlasRenderer:I','*:S'],stdout=live_file,stderr=subprocess.STDOUT)
def stop_logs():
 log_reader.terminate()
 try:log_reader.wait(timeout=5)
 except subprocess.TimeoutExpired:log_reader.kill();log_reader.wait()
 live_file.close()
atexit.register(stop_logs)
if a.cancel_pending:
 wait_ui(lambda t:'Authenticating pinned native peer' in t)
 tap('Cancel / disconnect')
 tree=wait_ui(lambda t:'Disconnected by you' in t and 'Reconnect & discover' in t)
 assert 'closed Cancelled' in logs(),logs()
 print('PASS cancellation while authentication is pending',flush=True)
elif a.expect_error:
 tree=wait_ui(lambda t:a.expect_error in t)
 assert 'Map · z' not in texts(tree),'Map must not render on verification failure'
else:
 tree,stats=ready();assert config['transport'].upper()+' · ' in texts(tree)
 print('PASS automatic real-map load',config['transport'],stats,flush=True)
 for name in a.switch_map:
  # The persistent native map button has the selected name, and sits beside Layers.
  buttons=[n for n in screen().iter('node') if n.get('class')=='android.widget.Button' and ('Lower Rhine' in n.get('text','') or 'Satellite ·' in n.get('text','') or 'Hosted maps' in n.get('text',''))]
  assert len(buttons)==1, texts(screen())
  tap(buttons[0].get('text'))
  tree=wait_ui(lambda t:'Hosted maps ·' in t and name in t)
  tap(name)
  tree,stats=ready()
  assert name in texts(tree),texts(tree)
  print('PASS map selection',name,stats,flush=True)
 if a.check_layers:
  tap('Layers');tree=wait_ui(lambda t:'Display layers ·' in t)
  controls=[n.get('text') for n in tree.iter('node') if n.get('checkable')=='true' and n.get('checked')=='true']
  assert controls,texts(tree)
  for label in controls:tap(label)
  tap('Apply');tree=wait_ui(lambda t:'0/0 tiles · ready' in t)
  before=re.findall(r'verified carrier=\w+ bytes=(\d+)',logs())[-1]
  tap('Zoom in');tree=wait_ui(lambda t:'0/0 tiles · ready' in t)
  assert re.findall(r'verified carrier=\w+ bytes=(\d+)',logs())[-1]==before,'Disabled layers fetched more package bytes'
  tap('Layers');wait_ui(lambda t:'Display layers ·' in t)
  for label in controls:tap(label)
  tap('Apply');tree,stats=ready()
  print('PASS display choices disable rendering and further tile reads; re-enable loads tiles',flush=True)
 if a.lifecycle:
  adb('shell','input','keyevent','KEYCODE_HOME')
  # Observe native close before resuming; no arbitrary sleep.
  end=time.monotonic()+10
  while 'closed Cancelled' not in logs() and time.monotonic()<end:time.sleep(.05)
  assert 'closed Cancelled' in logs(),logs()
  adb('shell','am','start','-W','-n',ACTIVITY)
  tree,stats=ready();print('PASS foreground reconnect',flush=True)
  tap('Cancel / disconnect');tree=wait_ui(lambda t:'Disconnected by you' in t and 'Reconnect & discover' in t)
  before=logs();assert 'closed Cancelled' in before
  tap('Reconnect & discover');tree,stats=ready();print('PASS cancellation and explicit reconnect',flush=True)
 if a.network_change:
  try:
   before=logs()
   adb('shell','svc','wifi','disable')
   end=time.monotonic()+20
   while time.monotonic()<end:
    changed=logs()[len(before):]
    if 'closed Network' in changed:break
    time.sleep(.05)
   else:raise AssertionError('Native session did not close on network change')
  finally:adb('shell','svc','wifi','enable')
  tree,stats=ready();print('PASS Wi-Fi loss and automatic reconnect',flush=True)
(OUT/(a.label+'.xml')).write_text(ET.tostring(tree,encoding='unicode'))
(OUT/(a.label+'.png')).write_bytes(adb('exec-out','screencap','-p',binary=True))
(OUT/(a.label+'.log')).write_text(logs())
print('PASS',a.label,flush=True)

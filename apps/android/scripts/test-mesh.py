#!/usr/bin/env python3
"""Three-node native acceptance. Client has only an ingress address + host npub.

The host is a distinct FIPS node reached through the gateway; it is never added
as a direct peer by the client. Reliable FIPS streams run over TCP or UDP entry
links, then over the provider's TCP link. No HTTP/WebSocket/network discovery.
"""
import argparse, json, pathlib, selectors, shutil, signal, socket, subprocess, tempfile
ROOT = pathlib.Path(__file__).resolve().parents[1]
p = argparse.ArgumentParser()
p.add_argument('--export', required=True)
a = p.parse_args()
source = pathlib.Path(a.export).resolve()
peer = ROOT/'native/target/debug/atlas-peer'
probe = ROOT/'native/target/debug/atlas-probe'

def endpoint(udp=False):
    with socket.socket(type=socket.SOCK_DGRAM if udp else socket.SOCK_STREAM) as s:
        s.bind(('127.0.0.1', 0))
        return f'127.0.0.1:{s.getsockname()[1]}'

def start(args):
    log = tempfile.TemporaryFile(mode='w+')
    process = subprocess.Popen([str(peer), *args], stdout=subprocess.PIPE, stderr=log, text=True)
    selector = selectors.DefaultSelector()
    selector.register(process.stdout, selectors.EVENT_READ)
    try:
        assert selector.select(15), 'Node did not announce readiness'
        line = process.stdout.readline()
        if not line:
            log.seek(0); raise AssertionError(log.read())
        return process, json.loads(line), log
    finally:
        selector.close()

def stop(process, log):
    process.send_signal(signal.SIGINT)
    try: process.communicate(timeout=5)
    except subprocess.TimeoutExpired:
        process.kill(); process.communicate()
    log.close()

def check(c, error=None):
    r = subprocess.run([str(probe), json.dumps(c)], capture_output=True, text=True, timeout=120)
    if error:
        assert r.returncode and error in r.stderr, r.stdout+r.stderr
        return
    assert r.returncode == 0, r.stdout+r.stderr
    rows = [json.loads(l) for l in r.stdout.splitlines() if l.startswith('{')]
    route = next(r for r in rows if r.get('stage')=='route')
    assert route['nextHop']==c['bootstrap']['peer'] and route['nextHop']!=c['peer'], route
    assert next(r for r in rows if r.get('stage')=='atlas-header')['headerHex'].startswith(b'ATLAS001'.hex())
    assert next(r for r in rows if r.get('stage')=='repeated-reads')['blobs']>=33

with tempfile.TemporaryDirectory(prefix='atlas-mesh-') as temp:
    d = pathlib.Path(temp)
    shutil.copyfile(source/'offers.json',d/'offers.json')
    (d/'blobs').symlink_to(source/'blobs',target_is_directory=True)
    g, seed, glog = start(['gateway',endpoint(),endpoint(True),str(d)])
    try:
        seedfile = d/'seed.json'
        seedfile.write_text(json.dumps({'peer':seed['peer'],'address':seed['tcp']}))
        bind = endpoint()
        for corrupt in [False,True]:
            server,c,log = start(['serve','tcp',bind,bind,str(d),'--bootstrap',str(seedfile)]+(['--corrupt'] if corrupt else []))
            try:
                assert c['peer']!=seed['peer'] and 'address' not in c and 'catalog' not in c
                for carrier in ['tcp','udp']:
                    c.update(transport=carrier,bootstrap={'peer':seed['peer'],'address':seed[carrier]})
                    check(c,'SHA-256 mismatch' if corrupt else None)
                    print(f'PASS {carrier} entry → TCP provider: '+('corrupt bytes rejected' if corrupt else 'npub discovery, signature, root grant, descendants, repeat reads'),flush=True)
            finally: stop(server,log)
        # Provider keeps LAN ingress while dialing a distinct public-style entry
        # over UDP. Client knows only that entry + provider npub, never LAN address.
        (d/'public-entry').mkdir()
        remote, ingress, rlog = start(['gateway',endpoint(),endpoint(True),str(d/'public-entry')])
        try:
            uplinks=d/'uplinks.json'
            uplinks.write_text(json.dumps({'peers':[{'peer':ingress['peer'],'transport':'udp','address':ingress['udp']}]}))
            server,c,log = start(['serve','tcp',bind,bind,str(d),'--bootstrap',str(seedfile),'--uplinks',str(uplinks)])
            try:
                c.update(transport='udp',bootstrap={'peer':ingress['peer'],'address':ingress['udp']})
                check(c)
                c.update(transport='tcp',bootstrap={'peer':seed['peer'],'address':seed['tcp']})
                check(c)
                print('PASS outbound UDP public-style entry and retained TCP LAN entry',flush=True)
            finally: stop(server,log)
        finally: stop(remote,rlog)
        # A distinct valid identity is unreachable after its independent node stops.
        (d/'other').mkdir()
        other, identity, otherlog=start(['gateway',endpoint(),endpoint(True),str(d/'other')])
        stop(other,otherlog)
        absent=dict(c,peer=identity['peer'])
        check(absent,'timed out')
        wrong=dict(c,bootstrap={'peer':identity['peer'],'address':seed['tcp']},transport='tcp')
        check(wrong,'timed out')
        print('PASS unavailable host and wrong entry identity: no substitution or fallback',flush=True)
    finally: stop(g,glog)
print('All three-node mesh checks passed')

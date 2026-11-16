#!/usr/bin/env python3
"""Real Atlas discovery and native TCP/UDP provider acceptance (isolated loopback)."""
import argparse
import json
import pathlib
import selectors
import shutil
import signal
import socket
import subprocess
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
p = argparse.ArgumentParser()
p.add_argument('--export', required=True, help='Directory produced by export-map.ts')
a = p.parse_args()
source = pathlib.Path(a.export).resolve()
peer = ROOT/'native/target/debug/atlas-peer'
probe = ROOT/'native/target/debug/atlas-probe'


def run_peer(directory, carrier, corrupt=False):
    with socket.socket(type=socket.SOCK_DGRAM if carrier == 'udp' else socket.SOCK_STREAM) as s:
        s.bind(('127.0.0.1', 0))
        port = s.getsockname()[1]
    endpoint = f'127.0.0.1:{port}'
    # A regular file prevents provider logs from blocking the server's pipe.
    log = tempfile.TemporaryFile(mode='w+')
    process = subprocess.Popen([str(peer), 'serve', carrier, endpoint, endpoint, str(directory)] +
                               (['--corrupt'] if corrupt else []), stdout=subprocess.PIPE, stderr=log, text=True)
    selector = selectors.DefaultSelector()
    selector.register(process.stdout, selectors.EVENT_READ)
    try:
        assert selector.select(10), 'Native provider did not announce settings'
        config = json.loads(process.stdout.readline())
        return process, config, log
    except BaseException:
        stop(process, log)
        raise
    finally:
        selector.close()


def stop(process, log):
    process.send_signal(signal.SIGINT)
    try:
        process.communicate(timeout=5)
    except subprocess.TimeoutExpired:
        process.kill()
        process.communicate()
    log.close()


def check(config, error=None):
    result = subprocess.run([str(probe), json.dumps(config)], text=True, capture_output=True, timeout=100)
    if error:
        assert result.returncode != 0 and error in result.stderr, result.stdout + result.stderr
    else:
        assert result.returncode == 0, result.stdout + result.stderr
        rows = [json.loads(line) for line in result.stdout.splitlines() if line.startswith('{')]
        header = next(row for row in rows if row.get('stage') == 'atlas-header')
        assert header['headerHex'].startswith(b'ATLAS001'.hex()), header
        assert next(row for row in rows if row.get('stage') == 'repeated-reads')['blobs'] >= 34


with tempfile.TemporaryDirectory(prefix='atlas-native-acceptance-') as temp:
    directory = pathlib.Path(temp)
    shutil.copyfile(source/'offers.json', directory/'offers.json')
    # Only immutable public map bytes are shared. Test identities never touch the input store.
    (directory/'blobs').symlink_to(source/'blobs', target_is_directory=True)
    for carrier in ['tcp', 'udp']:
        process, config, log = run_peer(directory, carrier)
        try:
            check(config)
            # A second consumer and many streams must not exhaust provider transfer slots.
            check(config)
            assert process.poll() is None
        finally:
            stop(process, log)
        process, restored, log = run_peer(directory, carrier)
        try:
            for key in ['peer', 'publisher', 'catalog']:
                assert config[key] == restored[key], f'{key} changed across restart'
            check(restored)
        finally:
            stop(process, log)
        process, corrupt, log = run_peer(directory, carrier, True)
        try:
            check(corrupt, 'SHA-256 mismatch')
            assert process.poll() is None, 'Bad client must not kill provider'
        finally:
            stop(process, log)
        print(f'PASS {carrier}: signed discovery, real Atlas header, grants, descendants, repeated reads, restart pins, corruption', flush=True)
print('All native Atlas provider checks passed')

#!/usr/bin/env python3
"""Exercise real native sockets and the CLI boundary, without public services."""
import json
import pathlib
import selectors
import signal
import socket
import subprocess
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
BIN = ROOT / "native/target/debug/fips-demo"


class Fixture:
    def __init__(self, transport, corrupt=False):
        with socket.socket(type=socket.SOCK_DGRAM if transport == "udp" else socket.SOCK_STREAM) as s:
            s.bind(("127.0.0.1", 0))
            address = f"127.0.0.1:{s.getsockname()[1]}"
        args = [str(BIN), "serve", transport, address]
        if corrupt:
            args += [address, "--corrupt"]
        self.process = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        selector = selectors.DefaultSelector()
        selector.register(self.process.stdout, selectors.EVENT_READ)
        if not selector.select(10):
            self.close()
            raise RuntimeError("Fixture did not start")
        selector.close()
        self.config = json.loads(self.process.stdout.readline())

    def close(self):
        if self.process.poll() is None:
            self.process.send_signal(signal.SIGINT)
        try:
            self.process.communicate(timeout=5)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.communicate()


def fetch(config):
    return subprocess.run([str(BIN), "fetch", json.dumps(config)], text=True, capture_output=True, timeout=35)


class NativeTransportTests(unittest.TestCase):
    def test_native_tcp_and_udp_verified_transfer(self):
        for transport in ["tcp", "udp"]:
            with self.subTest(transport=transport):
                fixture = Fixture(transport)
                try:
                    completed = fetch(fixture.config)
                    self.assertEqual(completed.returncode, 0, completed.stderr + completed.stdout)
                    events = [json.loads(line) for line in completed.stdout.splitlines()]
                    self.assertEqual(events[-1]["stage"], "complete")
                    self.assertEqual(events[-1]["carrier"], transport)
                    self.assertGreater(events[-1]["bytes"], 256000)
                    self.assertEqual(events[-1]["hash"], fixture.config["hash"])
                    self.assertTrue(any(e["stage"] == "connected" and e["carrier"] == transport for e in events))
                finally:
                    fixture.close()

    def test_missing_blob_is_not_a_success(self):
        fixture = Fixture("udp")
        try:
            config = dict(fixture.config, hash="00" * 32)
            result = fetch(config)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("does not have this blob", result.stderr)
            self.assertNotIn('"complete"', result.stdout)
        finally:
            fixture.close()

    def test_corrupt_bytes_are_discarded(self):
        fixture = Fixture("tcp", corrupt=True)
        try:
            result = fetch(fixture.config)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("SHA-256 mismatch", result.stderr)
            self.assertNotIn('"preview"', result.stdout)
        finally:
            fixture.close()

    def test_no_dns_or_websocket_fallback(self):
        fixture = Fixture("tcp")
        try:
            for patch, error in [({"address": "example.com:443"}, "numeric IP"), ({"transport": "websocket"}, "TCP or UDP")]:
                result = fetch(dict(fixture.config, **patch))
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(error, result.stderr)
                self.assertNotIn('"connecting"', result.stdout)
        finally:
            fixture.close()

    def test_wrong_peer_identity_never_authenticates(self):
        first, second = Fixture("udp"), Fixture("udp")
        try:
            result = fetch(dict(first.config, peer=second.config["peer"]))
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("timed out", result.stderr)
            self.assertNotIn('"connected"', result.stdout)
            self.assertNotIn('"complete"', result.stdout)
        finally:
            first.close()
            second.close()


if __name__ == "__main__":
    unittest.main(verbosity=2)

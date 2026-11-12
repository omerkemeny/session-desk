"""Exit codes mean one thing: the CLI's own code, 128 + signal for a signal death, -1 only when the host or server lost the terminal."""
import json
import os
import signal
import sys
import time
import unittest

from helpers import wait_until
from desk import termhost
from test_termhost import SID, Env, Server, gone, read_until

EXIT_CLI = """#!{python}
import os, signal, sys
print("cli ready %d" % os.getpid(), flush=True)
for line in sys.stdin:
    line = line.strip()
    if line.startswith("exit"):
        sys.exit(int(line[4:]))
    if line.startswith("kill"):
        os.kill(os.getpid(), int(line[4:]))
    print("got " + line, flush=True)
"""


def term(argv):
    """A terminal of the host's own Term class running argv."""
    return termhost.Term("x", argv, "/", dict(os.environ), 80, 24, lambda: None)


def finished(t, timeout=10):
    """The terminal's exit code once its CLI ended."""
    with t.cond:
        t.cond.wait_for(lambda: t.code is not None, timeout)
    return t.code


class CodeTest(unittest.TestCase):
    def test_status_mapping(self):
        self.assertEqual(termhost.exit_code(3 << 8), 3)
        self.assertEqual(termhost.exit_code(0), 0)
        for sig, code in ((signal.SIGHUP, 129), (signal.SIGINT, 130), (signal.SIGKILL, 137), (signal.SIGTERM, 143)):
            self.assertEqual(termhost.exit_code(int(sig)), code)

    def test_own_code(self):
        self.assertEqual(finished(term(["/bin/sh", "-c", "exit 3"])), 3)

    def test_end_is_hangup(self):
        t = term(["/bin/sh", "-c", "sleep 30"])
        t.end()
        self.assertEqual(t.code, 129)

    def test_kill_and_term(self):
        for sig, code in ((signal.SIGKILL, 137), (signal.SIGTERM, 143), (signal.SIGINT, 130)):
            t = term(["/bin/sh", "-c", "sleep 30"])
            time.sleep(0.2)
            t.kill_group(sig)
            self.assertEqual(finished(t), code, sig)


class Modes:
    """End terminal, own exit, restart, in one terminal mode (host or local)."""
    local = False

    def setUp(self):
        self.env = Env()
        with open(self.env.cli, "w") as fh:
            fh.write(EXIT_CLI.format(python=sys.executable))
        if self.local:
            self.env.env["DESK_TERMHOST"] = "0"
        self.servers = []

    def tearDown(self):
        for s in self.servers:
            if s.proc.poll() is None:
                s.kill(signal.SIGKILL)
        self.assertEqual(self.env.close(), [], "orphan processes after the test")

    def start(self):
        """A server with one open terminal and its stream read up to the CLI's ready line; returns (server, cli pid)."""
        s = Server(self.env)
        self.servers.append(s)
        self.assertEqual(s.call("POST", "/api/term/open", {"id": SID, "cols": 80, "rows": 24})[0], 200)
        conn, resp = s.stream()
        text, _, _ = read_until(resp, "cli ready")
        conn.close()
        return s, int(text.split("cli ready ")[1].split()[0])

    def test_end_terminal_is_129_on_every_stream(self):
        s, cli = self.start()
        streams = [s.stream() for _ in range(2)]
        for _, resp in streams:
            read_until(resp, "cli ready")
        self.assertEqual(s.call("POST", "/api/term/close", {"id": SID})[0], 200)
        codes = [read_until(resp, "\0never\0")[2] for _, resp in streams]
        for conn, _ in streams:
            conn.close()
        self.assertEqual(codes, [129, 129])
        self.assertTrue(wait_until(lambda: gone(cli)))
        conn, resp = s.stream()  # a page attaching afterwards gets the same code
        code = read_until(resp, "\0never\0")[2] if resp.status == 200 else 129
        conn.close()
        self.assertEqual(code, 129)

    def test_own_exit_code(self):
        s, _ = self.start()
        conn, resp = s.stream()
        read_until(resp, "cli ready")
        self.assertEqual(s.call("POST", "/api/term/input", {"id": SID, "data": "exit3\r"})[0], 200)
        self.assertEqual(read_until(resp, "\0never\0")[2], 3)
        conn.close()

    def test_restart_mid_stream_sends_no_exit(self):
        for sig in (signal.SIGTERM, signal.SIGKILL):
            s, _ = self.start()
            conn, resp = s.stream()
            read_until(resp, "cli ready")
            s.kill(sig)
            self.assertIsNone(read_until(resp, "\0never\0", timeout=5)[2], f"exit event on restart ({sig})")
            conn.close()


class HostModeTest(Modes, unittest.TestCase):
    def test_host_killed_is_minus_one(self):
        s, cli = self.start()
        conn, resp = s.stream()
        read_until(resp, "cli ready")
        pid = json.loads(s.call("GET", "/api/health")[1])["termhost"]["pid"]
        os.kill(pid, signal.SIGKILL)
        self.assertEqual(read_until(resp, "\0never\0")[2], -1)
        conn.close()
        os.kill(cli, signal.SIGKILL)  # the host's CLI outlives its host's death; the test cleans it up
        wait_until(lambda: gone(cli))


class LocalModeTest(Modes, unittest.TestCase):
    local = True


if __name__ == "__main__":
    unittest.main()

"""Terminal host: page terminals survive SIGTERM and SIGKILL of the server, re-attach with replay, keys and end; private socket; no orphans."""
import base64
import fcntl
import http.client
import json
import os
import re
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock

from helpers import FIXTURE, ROOT, wait_until
from desk import termhost, terms

SID = "abcdef12-0000-4000-8000-000000000002"
ECHO_CLI = """#!{python}
import os, sys
print("cli ready %d" % os.getpid(), flush=True)
for line in sys.stdin:
    print("got " + line.strip(), flush=True)
"""


def ours(tmp):
    """Processes whose command line mentions a test folder (servers, hosts, stub CLIs)."""
    out = subprocess.run(["pgrep", "-f", tmp], capture_output=True, text=True).stdout.split()
    return [int(p) for p in out if int(p) != os.getpid()]


def gone(pid):
    """True once a process no longer exists."""
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return True
    return False


class Env:
    """A temp data folder with one session, a stub CLI that echoes lines, and a private state folder."""

    def __init__(self):
        self.tmp = tempfile.mkdtemp(prefix="desk-host-")
        self.home = os.path.join(self.tmp, "claude")
        shutil.copytree(FIXTURE, self.home)
        os.makedirs(os.path.join(self.home, "sessions"))
        project = os.path.join(self.home, "projects", "-tmp-host")
        os.makedirs(project)
        rec = {"type": "user", "uuid": "u1", "parentUuid": None, "isSidechain": False, "timestamp": "2026-01-01T00:00:00Z", "entrypoint": "cli",
               "cwd": self.tmp, "message": {"role": "user", "content": "hello"}}
        with open(os.path.join(project, SID + ".jsonl"), "w") as fh:
            fh.write(json.dumps(rec) + "\n")
        self.cli = os.path.join(self.tmp, "echo-cli")
        with open(self.cli, "w") as fh:
            fh.write(ECHO_CLI.format(python=sys.executable))
        os.chmod(self.cli, 0o755)
        self.env = dict(os.environ, DESK_CLAUDE_DIR=self.home, DESK_CLAUDE_BIN=self.cli, DESK_STATE_DIR=self.tmp)
        self.env.pop("DESK_TERMHOST", None)
        self.rd = termhost.run_dir(self.tmp, self.home)

    def close(self):
        """Stop anything left, then delete the folder; returns the processes that had to be killed."""
        subprocess.run([sys.executable, os.path.join(ROOT, "server.py"), "stop-terminals"], env=self.env, capture_output=True, timeout=30)
        left = ours(self.tmp)
        for pid in left:
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        shutil.rmtree(self.tmp, ignore_errors=True)
        return left


class Server:
    """`python3 server.py` in the foreground on a port the server picks itself (PORT=0) and prints."""

    def __init__(self, env):
        self.proc = subprocess.Popen([sys.executable, os.path.join(ROOT, "server.py")], cwd=env.tmp, env=dict(env.env, PORT="0"),
                                     stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        line = self.proc.stdout.readline()
        m = re.search(r"127\.0\.0\.1:(\d+)", line)
        assert m, line
        self.port = int(m.group(1))
        page = self.call("GET", "/")[1]
        self.token = re.search(rb'DESK_TOKEN="([^"]+)"', page).group(1).decode()

    def call(self, method, path, body=None):
        """One request; returns (status, body bytes)."""
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        h = {"Host": f"127.0.0.1:{self.port}"}
        if method == "POST":
            h.update({"Origin": f"http://127.0.0.1:{self.port}", "X-Desk-Token": getattr(self, "token", ""), "Content-Type": "application/json"})
        conn.request(method, path, body=json.dumps(body).encode() if body else None, headers=h)
        r = conn.getresponse()
        out = r.status, r.read()
        conn.close()
        return out

    def stream(self, last=None):
        """Open the terminal stream; returns (connection, response)."""
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        h = {"Host": f"127.0.0.1:{self.port}"}
        if last is not None:
            h["Last-Event-ID"] = str(last)
        conn.request("GET", f"/api/term/stream?id={SID}", headers=h)
        return conn, conn.getresponse()

    def kill(self, sig):
        """Signal the server and wait for it to exit."""
        self.proc.send_signal(sig)
        self.proc.wait(15)
        self.proc.stdout.close()


def read_until(resp, needle, timeout=10):
    """Read stream events until the decoded output contains needle or the deadline passes; returns (text, last id, exit code or None)."""
    text, last, end, ev = "", None, time.monotonic() + timeout, []
    while needle not in text and time.monotonic() < end:
        line = resp.readline()
        if not line:
            break
        line = line.decode().rstrip("\n")
        if line and not line.startswith(":"):
            ev.append(line)
            continue
        if not ev:
            continue
        if ev[0] == "event: exit":
            return text, last, int(ev[1].split(": ")[1])
        last = int(ev[0].split(": ")[1])
        text += base64.b64decode(ev[1].split(": ", 1)[1]).decode(errors="replace")
        ev = []
    return text, last, None


class RestartTest(unittest.TestCase):
    def setUp(self):
        self.env = Env()
        self.servers = []

    def tearDown(self):
        for s in self.servers:
            if s.proc.poll() is None:
                s.kill(signal.SIGKILL)
        left = self.env.close()
        self.assertEqual(left, [], "orphan processes after the test")

    def server(self):
        """Start a server and remember it for cleanup."""
        s = Server(self.env)
        self.servers.append(s)
        return s

    def survive(self, sig):
        """Open a terminal, kill the server with sig, start a new one, re-attach, type, end it."""
        a = self.server()
        self.assertEqual(a.call("POST", "/api/term/open", {"id": SID, "cols": 80, "rows": 24}), (200, b'{"ok": true, "restarted": false}'))
        conn, resp = a.stream()
        text, _, _ = read_until(resp, "cli ready")
        conn.close()
        cli = int(re.search(r"cli ready (\d+)", text).group(1))
        host = json.loads(a.call("GET", "/api/health")[1])["termhost"]
        self.assertEqual((host["running"], host["terms"], host["protocol"]), (True, 1, termhost.PROTOCOL))
        a.kill(sig)
        time.sleep(0.3)
        self.assertFalse(gone(cli), "page terminal ended with the server")
        self.assertFalse(gone(host["pid"]), "terminal host ended with the server")

        b = self.server()
        h = json.loads(b.call("GET", "/api/health")[1])
        self.assertEqual((h["terms"], h["termhost"]["pid"], h["termhost"]["terms"], h["ok"]), (1, host["pid"], 1, True))
        sessions = json.loads(b.call("GET", "/api/sessions")[1])
        self.assertTrue(next(s for s in sessions if s["id"] == SID)["term"])
        self.assertEqual(b.call("POST", "/api/term/open", {"id": SID, "cols": 90, "rows": 30})[0], 200)  # the page re-attaching
        conn, resp = b.stream()
        text, last, _ = read_until(resp, "cli ready")  # earlier output, replayed from the host's log
        self.assertIn(f"cli ready {cli}", text)
        self.assertEqual(b.call("POST", "/api/term/input", {"id": SID, "data": "hello\r"}), (200, b'{"ok": true}'))
        text, last2, _ = read_until(resp, "got hello")
        self.assertIn("got hello", text)
        conn.close()
        conn, resp = b.stream(last=last2)  # resume after the last event id: only new output
        self.assertEqual(b.call("POST", "/api/term/input", {"id": SID, "data": "again\r"})[0], 200)
        text, _, _ = read_until(resp, "got again")
        self.assertNotIn("cli ready", text)
        self.assertNotIn("got hello", text)
        self.assertEqual(b.call("POST", "/api/term/close", {"id": SID}), (200, b'{"ok": true}'))
        _, _, code = read_until(resp, "\0never\0")
        conn.close()
        self.assertIsNotNone(code)
        self.assertTrue(wait_until(lambda: gone(cli), timeout=5), "CLI still running after End terminal")
        self.assertTrue(wait_until(lambda: json.loads(b.call("GET", "/api/health")[1])["terms"] == 0, timeout=5))
        b.kill(signal.SIGTERM)

    def test_terminal_survives_sigterm(self):
        self.survive(signal.SIGTERM)

    def test_terminal_survives_sigkill(self):
        self.survive(signal.SIGKILL)

    def test_stop_terminals_ends_them(self):
        a = self.server()
        self.assertEqual(a.call("POST", "/api/term/open", {"id": SID, "cols": 80, "rows": 24})[0], 200)
        conn, resp = a.stream()
        cli = int(re.search(r"cli ready (\d+)", read_until(resp, "cli ready")[0]).group(1))
        out = subprocess.run([sys.executable, os.path.join(ROOT, "server.py"), "stop-terminals"], env=self.env.env, capture_output=True, text=True, timeout=30)
        self.assertIn("1 terminals ended", out.stdout)
        self.assertIsNotNone(read_until(resp, "\0never\0")[2])  # the page's stream ends with an exit event
        conn.close()
        self.assertTrue(wait_until(lambda: gone(cli), timeout=5))
        self.assertTrue(wait_until(lambda: json.loads(a.call("GET", "/api/health")[1])["termhost"]["running"] is False, timeout=5))
        a.kill(signal.SIGTERM)


class HostProcessTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="desk-hp-")
        self.rd = os.path.join(self.tmp, "run")
        self.procs = []

    def tearDown(self):
        for p in self.procs:
            if p.poll() is None:
                p.kill()
            p.wait(5)
        shutil.rmtree(self.tmp, ignore_errors=True)
        self.assertEqual(ours(self.tmp), [])

    def host(self, idle="300"):
        """Start a host for the test run folder."""
        p = subprocess.Popen([sys.executable, "-m", "desk.termhost", "--dir", self.rd], cwd=ROOT, env=dict(os.environ, DESK_TERMHOST_IDLE=idle),
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
        self.procs.append(p)
        return p

    def hello(self):
        """The host's hello, or None."""
        try:
            return termhost.call(self.rd, {"op": "hello"}, 1, version=False)
        except termhost.HostError:
            return None

    def test_private_socket_one_host_and_versioned_ops(self):
        p = self.host()
        self.assertTrue(wait_until(self.hello))
        self.assertEqual(os.stat(self.rd).st_mode & 0o777, 0o700)
        self.assertEqual(os.stat(termhost.sock_path(self.rd)).st_mode & 0o777, 0o600)
        h = self.hello()
        self.assertEqual((h["v"], h["pid"], h["terms"]), (termhost.PROTOCOL, p.pid, 0))
        second = self.host()
        self.assertEqual(second.wait(5), 0)  # the folder's lock is taken: a second host leaves at once
        self.assertEqual(self.hello()["pid"], p.pid)
        s = termhost.connect(self.rd)
        termhost.send(s, {"op": "list", "v": termhost.PROTOCOL + 1})
        self.assertEqual(next(termhost.lines(s)), {"error": "protocol", "v": termhost.PROTOCOL})
        s.close()
        with self.assertRaises(termhost.HostError) as e:
            _call_as(self.rd, termhost.PROTOCOL + 1)
        self.assertIn("stop-terminals", str(e.exception))
        self.assertEqual(termhost.call(self.rd, {"op": "stop"}, version=False), {"ok": True, "ended": 0})
        self.assertEqual(p.wait(5), 0)
        self.assertFalse(os.path.exists(termhost.sock_path(self.rd)))

    def test_open_folder_is_refused(self):
        p = self.host()
        self.assertTrue(wait_until(self.hello))
        os.chmod(self.rd, 0o755)
        with self.assertRaises(termhost.HostError):
            termhost.connect(self.rd)
        os.chmod(self.rd, 0o700)
        termhost.call(self.rd, {"op": "stop"}, version=False)
        p.wait(5)

    def test_idle_host_exits(self):
        p = self.host(idle="1")
        self.assertTrue(wait_until(self.hello))
        self.assertEqual(p.wait(10), 0)

    def test_log_rotates_only_under_the_host_lock(self):
        termhost.private_dir(self.rd)
        log = os.path.join(self.rd, termhost.LOG)
        with open(log, "wb") as fh:
            fh.write(b"x" * (termhost.LOG_MAX + 100))
        lock = os.open(os.path.join(self.rd, termhost.LOCK), os.O_RDWR | os.O_CREAT, 0o600)
        try:
            fcntl.flock(lock, fcntl.LOCK_EX)  # another host owns the folder
            with mock.patch.dict(terms._host, proc=None):
                terms._spawn(self.rd)  # what a second server does at the same moment
                self.procs.append(terms._host["proc"])
                self.assertEqual(terms._host["proc"].wait(15), 0)
            self.assertFalse(os.path.exists(log + ".1"), "a host without the lock rotated the log")
        finally:
            os.close(lock)
        with mock.patch.dict(terms._host, proc=None):
            terms._spawn(self.rd)
            self.procs.append(terms._host["proc"])
        self.assertTrue(wait_until(self.hello, timeout=15))
        self.assertEqual(os.path.getsize(log + ".1"), termhost.LOG_MAX + 100)
        with open(log) as fh:
            self.assertIn("terminal host", fh.read())
        termhost.call(self.rd, {"op": "stop"}, version=False)

    def test_stale_socket_is_replaced(self):
        termhost.private_dir(self.rd)
        stale = socket.socket(socket.AF_UNIX)
        stale.bind(termhost.sock_path(self.rd, create=True))
        stale.close()  # a socket file nobody listens on, as a killed host leaves behind
        self.host()
        self.assertTrue(wait_until(self.hello))
        termhost.call(self.rd, {"op": "stop"}, version=False)


def _call_as(rd, version):
    """A versioned call made as if this side spoke another protocol."""
    saved = termhost.PROTOCOL
    termhost.PROTOCOL = version
    try:
        return termhost.call(rd, {"op": "list"})
    finally:
        termhost.PROTOCOL = saved


if __name__ == "__main__":
    unittest.main()

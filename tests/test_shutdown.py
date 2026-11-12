"""A plain SIGTERM stops `python3 server.py` cleanly; with DESK_TERMHOST=0 it also ends the CLIs of page terminals."""
import http.client
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import unittest

from helpers import FIXTURE, ROOT

SID = "abcdef12-0000-4000-8000-000000000001"
FAKE_CLI = """#!{python}
import os, signal, sys, time
signal.signal(signal.SIGHUP, signal.SIG_IGN)  # a CLI that ignores the hang-up must still be ended
with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "cli.pid"), "w") as fh:
    fh.write(str(os.getpid()))
print("fake cli ready", flush=True)
time.sleep(60)
"""


class ShutdownTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="desk-stop-")
        self.home = os.path.join(self.tmp, "claude")
        shutil.copytree(FIXTURE, self.home)
        os.makedirs(os.path.join(self.home, "sessions"))
        project = os.path.join(self.home, "projects", "-tmp-work")
        os.makedirs(project)
        rec = {"type": "user", "uuid": "u1", "parentUuid": None, "isSidechain": False, "timestamp": "2026-01-01T00:00:00Z", "entrypoint": "cli",
               "cwd": self.tmp, "message": {"role": "user", "content": "hello"}}
        with open(os.path.join(project, SID + ".jsonl"), "w") as fh:
            fh.write(json.dumps(rec) + "\n")
        self.cli = os.path.join(self.tmp, "fake-cli")
        with open(self.cli, "w") as fh:
            fh.write(FAKE_CLI.format(python=sys.executable))
        os.chmod(self.cli, 0o755)
        for i in range(300):  # enough lines that the stats worker is still counting at SIGTERM
            with open(os.path.join(project, f"abcdef12-0000-4000-8000-{i + 100:012d}.jsonl"), "w") as fh:
                fh.write('{"type":"user","n":1}\n' * 3000)
        env = dict(os.environ, PORT="0", DESK_CLAUDE_DIR=self.home, DESK_CLAUDE_BIN=self.cli, DESK_STATE_DIR=self.tmp, DESK_TERMHOST="0")
        self.proc = subprocess.Popen([sys.executable, os.path.join(ROOT, "server.py")], cwd=self.tmp, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        self.port = int(re.search(r"127\.0\.0\.1:(\d+)", self.proc.stdout.readline()).group(1))

    def tearDown(self):
        if self.proc.poll() is None:
            self.proc.kill()
            self.proc.wait()
        self.proc.stdout.close()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def call(self, method, path, body=None, headers=None):
        """One request to the subprocess server."""
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        h = {"Host": f"127.0.0.1:{self.port}"}
        h.update(headers or {})
        conn.request(method, path, body=json.dumps(body).encode() if body else None, headers=h)
        r = conn.getresponse()
        out = r.status, r.read()
        conn.close()
        return out

    def test_sigterm_ends_page_terminals(self):
        _, page = self.call("GET", "/")
        token = re.search(rb'DESK_TOKEN="([^"]+)"', page).group(1).decode()
        status, out = self.call("POST", "/api/term/open", {"id": SID, "cols": 80, "rows": 24},
                                {"Origin": f"http://127.0.0.1:{self.port}", "X-Desk-Token": token, "Content-Type": "application/json"})
        self.assertEqual((status, json.loads(out)), (200, {"ok": True, "restarted": False}))
        pidfile = os.path.join(self.tmp, "cli.pid")
        pid = 0
        for _ in range(100):
            if os.path.exists(pidfile):
                with open(pidfile) as fh:
                    pid = int(fh.read() or 0)
            if pid:
                break
            time.sleep(0.05)
        self.assertTrue(pid)
        self.assertEqual(json.loads(self.call("GET", "/api/health")[1])["terms"], 1)
        self.proc.send_signal(signal.SIGTERM)
        self.assertEqual(self.proc.wait(timeout=15), 0)
        self.assertIn("stopped", self.proc.stdout.read())
        for _ in range(60):
            try:
                os.kill(pid, 0)
            except ProcessLookupError:
                break
            time.sleep(0.05)
        else:
            self.fail("page terminal CLI still running after SIGTERM")


    def test_sigterm_ends_the_stats_worker_and_leaves_no_temp_files(self):
        self.assertEqual(self.call("GET", "/api/stats")[0], 200)
        kids = []
        for _ in range(100):
            kids = subprocess.run(["pgrep", "-P", str(self.proc.pid)], capture_output=True, text=True).stdout.split()
            if kids:
                break
            time.sleep(0.05)
        self.assertTrue(kids, "no stats worker started")
        self.proc.send_signal(signal.SIGTERM)
        self.assertEqual(self.proc.wait(timeout=15), 0)
        for pid in kids:
            for _ in range(60):
                try:
                    os.kill(int(pid), 0)
                except ProcessLookupError:
                    break
                time.sleep(0.05)
            else:
                self.fail("stats worker still running after SIGTERM")
        self.assertEqual([n for n in os.listdir(self.tmp) if n.endswith(".tmp")], [])


if __name__ == "__main__":
    unittest.main()

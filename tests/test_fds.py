"""Descriptor budget under load: 6 terminals, 16 terminal streams, 8 change listeners, the stats worker, kernel watches and a burst of 200
requests, at the usual limit and with RLIMIT_NOFILE lowered to 256 in the server process; the server degrades (fewer watches), never refuses."""
import http.client
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
import unittest

from helpers import ROOT, wait_until
from desk import watch
from test_termhost import ECHO_CLI

sys.path.insert(0, os.path.join(ROOT, "tools"))
import bench_home  # noqa: E402

try:
    import resource
except ImportError:
    resource = None

TERMS, STREAMS, LISTENERS, BURST = 6, 16, 8, 200


def limit(n):
    """A preexec function that lowers the child's descriptor limit to n."""
    return lambda: resource.setrlimit(resource.RLIMIT_NOFILE, (n, n))


class Load:
    """A synthetic data folder (450 transcripts plus TERMS sessions whose folder exists), a stub CLI and one server process."""

    def __init__(self, nofile=None):
        self.tmp = tempfile.mkdtemp(prefix="desk-fds-")
        self.home = os.path.join(self.tmp, "claude")
        bench_home.build(self.home, 450, 0, 0, subagents=0, live=0)
        proj = os.path.join(self.home, "projects", "-tmp-fds")
        os.makedirs(proj)
        self.sids = [f"abcdef12-0000-4000-8000-{i:012d}" for i in range(TERMS)]
        for sid in self.sids:
            bench_home.transcript(os.path.join(proj, sid + ".jsonl"), self.tmp, time.time() - 60, 2, 100)
        self.cli = os.path.join(self.tmp, "echo-cli")
        with open(self.cli, "w") as fh:
            fh.write(ECHO_CLI.format(python=sys.executable))
        os.chmod(self.cli, 0o755)
        self.env = dict(os.environ, DESK_CLAUDE_DIR=self.home, DESK_CLAUDE_BIN=self.cli, DESK_STATE_DIR=self.tmp, PORT="0", DESK_WATCH="1")
        self.env.pop("DESK_TERMHOST", None)
        self.proc = subprocess.Popen([sys.executable, os.path.join(ROOT, "server.py")], cwd=self.tmp, env=self.env, stdout=subprocess.PIPE,
                                     stderr=subprocess.STDOUT, text=True, preexec_fn=limit(nofile) if nofile else None)
        self.port = int(re.search(r"127\.0\.0\.1:(\d+)", self.proc.stdout.readline()).group(1))
        status, page = self.call("GET", "/")
        self.token = re.search(rb'DESK_TOKEN="([^"]+)"', page).group(1).decode()
        self.held = []

    def call(self, method, path, body=None, timeout=30):
        """One request; returns (status, body bytes)."""
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=timeout)
        h = {"Host": f"127.0.0.1:{self.port}"}
        if method == "POST":
            h.update({"Origin": f"http://127.0.0.1:{self.port}", "X-Desk-Token": getattr(self, "token", ""), "Content-Type": "application/json"})
        conn.request(method, path, body=json.dumps(body).encode() if body else None, headers=h)
        r = conn.getresponse()
        out = r.status, r.read()
        conn.close()
        return out

    def hold(self, path):
        """Open a long-lived stream and keep it; returns its status."""
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=30)
        conn.request("GET", path, headers={"Host": f"127.0.0.1:{self.port}"})
        r = conn.getresponse()
        self.held.append((conn, r))  # the response holds the socket open
        return r.status

    def fds(self):
        """The server's health `fds`."""
        return json.loads(self.call("GET", "/api/health")[1])["fds"]

    def close(self):
        """Drop streams, stop the server, its terminals and host, delete the folder; returns processes that had to be killed."""
        for c, r in self.held:
            r.close()
            c.close()
        self.proc.send_signal(signal.SIGTERM)
        self.proc.wait(20)
        self.proc.stdout.close()
        subprocess.run([sys.executable, os.path.join(ROOT, "server.py"), "stop-terminals"], env=self.env, capture_output=True, timeout=30)
        out = subprocess.run(["pgrep", "-f", self.tmp], capture_output=True, text=True).stdout.split()
        left = [int(p) for p in out if int(p) != os.getpid()]
        for pid in left:
            os.kill(pid, signal.SIGKILL)
        shutil.rmtree(self.tmp, ignore_errors=True)
        return left


@unittest.skipIf(resource is None, "no resource module")
class BudgetTest(unittest.TestCase):
    def run_load(self, nofile):
        """Drive the full load against one server; returns the budget row."""
        load = Load(nofile)
        try:
            for sid in load.sids:
                status, body = load.call("POST", "/api/term/open", {"id": sid, "cols": 80, "rows": 24})
                self.assertEqual(status, 200, body)
            for i in range(STREAMS):
                self.assertEqual(load.hold(f"/api/term/stream?id={load.sids[i % TERMS]}"), 200)
            for _ in range(LISTENERS):
                self.assertEqual(load.hold("/api/events"), 200)
            self.assertEqual(load.call("GET", "/api/stats")[0], 200)  # starts the stats worker
            wait_until(lambda: load.fds()["watches"] > 0, timeout=10)
            time.sleep(1.5)
            settled = load.fds()
            peak, results, gate = [settled["open"]], [], threading.Barrier(BURST)
            paths = ["/api/sessions", f"/api/session?id={load.sids[0]}", "/api/health", f"/api/sessions?ids={','.join(load.sids)}"]

            def one(i):
                """One request of the burst."""
                gate.wait()
                try:
                    status, body = load.call("GET", paths[i % len(paths)], timeout=60)
                    results.append(status)
                    if paths[i % len(paths)] == "/api/health":
                        peak.append(json.loads(body)["fds"]["open"])
                except OSError as e:
                    results.append(type(e).__name__)
            threads = [threading.Thread(target=one, args=(i,)) for i in range(BURST)]
            for t in threads:
                t.start()
            for t in threads:
                t.join(120)
            self.assertEqual([r for r in results if r != 200], [], "requests refused or failed")
            self.assertEqual(len(results), BURST)
            after = load.fds()
            row = {"limit": settled["limit"], "watches": settled["watches"], "settled": settled["open"], "peak": max(peak), "after": after["open"]}
            self.assertLess(row["peak"], row["limit"])
            return row
        finally:
            self.assertEqual(load.close(), [], "processes left behind")

    def test_default_limit(self):
        row = self.run_load(None)
        print(f"\nfds default: {row}", file=sys.stderr)
        self.assertLessEqual(row["watches"], watch.budget(row["limit"]))

    def test_low_limit_degrades(self):
        row = self.run_load(256)
        print(f"\nfds 256: {row}", file=sys.stderr)
        self.assertEqual(row["limit"], 256)
        self.assertLessEqual(row["watches"], (256 - 160) // 2)


if __name__ == "__main__":
    unittest.main()

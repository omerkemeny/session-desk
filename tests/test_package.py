"""The zip a new person gets: builds, holds only what runs the app, and starts as a fresh user on the oldest supported Python."""
import http.client
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
import zipfile

from helpers import FIXTURE, ROOT

OLDEST = "/usr/bin/python3" if os.path.exists("/usr/bin/python3") else sys.executable  # 3.9 on macOS


def call(port, method, path, host=None, headers=None):
    """One request to the unpacked server; returns the status."""
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
    conn.request(method, path, body=b"{}" if method == "POST" else None, headers=dict({"Host": host or f"127.0.0.1:{port}"}, **(headers or {})))
    status = conn.getresponse().status
    conn.close()
    return status


class PackageTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="dpk-", dir="/tmp" if os.path.isdir("/tmp") else None)
        self.zip = os.path.join(self.tmp, "out", "session-desk.zip")
        r = subprocess.run([sys.executable, os.path.join(ROOT, "tools", "make_zip.py"), "--out", self.zip], capture_output=True, text=True, timeout=60)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.app = os.path.join(self.tmp, "u", "session-desk")
        with zipfile.ZipFile(self.zip) as z:
            self.names = z.namelist()
            z.extractall(os.path.join(self.tmp, "u"))
        os.chmod(os.path.join(self.app, "server.py"), 0o755)
        self.home = os.path.join(self.tmp, "home")
        os.makedirs(self.home)
        data = os.path.join(self.tmp, "data")
        shutil.copytree(FIXTURE, data)
        stub = os.path.join(self.tmp, "stub-cli")
        with open(stub, "w") as fh:
            fh.write("#!/bin/sh\nexit 0\n")
        os.chmod(stub, 0o755)
        self.env = {"PATH": "/usr/bin:/bin", "HOME": self.home, "LANG": "C.UTF-8", "TMPDIR": os.path.join(self.tmp, "t") + "/", "PORT": "0",
                    "DESK_CLAUDE_DIR": data, "DESK_CLAUDE_BIN": stub}
        os.makedirs(self.env["TMPDIR"])

    def tearDown(self):
        self.ctl("stop")
        self.ctl("stop-terminals")
        left = subprocess.run(["pgrep", "-f", self.tmp], capture_output=True, text=True).stdout.split()
        for pid in left:
            subprocess.run(["kill", "-9", pid])
        shutil.rmtree(self.tmp, ignore_errors=True)
        self.assertEqual(left, [], "processes left after stop")

    def ctl(self, verb):
        """Run a verb of the unpacked app with the oldest Python; returns (exit code, output)."""
        r = subprocess.run([OLDEST, "server.py", verb], cwd=self.app, env=self.env, capture_output=True, text=True, timeout=60)
        return r.returncode, r.stdout + r.stderr

    def test_zip_contents(self):
        top = {n.split("/")[1] for n in self.names}
        self.assertEqual(top - {"docs", "README.md"}, {"server.py", "desk", "web"})
        for n in self.names:
            self.assertTrue(n.startswith("session-desk/"), n)
            parts = n.split("/")
            self.assertFalse(any(p.startswith(".") or p in ("tests", "__pycache__", "node_modules") for p in parts), n)
            self.assertFalse(n.endswith((".pyc", ".tmp", ".log")), n)
        for mod in ("desk/termhost.py", "desk/ctl.py", "desk/durable.py", "desk/web.py"):
            self.assertIn("session-desk/" + mod, self.names)
        with zipfile.ZipFile(self.zip) as z:
            text = b"".join(z.read(n) for n in self.names)
        self.assertEqual(len(re.findall(rb"/Users/|/home/[a-z]", text)), 0)
        self.assertNotIn(os.path.expanduser("~").encode(), text)

    def test_no_pictures_form(self):
        small = os.path.join(self.tmp, "out", "small.zip")
        r = subprocess.run([sys.executable, os.path.join(ROOT, "tools", "make_zip.py"), "--out", small, "--no-pictures"], capture_output=True, text=True, timeout=60)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertTrue(any("/docs/img/" in n for n in self.names), "the default zip ships the pictures")
        with zipfile.ZipFile(small) as z:
            names = z.namelist()
            self.assertEqual([n for n in names if "/docs/img/" in n], [])
            self.assertEqual(set(names), {n for n in self.names if "/docs/img/" not in n})
            for n in (n for n in names if n.endswith(".md")):
                text = z.read(n).decode()
                self.assertNotRegex(text, r"!\[[^\]]*\]\(", n)
                self.assertNotIn("img/", text, n)
            self.assertIn("*Picture, not in this download: The demo page by day", z.read("session-desk/README.md").decode())
        self.assertLess(os.path.getsize(small), os.path.getsize(self.zip) - 200_000)

    def test_fresh_user_runs_it(self):
        code, out = self.ctl("start")
        self.assertEqual(code, 0, out)
        port = int(re.search(r"http://127\.0\.0\.1:(\d+)", out).group(1))  # the server picked a free port
        for path in ("/", "/api/sessions", "/api/stats", "/api/health"):
            self.assertEqual(call(port, "GET", path), 200, path)
        self.assertEqual(call(port, "GET", "/api/sessions", host="evil.example"), 403)
        self.assertEqual(call(port, "POST", "/api/term/close", headers={"Origin": f"http://127.0.0.1:{port}", "Content-Type": "application/json"}), 403)
        self.assertEqual(self.ctl("status")[0], 0)
        code, out = self.ctl("stop")
        self.assertEqual(code, 0, out)
        self.assertIn("stopped pid", out)
        python_cache = os.path.join(self.home, "Library", "Caches", "com.apple.python")  # Apple's Python caches its own bytecode there
        written = [os.path.join(b, n) for b, _, ns in os.walk(self.home) for n in ns if not os.path.join(b, n).startswith(python_cache)]
        self.assertEqual(written, [], "files written under the user's home")


if __name__ == "__main__":
    unittest.main()

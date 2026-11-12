"""Hot reload on a private copy of the package: edits take effect, terminals survive, broken code keeps the old code serving."""
import importlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest

from helpers import ROOT, S1, FakeHome, FakeTerm, Served, open_events, read_event, wait_until
from desk import reloader

# Two same-size edits inside one second, with bytecode writing on: a .pyc keyed on whole seconds and size must not serve the first edit.
BYTECODE_SCRIPT = r"""
import importlib.util, json, os, shutil, sys, time
src_pkg, tmp = sys.argv[1], sys.argv[2]
shutil.copytree(src_pkg, os.path.join(tmp, "deskpyc"), ignore=shutil.ignore_patterns("__pycache__"))
sys.path.insert(0, tmp)
import deskpyc.app
from deskpyc import reloader, sessions
f = os.path.join(tmp, "deskpyc", "sessions.py")
with open(f) as fh:
    src = fh.read()
reloader.init()
def write(v, t):
    with open(f, "w") as fh:
        fh.write(src.replace("RECENT = 60", "RECENT = %d" % v))
    os.utime(f, ns=(t, t))
base = (int(time.time()) + 5) * 10**9
seen = []
write(61, base + 100)
reloader.check(force=True)
seen.append(sessions.RECENT)
write(62, base + 900_000_000)
reloader.check(force=True)
seen.append(sessions.RECENT)
print(json.dumps({"seen": seen, "bytecode": not sys.dont_write_bytecode, "error": reloader.status()["error"],
                  "pyc": os.path.exists(importlib.util.cache_from_source(os.path.join(tmp, "deskpyc", "app.py")))}))
"""


class BytecodeTest(unittest.TestCase):
    def test_same_size_edits_within_one_second(self):
        tmp = tempfile.mkdtemp(prefix="desk-pyc-")
        try:
            env = {k: v for k, v in os.environ.items() if k != "PYTHONDONTWRITEBYTECODE"}
            out = subprocess.run([sys.executable, "-c", BYTECODE_SCRIPT, os.path.join(ROOT, "desk"), tmp], env=env, capture_output=True, text=True, timeout=60)
            self.assertEqual(out.returncode, 0, out.stderr[-500:])
            res = json.loads(out.stdout.strip().splitlines()[-1])
            self.assertEqual((res["bytecode"], res["pyc"]), (True, True))
            self.assertEqual((res["seen"], res["error"]), ([61, 62], None))
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


class RestoreTest(unittest.TestCase):
    def test_rollback_never_empties_the_namespace(self):
        class NoClear(dict):
            def clear(self):
                raise AssertionError("namespace emptied")

        ns = NoClear(a=1, b=2)
        saved = dict(ns)
        ns.update(b=3, c=4)
        reloader._restore(ns, saved)
        self.assertEqual(dict(ns), {"a": 1, "b": 2})

    def test_dependency_order(self):
        src = {"web": b"from . import util, events\nfrom .sessions import x", "events": b"from . import sessions, terms",
               "sessions": b"def f():\n    from . import transcripts", "transcripts": b"from . import config", "util": b"X = 1"}
        seq = reloader.order(src)
        for a, b in (("transcripts", "sessions"), ("sessions", "events"), ("events", "web"), ("util", "web")):
            self.assertLess(seq.index(a), seq.index(b))


class ReloadTest(unittest.TestCase):
    def setUp(self):
        self.home = FakeHome()
        self.tmp = tempfile.mkdtemp(prefix="desk-reload-")
        self.pkg = os.path.join(self.tmp, "deskhot")
        shutil.copytree(os.path.join(ROOT, "desk"), self.pkg, ignore=shutil.ignore_patterns("__pycache__"))
        sys.path.insert(0, self.tmp)
        self.app = importlib.import_module("deskhot.app")
        self.mods = {n: sys.modules["deskhot." + n] for n in ("config", "terms", "web", "stats", "sessions", "reloader")}
        cfg = self.mods["config"]
        cfg.HOME, cfg.STATS_FILE, cfg.WEB, cfg.HERE = self.home.home, os.path.join(self.home.tmp, "s.json"), os.path.join(self.home.tmp, "web"), ROOT
        self.srv = Served(self.app)

    def tearDown(self):
        self.srv.close()
        sys.path.remove(self.tmp)
        for name in [n for n in sys.modules if n == "deskhot" or n.startswith("deskhot.")]:
            del sys.modules[name]
        shutil.rmtree(self.tmp, ignore_errors=True)
        self.home.close()

    def edit(self, name, old, new):
        """Change one module of the copy and move its time forward so the change is seen."""
        path = os.path.join(self.pkg, name + ".py")
        with open(path) as fh:
            src = fh.read()
        self.assertIn(old, src)
        with open(path, "w") as fh:
            fh.write(src.replace(old, new, 1))
        t = time.time() + 2
        os.utime(path, (t, t))
        time.sleep(1.1)  # changes are looked for at most once a second

    def health(self):
        """Current health answer."""
        status, h = self.srv.json("/api/health")
        self.assertEqual(status, 200)
        return h

    def test_reload_keeps_terminals_and_survives_errors(self):
        terms = self.mods["terms"]
        terms._terms["feedfeed-0000"] = FakeTerm(os.getpid(), 0)
        self.assertEqual(self.health()["terms"], 1)

        self.edit("web", '"formatChecked": checked}', '"formatChecked": checked, "probe": 1}')
        h = self.health()
        self.assertEqual((h.get("probe"), h["reloads"], h["terms"], h["reloadError"]), (1, 1, 1, None))
        self.assertIs(sys.modules["deskhot.terms"], terms)

        self.edit("sessions", "def brief(", "def broken(:\n    pass\n\n\ndef brief(")
        h = self.health()
        self.assertIn("sessions.py", h["reloadError"])
        self.assertIn("SyntaxError", h["reloadError"])
        self.assertIs(h["ok"], False)
        self.assertEqual((h.get("probe"), h["reloads"], h["terms"]), (1, 1, 1))
        self.assertEqual(self.srv.request("GET", "/api/sessions")[0], 200)

        self.edit("sessions", "def broken(:\n    pass\n\n\ndef brief(", "def brief(")
        self.edit("stats", "def _hid(", 'ADDED_BY_FAILED = 1\nraise RuntimeError("boom at import")\n\n\ndef _hid(')
        h = self.health()
        self.assertIn("stats.py", h["reloadError"])
        self.assertIn("boom at import", h["reloadError"])
        self.assertEqual(self.srv.request("GET", "/api/sessions")[0], 200)
        self.assertEqual(self.srv.request("GET", "/api/stats")[0], 200)  # old code put back
        self.assertFalse(hasattr(self.mods["stats"], "ADDED_BY_FAILED"))

        self.edit("stats", 'ADDED_BY_FAILED = 1\nraise RuntimeError("boom at import")\n\n\n', "")
        h = self.health()
        self.assertEqual((h["reloadError"], h["reloads"], h["terms"], h.get("probe")), (None, 2, 1, 1))

        self.edit("terms", "MAX_TERMS = 6", "MAX_TERMS = 7")
        h = self.health()
        self.assertEqual(h["restartNeeded"], ["terms.py"])
        self.assertEqual(terms.MAX_TERMS, 6)  # state module is never reloaded

    def test_new_module_is_found_and_reloaded(self):
        util = os.path.join(self.pkg, "util.py")
        with open(util, "w") as fh:
            fh.write("VALUE = 1\n")
        self.edit("web", '"formatChecked": checked}', '"formatChecked": checked, "util": util.VALUE}')
        self.edit("web", "from . import config,", "from . import util\nfrom . import config,")
        self.assertEqual(self.health().get("util"), 1)
        with open(util, "w") as fh:
            fh.write("VALUE = 2\n")
        t = time.time() + 3
        os.utime(util, (t, t))
        time.sleep(1.1)
        h = self.health()
        self.assertEqual((h.get("util"), h["reloadError"]), (2, None))
        self.edit("config", "PORT = ", "PORT  = ")
        self.assertEqual(self.health()["restartNeeded"], ["config.py"])

    def test_change_feed_survives_an_events_reload(self):
        conn, resp = open_events(self.srv.port)
        try:
            self.assertEqual(resp.status, 200)
            n = int(read_event(resp)[2].split(": ")[1])
            self.edit("events", "INTERVAL = 1.0", "INTERVAL = 0.5")
            h = self.health()
            self.assertEqual((h["reloads"], h["reloadError"], h["events"]["running"], h["events"]["clients"]), (1, None, True, 1))
            self.assertEqual(sys.modules["deskhot.events"].INTERVAL, 0.5)
            with open(self.home.path(S1), "a") as fh:
                fh.write('{"type":"custom-title","customTitle":"After reload","sessionId":"x"}\n')
            self.assertEqual(read_event(resp), ["event: change", f"data: {n + 1}"])
        finally:
            resp.close()
            conn.close()
        self.assertTrue(wait_until(lambda: self.health()["events"]["clients"] == 0 and not self.health()["events"]["running"], timeout=6))


if __name__ == "__main__":
    unittest.main()

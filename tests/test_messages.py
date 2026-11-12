"""One sentence per setup state: every state walked through every place that speaks about it (start line, start, restart, status, doctor,
health, terminal open, quick reply), each line equal to the table's lead-in plus its core sentence."""
import http.client
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest

from helpers import FIXTURE, ROOT, S1
from desk import messages

SERVER = os.path.join(ROOT, "server.py")
STATES = ("dataMissing", "dataUnreadable", "noSessions", "readOnly", "cliMissing", "cliBroken")


def call(port, method, path, body=None, token=""):
    """One request to a test server; (status, body bytes)."""
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=20)
    h = {"Host": f"127.0.0.1:{port}", "Origin": f"http://127.0.0.1:{port}", "X-Desk-Token": token, "Content-Type": "application/json"}
    conn.request(method, path, json.dumps(body) if body is not None else None, h)
    r = conn.getresponse()
    out = r.status, r.read()
    conn.close()
    return out


class SentenceWalkTest(unittest.TestCase):
    """Each place prints the table's line for each state it meets; the core words are the same everywhere."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="desk-msg-")
        self.procs = []

    def tearDown(self):
        for p in self.procs:
            if p.poll() is None:
                p.terminate()
                p.wait(15)
            p.stdout.close()
        for d, _, _ in os.walk(self.tmp):
            os.chmod(d, 0o700)
        shutil.rmtree(self.tmp, ignore_errors=True)

    def world(self, state):
        """A temp HOME, data folder, state folder and CLI path that put the app in one setup state; returns (env, fill values)."""
        base = os.path.join(self.tmp, state)
        home, data, st = os.path.join(base, "home"), os.path.join(base, "data"), os.path.join(base, "state")
        os.makedirs(home)
        os.makedirs(st)
        cli = os.path.join(base, "claude")
        with open(cli, "w") as fh:
            fh.write("#!/bin/sh\nexit 0\n")
        os.chmod(cli, 0o755)
        if state in ("readOnly", "cliMissing", "cliBroken"):
            shutil.copytree(FIXTURE, data)
        elif state in ("dataUnreadable", "noSessions"):
            os.makedirs(data)
        if state == "dataUnreadable":
            os.chmod(data, 0)
        if state == "readOnly":
            os.chmod(st, stat.S_IRUSR | stat.S_IXUSR)
        if state == "cliMissing":
            cli = os.path.join(base, "no-such-claude")
        if state == "cliBroken":
            os.chmod(cli, 0o644)
        env = {"HOME": home, "PATH": "/usr/bin:/bin", "PORT": "0", "DESK_CLAUDE_DIR": data, "DESK_STATE_DIR": st, "DESK_CLAUDE_BIN": cli}
        return env, {"home": data, "dir": st, "cli": cli}

    def verb(self, env, *argv):
        """Run a verb; its output lines."""
        r = subprocess.run([sys.executable, SERVER, *argv], env=env, cwd=self.tmp, capture_output=True, text=True, timeout=60)
        self.assertNotIn("Traceback", r.stdout + r.stderr)
        return (r.stdout + r.stderr).splitlines()

    def check(self, place, state, line, fill=None):
        """A printed line is the table's line for this place and state, and holds the state's core words."""
        want = messages.say(place, state, **(fill or {}))
        self.assertEqual(line.strip(), want, f"{place} / {state}")
        self.assertIn(messages.stem(state), line)

    def test_every_state_through_every_place(self):
        for state in STATES:
            with self.subTest(state=state):
                self.walk(state)

    def walk(self, state):
        """Foreground server (start line, health, terminal open, quick reply, status, doctor), then start and restart."""
        env, fill = self.world(state)
        places = {p for p in messages.LEAD if state in messages.LEAD[p]}
        p = subprocess.Popen([sys.executable, SERVER], env=env, cwd=self.tmp, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        self.procs.append(p)
        port = int(re.search(r"127\.0\.0\.1:(\d+)", p.stdout.readline()).group(1))
        self.check("startLine", state, p.stdout.readline())
        h = json.loads(call(port, "GET", "/api/health")[1])
        self.check("health", state, h["setup"]["hint"])
        token = re.search(rb'DESK_TOKEN="([^"]+)"', call(port, "GET", "/")[1]).group(1).decode()
        for place, route, body in (("termOpen", "/api/term/open", {"id": S1, "cols": 80, "rows": 24}), ("reply", "/api/reply", {"id": S1, "text": "hi"})):
            if place in places:
                code, out = call(port, "POST", route, body, token)
                self.assertEqual(code, 409, out)
                self.check(place, state, json.loads(out)["error"])
        self.check("status", state, [ln for ln in self.verb(env, "status") if ln.startswith("  ")][-1])
        doc = self.verb(env, "doctor")
        self.check("doctor", state, re.sub(r"^ +first +", "", [ln for ln in doc if re.match(r" +first ", ln)][0]))
        if "doctorCheck" in places:
            name = {"readOnly": "state folder", "cliMissing": "cli", "cliBroken": "cli"}.get(state, "data folder")
            row = [ln for ln in doc if re.match(rf"(ok|warn|FAIL) +{name} ", ln)][0]
            self.check("doctorCheck", state, re.sub(rf"^(ok|warn|FAIL) +{name} +", "", row), fill)
        p.terminate()
        p.wait(15)
        for verb in ("start", "restart"):
            out = self.verb(env, verb)
            line = out[0] if state == "readOnly" else [ln for ln in out if ln.startswith("  ") and "preparing" not in ln][-1]
            self.check(verb, state, line)
        if state != "readOnly":
            self.verb(env, "stop")

    def test_table_covers_every_state_and_keeps_the_page_hints(self):
        self.assertEqual(set(messages.CORE), set(STATES))
        self.assertEqual(messages.CORE["readOnly"], "This folder is read-only: start with DESK_STATE_DIR=<a folder you can write>.")
        self.assertEqual(messages.CORE["cliMissing"], "The `claude` command was not found: install Claude Code or set DESK_CLAUDE_BIN.")
        for state, place, line in messages.table():
            self.assertIn(messages.stem(state), line, (state, place))
            self.assertNotIn("reload", messages.sentence(place, state) if place.startswith("doctor") else "", (state, place))


class WarmingTest(unittest.TestCase):
    """health `setup.warming` is true until the first list was built once, with a slow list as stand-in; `start` says so."""

    def test_warming_until_the_first_list(self):
        import threading
        import time
        from unittest import mock
        from helpers import FakeHome
        from desk import ctl, sessions, web
        home = FakeHome()
        real, gate = sessions.sessions, threading.Event()

        def slow(*a, **kw):
            """The real list after the test lets it go."""
            gate.wait(10)
            return real(*a, **kw)
        try:
            web._listed["done"] = False
            with mock.patch.object(sessions, "sessions", slow):
                t = threading.Thread(target=web.warm)
                t.start()
                time.sleep(0.1)
                self.assertIs(web.health()["setup"]["warming"], True)
                gate.set()
                t.join(10)
            self.assertIs(web.health()["setup"]["warming"], False)
        finally:
            gate.set()
            home.close()
        self.assertIn("preparing the session list", ctl.WARMING)

    def test_start_prints_the_warming_line(self):
        from unittest import mock
        from desk import ctl
        import contextlib
        import io

        class Proc:
            pid, returncode = 4242, None

            def poll(self):
                return None
        tmp = tempfile.mkdtemp(prefix="desk-warm-")
        try:
            with mock.patch.object(ctl, "running", return_value=None), mock.patch.object(ctl, "_path", lambda n: os.path.join(tmp, n)), \
                    mock.patch.object(ctl.subprocess, "Popen", return_value=Proc()), \
                    mock.patch.object(ctl, "read_pid", return_value={"pid": 4242, "port": 1234}), \
                    mock.patch.object(ctl, "health", return_value={"setup": {"warming": True, "hint": ""}}):
                out = io.StringIO()
                with contextlib.redirect_stdout(out):
                    self.assertEqual(ctl.start(0), 0)
            self.assertEqual(out.getvalue().splitlines()[1], "  " + ctl.WARMING)
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()

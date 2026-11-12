"""The terminal host boundary under hostile input: bad JSON lines, wrong types, huge numbers, silent peers, peer checks, inherited descriptors, stale offsets."""
import base64
import hashlib
import json
import os
import shutil
import signal
import socket
import stat
import sys
import tempfile
import subprocess
import threading
import time
import unittest
from unittest import mock

from helpers import ROOT, wait_until
from desk import termhost

FDS = """import os, sys
fds = []
for fd in range(3, 256):
    try:
        os.fstat(fd)
        fds.append(fd)
    except OSError:
        pass
open(sys.argv[1], "w").write("fds: " + " ".join(map(str, fds)))
"""
LEAVER = """import os, signal, sys, time
if os.fork() == 0:
    signal.signal(signal.SIGHUP, signal.SIG_IGN)
    open(sys.argv[1] + ".tmp", "w").write(str(os.getpid()))
    os.rename(sys.argv[1] + ".tmp", sys.argv[1])
    time.sleep(30)
    os._exit(0)
while not os.path.exists(sys.argv[1]):
    time.sleep(0.01)
print("parent done", flush=True)
sys.exit(3)
"""


class HostBoundaryTest(unittest.TestCase):
    """An in-process host on a private socket, so limits can be patched and CLIs are plain commands."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="desk-bd-")
        self.rd = termhost.private_dir(os.path.join(self.tmp, "run"))
        self.host = mock.patch.object(termhost, "HOST", termhost.Host())
        self.host.start()
        self.srv = termhost.Server(termhost.sock_path(self.rd, create=True), termhost.Handler)
        os.chmod(termhost.sock_path(self.rd), 0o600)
        threading.Thread(target=self.srv.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True).start()

    def tearDown(self):
        termhost.HOST.end_all(1)
        self.srv.shutdown()
        self.srv.server_close()
        termhost.drop_sock(self.rd, termhost.sock_path(self.rd))
        self.host.stop()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def raw(self, line, timeout=5):
        """Send raw bytes as one request; returns the first answer line decoded, or None when the host closed without one."""
        s = termhost.connect(self.rd, timeout)
        try:
            try:
                s.sendall(line)
            except (BrokenPipeError, ConnectionResetError):
                pass  # the host answered and closed before reading the whole line
            out = next(termhost.lines(s), None)
        finally:
            s.close()
        return out

    def op(self, **req):
        """One versioned request."""
        return termhost.call(self.rd, req)

    def open(self, sid, argv, **extra):
        """Open a terminal running argv in the temp folder."""
        return self.op(op="open", id=sid, argv=argv, env={"PATH": os.environ.get("PATH", "")}, cwd=self.tmp, **extra)

    def test_bad_lines_and_types_get_an_answer(self):
        v = termhost.PROTOCOL
        good = {"op": "open", "v": v, "id": "x1", "argv": ["/bin/sleep", "30"], "env": {}, "cwd": self.tmp}
        bad = [b"[1, 2]\n", b'"op"\n', b"7\n", b"{nope\n", b"\n", b'{"op": 5, "v": %d}\n' % v, b'{"op": "nosuch", "v": %d}\n' % v]
        for change in ({"argv": "sh"}, {"argv": []}, {"argv": [1]}, {"env": ["A=1"]}, {"env": {"A": 1}}, {"cwd": 5}, {"cols": "wide"},
                       {"rows": [1]}, {"cols": True}, {"max": "6"}, {"id": ""}, {"id": "x" * 500}, {"id": 5}, {"cols": 10 ** 400}):
            bad.append(json.dumps(dict(good, **change)).encode() + b"\n")
        for line in bad:
            out = self.raw(line)
            self.assertIsInstance(out, dict, line)
            self.assertIn("error", out, line)
        self.assertEqual(termhost.HOST.listing(), [])
        self.assertEqual(self.raw(b'{"op": "hello"}\n')["v"], v)

    def test_oversized_line_is_refused(self):
        out = self.raw(b'{"op": "hello", "pad": "' + b"x" * (termhost.MAX_LINE + 10) + b'"}\n')
        self.assertEqual(out, {"error": "bad request"})

    def test_terminal_ops_with_bad_values(self):
        self.assertNotIn("error", self.open("t1", ["/bin/sleep", "30"]))
        self.assertEqual(self.op(id="t1", op="resize", cols=-5, rows=10 ** 6), {"ok": True})  # clamped to the allowed range
        for req in ({"op": "resize", "cols": "x"}, {"op": "resize", "rows": 10 ** 30}, {"op": "input", "data": "%%%"},
                    {"op": "input", "data": 5}, {"op": "stream", "pos": "x"}, {"op": "end", "wait": "soon"}, {"op": "fly"}):
            out = self.op(id="t1", **req)
            self.assertIn("error", out, req)
        self.assertIsNone(termhost.HOST.terms["t1"].code)

    def test_host_cap_holds_whatever_the_server_asks(self):
        with mock.patch.object(termhost, "HARD_MAX", 3):
            for i in range(3):
                self.assertNotIn("error", self.open(f"c{i}", ["/bin/sleep", "30"], max=10 ** 9))
            self.assertIn("already open", self.open("c9", ["/bin/sleep", "30"], max=10 ** 9).get("error", ""))

    def test_cli_inherits_no_other_terminal(self):
        script = os.path.join(self.tmp, "fds.py")
        with open(script, "w") as fh:
            fh.write(FDS)
        self.assertNotIn("error", self.open("a1", ["/bin/sleep", "30"]))
        out = os.path.join(self.tmp, "fds.txt")
        self.assertNotIn("error", self.open("a2", [sys.executable, script, out]))
        self.assertTrue(wait_until(lambda: os.path.exists(out) and open(out).read() != ""))
        time.sleep(0.1)
        self.assertEqual(open(out).read().split(), ["fds:"], "the second CLI holds descriptors of the host or of the first terminal")

    def test_silent_peer_is_dropped(self):
        self.assertTrue(0 < termhost.Handler.timeout <= 30)
        with mock.patch.object(termhost.Handler, "timeout", 0.3):
            s = termhost.connect(self.rd)
            try:
                s.settimeout(5)
                t0 = time.monotonic()
                self.assertEqual(s.recv(10), b"")
                self.assertLess(time.monotonic() - t0, 3)
            finally:
                s.close()

    def test_stale_offset_replays_from_the_start(self):
        self.assertNotIn("error", self.open("s1", ["/bin/sh", "-c", "echo hello-there; sleep 30"]))
        t = termhost.HOST.terms["s1"]
        self.assertTrue(wait_until(lambda: b"hello-there" in t.buf))
        s = termhost.connect(self.rd)
        try:
            termhost.send(s, {"op": "stream", "v": termhost.PROTOCOL, "id": "s1", "pos": 10 ** 12})
            msg = next(termhost.lines(s))
        finally:
            s.close()
        self.assertIn(b"hello-there", base64.b64decode(msg.get("data", "")))

    def test_no_descriptor_leak_over_500_terminals(self):
        def count():
            """Open descriptors of this process, which holds both the host and its clients."""
            return len(os.listdir("/dev/fd"))
        before = count()
        for i in range(500):
            sid = f"f{i % 4}"
            self.assertNotIn("error", self.open(sid, ["/bin/sleep", "30"]), i)
            self.assertIn("term", self.op(op="end", id=sid, wait=2))
            s = termhost.connect(self.rd)
            termhost.send(s, {"op": "stream", "v": termhost.PROTOCOL, "id": sid, "pos": 0})
            self.assertTrue(any("exit" in m for m in termhost.lines(s)))
            s.close()
        self.assertTrue(wait_until(lambda: all(t.fd == -1 for t in termhost.HOST.terms.values())))
        self.assertLessEqual(count() - before, 2)
        self.assertLessEqual(len(termhost.HOST.terms), termhost.KEEP_DONE + 1)

    def test_cli_exit_is_seen_while_its_child_holds_the_terminal(self):
        script, kid_file = os.path.join(self.tmp, "leaver.py"), os.path.join(self.tmp, "kid.pid")
        with open(script, "w") as fh:
            fh.write(LEAVER)
        self.assertNotIn("error", self.open("e1", [sys.executable, script, kid_file]))
        t = termhost.HOST.terms["e1"]
        try:
            self.assertTrue(wait_until(lambda: os.path.exists(kid_file), timeout=10))
            self.assertTrue(wait_until(lambda: t.code is not None, timeout=5), "the CLI exited but the terminal still shows as running")
            self.assertEqual(t.code, 3)
            self.assertEqual(termhost.HOST.live(), [])
            s = termhost.connect(self.rd)
            try:
                termhost.send(s, {"op": "stream", "v": termhost.PROTOCOL, "id": "e1", "pos": 0})
                msgs = list(termhost.lines(s))
            finally:
                s.close()
            self.assertEqual([m for m in msgs if "exit" in m], [{"exit": 3}])
            self.assertIn(b"parent done", b"".join(base64.b64decode(m["data"]) for m in msgs if "data" in m))
            self.assertTrue(wait_until(lambda: t.fd == -1, timeout=termhost.DRAIN + 3), "terminal never closed")
        finally:
            try:
                os.kill(int(open(kid_file).read()), signal.SIGKILL)
            except (OSError, ValueError):
                pass

    def test_missing_peer_check_is_reported(self):
        a, b = socket.socketpair(socket.AF_UNIX)
        try:
            with mock.patch.object(termhost.sys, "platform", "sunos5"):
                self.assertIsNone(termhost.peer_uid(a))
                self.assertTrue(termhost.same_user(a))  # leans on the 0700 folder
                self.assertFalse(termhost.peer_check())
                self.assertFalse(termhost.HOST.hello()["peerCheck"])
        finally:
            a.close()
            b.close()
        self.assertTrue(termhost.HOST.hello()["peerCheck"] or not sys.platform.startswith(("linux", "darwin")))
        rd = os.path.join(self.tmp, "run2")
        code = "import sys; sys.platform = 'sunos5'; from desk import termhost; sys.exit(termhost.main(['--dir', %r]))" % rd
        out = subprocess.run([sys.executable, "-c", code], cwd=ROOT, env=dict(os.environ, DESK_TERMHOST_IDLE="0.5"), capture_output=True, text=True, timeout=30)
        self.assertEqual(out.returncode, 0, out.stderr)
        self.assertEqual(out.stdout.count(termhost.PEER_NOTE), 1)

    def test_peer_check_fails_closed(self):
        a, b = socket.socketpair(socket.AF_UNIX)
        try:
            if sys.platform.startswith(("linux", "darwin")):
                self.assertEqual(termhost.peer_uid(a), os.getuid())  # the check is active on this platform
            with mock.patch.object(termhost, "peer_uid", side_effect=OSError("no creds")):
                self.assertFalse(termhost.same_user(a))
        finally:
            a.close()
            b.close()


class RunFolderTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="desk-rf-")

    def tearDown(self):
        for base, dirs, _ in os.walk(self.tmp):
            for d in dirs:
                os.chmod(os.path.join(base, d), 0o700)
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_open_parent_without_sticky_bit_is_refused(self):
        shared = os.path.join(self.tmp, "shared")
        os.mkdir(shared)
        os.chmod(shared, 0o777)  # anyone could rename the run folder away and put their own in its place
        with self.assertRaises(termhost.HostError):
            termhost.private_dir(os.path.join(shared, ".desk-run-x"))
        os.chmod(shared, 0o1777)  # sticky, as /tmp: others cannot move our folder
        self.assertTrue(os.path.isdir(termhost.private_dir(os.path.join(shared, ".desk-run-y"))))

    def test_symlink_and_loose_folders(self):
        target = os.path.join(self.tmp, "elsewhere")
        os.mkdir(target, 0o700)
        os.symlink(target, os.path.join(self.tmp, "link"))
        with self.assertRaises(termhost.HostError):
            termhost.private_dir(os.path.join(self.tmp, "link"))
        loose = os.path.join(self.tmp, "loose")
        os.mkdir(loose)
        os.chmod(loose, 0o755)
        termhost.private_dir(loose)
        self.assertEqual(stat.S_IMODE(os.stat(loose).st_mode), 0o700)

    def test_pre_created_socket_folder_is_not_trusted(self):
        long_rd = termhost.private_dir(os.path.join(self.tmp, "r" * 120))
        with mock.patch.object(termhost.tempfile, "gettempdir", return_value=self.tmp), mock.patch.dict(os.environ, {"XDG_RUNTIME_DIR": ""}):
            path = termhost.sock_path(long_rd, create=True)
            self.assertTrue(path.startswith(self.tmp))
            os.chmod(os.path.dirname(path), 0o755)
            with self.assertRaises(termhost.HostError):
                termhost.connect(long_rd)
            self.assertNotEqual(termhost.sock_path(long_rd, create=True), path)  # a loosened folder is never reused

    def test_fallback_socket_folder_cannot_be_taken_in_advance(self):
        long_rd = termhost.private_dir(os.path.join(self.tmp, "r" * 120))
        old_name = f"desk-{os.getuid()}-{hashlib.sha1(long_rd.encode()).hexdigest()[:10]}"  # the name another user could guess before
        with open(os.path.join(self.tmp, old_name), "w") as fh:
            fh.write("squatter")
        with mock.patch.object(termhost.tempfile, "gettempdir", return_value=self.tmp), mock.patch.dict(os.environ, {"XDG_RUNTIME_DIR": ""}):
            path = termhost.sock_path(long_rd, create=True)
            folder = os.path.dirname(path)
            self.assertEqual(os.path.dirname(folder), self.tmp)
            self.assertNotEqual(os.path.basename(folder), old_name)
            self.assertEqual(stat.S_IMODE(os.stat(folder).st_mode), 0o700)
            with open(os.path.join(long_rd, termhost.SOCKDIR)) as fh:
                self.assertEqual(fh.read(), folder)  # recorded inside the private run folder
            self.assertEqual(termhost.sock_path(long_rd), path)
            self.assertEqual(termhost.sock_path(long_rd, create=True), path)  # a host that died left it: reused
            termhost.drop_sock(long_rd, path)
            self.assertFalse(os.path.exists(folder))
            self.assertFalse(os.path.exists(os.path.join(long_rd, termhost.SOCKDIR)))

    def test_read_only_checks_create_nothing(self):
        long_rd = os.path.join(self.tmp, "r" * 120)
        before = sorted(os.listdir(self.tmp))
        with mock.patch.object(termhost.tempfile, "gettempdir", return_value=self.tmp), mock.patch.dict(os.environ, {"XDG_RUNTIME_DIR": ""}):
            self.assertIsNone(termhost.sock_path(long_rd))
            with self.assertRaises(termhost.HostError) as e:
                termhost.connect(long_rd)
            self.assertIn("not running", str(e.exception))
        self.assertEqual(sorted(os.listdir(self.tmp)), before)


if __name__ == "__main__":
    unittest.main()

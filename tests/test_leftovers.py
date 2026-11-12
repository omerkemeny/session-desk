"""Run-folder leftovers: dead short socket folders are swept at host start; opening a terminal and replacing an older host exclude each other across servers."""
import fcntl
import os
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock

from helpers import ROOT, FakeHome, wait_until
from desk import config, termhost, terms

SID = "abcdef12-0000-4000-8000-000000000002"


def dead_socket(folder, age=60):
    """A private short socket folder holding a socket nobody serves, made `age` seconds ago."""
    os.makedirs(folder, mode=0o700)
    path = os.path.join(folder, termhost.SOCK)
    s = socket.socket(socket.AF_UNIX)
    s.bind(path)
    s.close()
    old = time.time() - age
    os.utime(path, (old, old))
    return path


class SweepTest(unittest.TestCase):
    def setUp(self):
        self.base = tempfile.mkdtemp(prefix="dsw-", dir="/tmp")
        self.pre = os.path.join(self.base, f"desk-{os.getuid()}-")

    def tearDown(self):
        shutil.rmtree(self.base, ignore_errors=True)

    def test_only_old_dead_private_folders_go(self):
        dead_socket(self.pre + "dead")
        dead_socket(self.pre + "young", age=0)
        live = socket.socket(socket.AF_UNIX)
        os.makedirs(self.pre + "live", mode=0o700)
        live.bind(os.path.join(self.pre + "live", termhost.SOCK))
        live.listen(1)
        old = time.time() - 60
        os.utime(os.path.join(self.pre + "live", termhost.SOCK), (old, old))
        dead_socket(self.pre + "more")
        open(os.path.join(self.pre + "more", "other"), "w").close()
        dead_socket(os.path.join(self.base, "desk-0-other"))
        os.makedirs(self.pre + "empty", mode=0o700)
        os.utime(self.pre + "empty", (old, old))
        try:
            self.assertEqual(termhost.sweep(self.base), 2)
        finally:
            live.close()
        self.assertEqual(sorted(os.listdir(self.base)), sorted(["desk-0-other"] + [os.path.basename(self.pre) + n for n in ("young", "live", "more")]))

    def test_host_start_sweeps_a_killed_hosts_folder(self):
        tmp = tempfile.mkdtemp(prefix="desk-sw-", dir="/tmp")
        rd = os.path.join(tmp, "r" * 120)  # too long for a socket path: the socket lives in a short folder
        env = dict(os.environ, TMPDIR=self.base, XDG_RUNTIME_DIR=self.base)
        procs = []

        def host():
            """Start a host and wait until it answers."""
            p = subprocess.Popen([sys.executable, "-m", "desk.termhost", "--dir", rd], cwd=ROOT, env=env, stdout=subprocess.DEVNULL,
                                 stderr=subprocess.DEVNULL, start_new_session=True)
            procs.append(p)
            self.assertTrue(wait_until(lambda: os.path.exists(os.path.join(rd, termhost.SOCKDIR)) and termhost.sock_path(rd)
                                       and termhost.served(termhost.sock_path(rd)), timeout=15))
            return p
        try:
            a = host()
            first = os.path.dirname(termhost.sock_path(rd))
            a.send_signal(signal.SIGKILL)
            a.wait(5)
            other = self.pre + "otherhost"
            dead_socket(other)  # another run folder's killed host
            old = time.time() - 60
            os.utime(termhost.sock_path(rd), (old, old))
            b = host()
            self.assertFalse(os.path.exists(other), "a dead socket folder of a killed host stayed")
            self.assertTrue(termhost.served(termhost.sock_path(rd)))
            self.assertEqual([n for n in os.listdir(self.base) if n.startswith(os.path.basename(self.pre))], [os.path.basename(os.path.dirname(termhost.sock_path(rd)))])
            self.assertNotEqual(first, None)
            termhost.call(rd, {"op": "stop"}, version=False)
            b.wait(10)
            self.assertEqual([n for n in os.listdir(self.base) if n.startswith(os.path.basename(self.pre))], [])
        finally:
            for p in procs:
                if p.poll() is None:
                    p.kill()
                    p.wait(5)
            shutil.rmtree(tmp, ignore_errors=True)


class OpenLockTest(unittest.TestCase):
    def setUp(self):
        self.home = FakeHome()
        self.cwd = tempfile.mkdtemp(prefix="desk-cwd-")
        self.patches = [mock.patch.object(terms, "hosted", return_value=True), mock.patch.object(terms.transcripts, "find", return_value="/x.jsonl"),
                        mock.patch("desk.sessions.parse", return_value={"cwd": self.cwd})]
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in self.patches:
            p.stop()
        shutil.rmtree(self.cwd, ignore_errors=True)
        self.home.close()

    def taken(self):
        """True while another descriptor cannot lock the run folder's open lock."""
        fd = os.open(os.path.join(config.run_dir(), terms.OPEN_LOCK), os.O_RDWR | os.O_CREAT, 0o600)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return False
        except OSError:
            return True
        finally:
            os.close(fd)

    def test_check_replace_and_open_run_under_the_lock(self):
        seen = []
        info = {"id": SID, "pid": 1, "t0": 1, "code": None}
        with mock.patch.object(terms, "attach", side_effect=lambda spawn=False: seen.append(("attach", self.taken())) or None), \
                mock.patch.object(terms.termhost, "call", side_effect=lambda rd, req, *a, **k: seen.append((req["op"], self.taken())) or {"term": info, "gen": 1}):
            self.assertEqual(terms.open_term(SID, 80, 24), (None, False))
        self.assertEqual(seen, [("attach", True), ("open", True)])
        self.assertFalse(self.taken())

    def test_open_waits_for_another_server_then_gives_up(self):
        fd = os.open(os.path.join(termhost.private_dir(config.run_dir()), terms.OPEN_LOCK), os.O_RDWR | os.O_CREAT, 0o600)
        fcntl.flock(fd, fcntl.LOCK_EX)
        try:
            with mock.patch.object(terms, "OPEN_WAIT", 0.2), mock.patch.object(terms, "attach") as att:
                t = time.monotonic()
                err, _ = terms._open_term(SID, 80, 24, False)
                self.assertIn("another server", err)
                self.assertTrue(0.15 <= time.monotonic() - t < 5)
                att.assert_not_called()
        finally:
            os.close(fd)


if __name__ == "__main__":
    unittest.main()
